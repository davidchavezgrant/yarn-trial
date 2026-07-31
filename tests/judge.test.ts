import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildJudgePrompt,
	buildRubric,
	judgeReportPath,
	parseJudgeVerdict,
	resolveRunLog,
	sampleFrames,
	trustedFrames,
} from "../src/core/judge.js";
import type { AppMap } from "../src/types.js";

/**
 * The judge reads run logs and screenshots off disk, builds a prompt, and parses a verdict —
 * all of it testable without a model call. Filesystem-facing functions honour YARN_RUNNER_DATA
 * (re-read per call by src/paths.ts), so each test that touches disk points the data root at a
 * throwaway temp dir and restores the env after itself.
 */

/** Run `fn` with the data root pointed at a fresh temp dir; restore and delete afterwards. */
function inTempData(fn: (dir: string) => void): void {
	const prev = process.env.YARN_RUNNER_DATA;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-test-"));
	try {
		process.env.YARN_RUNNER_DATA = dir;
		fn(dir);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
		else process.env.YARN_RUNNER_DATA = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** A minimal but shape-faithful StepRecord. Distinctive strings so prompt assertions cannot
 *  accidentally match boilerplate. */
function makeStep(overrides: Record<string, unknown> = {}): any {
	return {
		index: 1,
		timestamp: "2026-07-31T00:00:00.000Z",
		action: { kind: "tool", name: "click_element", args: {} },
		expectation: { description: "the font picker popup lists Cereal as selected", textIncludes: ["Cereal"] },
		verified: true,
		verificationNote: 'matched substring "Cereal" in the font combobox value',
		...overrides,
	};
}

function makeRunLog(overrides: Record<string, unknown> = {}): any {
	return {
		app: "Yarn",
		task: "switch the caption font to Cereal for the whole brand",
		summary: "Set the brand-wide caption font to Cereal via Brand Kit",
		success: true,
		grounding: { provenance: "none" },
		steps: [makeStep()],
		...overrides,
	};
}

/** Write `<dataDir>/out/runs/<name>.json` and return its absolute path. */
function writeRunFixture(dataDir: string, name: string, log: any): string {
	const runs = path.join(dataDir, "out", "runs");
	fs.mkdirSync(runs, { recursive: true });
	const p = path.join(runs, `${name}.json`);
	fs.writeFileSync(p, JSON.stringify(log, null, 2));

	return p;
}

/** Create the per-run step screenshots trustedFrames checks for on disk. Empty files suffice. */
function writeStepShots(dataDir: string, stepsDir: string, names: string[]): void {
	const dir = path.join(dataDir, "out", stepsDir);
	fs.mkdirSync(dir, { recursive: true });
	for (const n of names) fs.writeFileSync(path.join(dir, n), "");
}

/**
 * A dual-scope appmap graph shaped like the real `docs/appmaps/yarn.json` envelope
 * (app/capturedAt/provenance/proseSha256 wrapper around nodes+edges — the fields
 * loadAppMapGraph parses; coverage etc. are optional and omitted). "cursor-style" is
 * editable at brand AND document scope — the wrong-scope trap the rubric exists to name —
 * and both controls sit under surfaces reachable by edges so routeTo has a walk to do.
 */
function writeAppmapFixture(dataDir: string, slug: string): void {
	const map: AppMap = {
		app: "Yarn",
		capturedAt: "2026-07-30T12:00:00.000Z",
		provenance: "explore",
		proseSha256: "deadbeef0000",
		nodes: [
			{ id: "brand-kit/screen-clips", title: "Screen Clip Settings", kind: "surface", scope: "brand" },
			{ id: "editor", title: "Editor", kind: "surface", scope: "document" },
			{ id: "editor/screen-clip-settings", title: "Screen Clip Settings (per-draft)", kind: "surface", scope: "document" },
			{ id: "brand-kit/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "brand", settingKey: "cursor-style" },
			{ id: "editor/screen-clip-settings/cursor-style", title: "Cursor Style", kind: "control", scope: "document", settingKey: "cursor-style" },
		],
		edges: [
			{ from: "root", to: "brand-kit/screen-clips", action: 'click "Brand Kit"' },
			{ from: "root", to: "editor", action: "double-click a draft row" },
			{ from: "editor", to: "editor/screen-clip-settings", action: 'open "Screen Clip Settings…" from Project actions' },
		],
	};
	const dir = path.join(dataDir, "docs", "appmaps");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(map, null, 2));
}

// --- resolveRunLog(). Stamps are typed by hand off a console line, so the resolver takes a
// prefix; artifacts that share the stamp (.judge.json verdicts, .journal.jsonl) must never
// shadow the log itself.

test("resolveRunLog__FindsLog__When__BareStampPrefixGiven", () => {
	inTempData((dir) => {
		const log = makeRunLog();
		const written = writeRunFixture(dir, "2026-07-29T18-58-28-yarn", log);
		const { logPath, log: loaded } = resolveRunLog("2026-07-29T18-58-28");
		assert.equal(logPath, written);
		assert.deepEqual(loaded, log);
	});
});

test("resolveRunLog__Throws__When__PrefixMatchesNothing", () => {
	inTempData((dir) => {
		writeRunFixture(dir, "2026-07-29T18-58-28-yarn", makeRunLog());
		assert.throws(() => resolveRunLog("2026-07-30T09-00-00"));
	});
});

test("resolveRunLog__Throws__When__PrefixIsAmbiguous", () => {
	inTempData((dir) => {
		writeRunFixture(dir, "2026-07-29T18-58-28-yarn", makeRunLog());
		writeRunFixture(dir, "2026-07-29T18-59-01-yarn", makeRunLog());
		assert.throws(() => resolveRunLog("2026-07-29T18"));
	});
});

test("resolveRunLog__IgnoresJudgeArtifacts__When__PreviousVerdictExists", () => {
	inTempData((dir) => {
		const log = makeRunLog();
		const written = writeRunFixture(dir, "2026-07-30T10-00-00-yarn", log);
		// A prior judge pass and the mutation journal sit right beside the log, sharing its
		// stamp. Neither may match — a second judging must not be ambiguous, and must never
		// read a previous verdict as the run.
		fs.writeFileSync(path.join(dir, "out", "runs", "2026-07-30T10-00-00-yarn.judge.json"), JSON.stringify({ trajectory: "PASS" }));
		fs.writeFileSync(path.join(dir, "out", "runs", "2026-07-30T10-00-00-yarn.journal.jsonl"), "{}\n");
		const { logPath, log: loaded } = resolveRunLog("2026-07-30T10-00-00");
		assert.equal(logPath, written);
		assert.equal(logPath.includes(".judge."), false);
		assert.deepEqual(loaded, log);
	});
});

// --- trustedFrames(). Older runs wrote every step's screenshot to shared out/agent-step-N.png
// names, which any later run overwrites — pixels from the wrong run, presented as this run's
// evidence. Only per-run "-steps/" paths are trusted, and only when the file is really there.

test("trustedFrames__MarksStale__When__ScreenshotPathsAreShared", () => {
	inTempData(() => {
		const log = makeRunLog({
			steps: [
				makeStep({ index: 1, screenshotFile: "agent-step-1.png" }),
				makeStep({ index: 2, screenshotFile: "agent-step-2.png" }),
			],
		});
		const { frames, stale } = trustedFrames(log);
		assert.deepEqual(frames, []);
		assert.equal(stale, true);
	});
});

test("trustedFrames__ReturnsFrames__When__PerRunStepsDirExists", () => {
	inTempData((dir) => {
		const stepsDir = "runs/2026-07-31T05-45-03-yarn-steps";
		writeStepShots(dir, stepsDir, ["agent-step-1.png", "agent-step-2.png"]);
		const log = makeRunLog({
			steps: [
				makeStep({ index: 1, screenshotFile: `${stepsDir}/agent-step-1.png` }),
				makeStep({ index: 2, screenshotFile: `${stepsDir}/agent-step-2.png` }),
			],
		});
		const { frames, stale } = trustedFrames(log);
		assert.equal(stale, false);
		assert.equal(frames.length, 2);
		assert.deepEqual(frames.map((f: { step: number; path: string }) => f.step), [1, 2]);
		for (const f of frames) {
			assert.equal(path.isAbsolute(f.path), true, `expected absolute path, got ${f.path}`);
			assert.equal(fs.existsSync(f.path), true);
		}
		assert.equal(frames[0].path, path.join(dir, "out", stepsDir, "agent-step-1.png"));
	});
});

test("trustedFrames__DropsFrame__When__FileMissingOnDisk", () => {
	inTempData((dir) => {
		const stepsDir = "runs/2026-07-31T06-00-00-yarn-steps";
		writeStepShots(dir, stepsDir, ["agent-step-1.png"]); // step 2's file deliberately absent
		const log = makeRunLog({
			steps: [
				makeStep({ index: 1, screenshotFile: `${stepsDir}/agent-step-1.png` }),
				makeStep({ index: 2, screenshotFile: `${stepsDir}/agent-step-2.png` }),
			],
		});
		const { frames, stale } = trustedFrames(log);
		assert.deepEqual(frames.map((f: { step: number; path: string }) => f.step), [1]);
		assert.equal(stale, false, "one trustworthy frame exists, so the run is not stale");
	});
});

test("trustedFrames__ReportsNotStale__When__LogHasNoScreenshots", () => {
	inTempData(() => {
		const log = makeRunLog({
			steps: [makeStep({ index: 1 }), makeStep({ index: 2 })], // no screenshotFile at all
		});
		const { frames, stale } = trustedFrames(log);
		assert.deepEqual(frames, []);
		assert.equal(stale, false, "no screenshots is a vision-off run, not a stale one");
	});
});

// --- sampleFrames(). A long run has more frames than a judge call should carry; sampling must
// never lose the endpoints (the before and the after ARE the verdict) or reorder anything.

test("sampleFrames__ReturnsIdentity__When__UnderCap", () => {
	const five = [10, 20, 30, 40, 50];
	assert.deepEqual(sampleFrames(five, 12), five);
	// Exactly at the cap is still identity.
	assert.deepEqual(sampleFrames(five, 5), five);
});

test("sampleFrames__KeepsFirstAndLast__When__OverCap", () => {
	const thirty = Array.from({ length: 30 }, (_, i) => i);
	const sampled = sampleFrames(thirty, 12);
	assert.equal(sampled.length, 12);
	assert.equal(sampled[0], 0);
	assert.equal(sampled[sampled.length - 1], 29);
	for (let i = 1; i < sampled.length; i++) {
		assert.ok(sampled[i] > sampled[i - 1], `order must be preserved: ${sampled[i - 1]} before ${sampled[i]}`);
	}
	// Deterministic: two calls on the same input agree.
	assert.deepEqual(sampleFrames(thirty, 12), sampled);
});

// --- buildRubric(). The graph's scope ambiguities become the judge's rubric — the wrong-scope
// failure both text verification and a claim-blind judge waved through.

test("buildRubric__ReturnsEmpty__When__NoGraphExists", () => {
	inTempData(() => {
		assert.equal(buildRubric("yarn"), "");
	});
});

test("buildRubric__NamesBothScopes__When__SettingIsDualScope", () => {
	inTempData((dir) => {
		writeAppmapFixture(dir, "yarn");
		const rubric = buildRubric("yarn");
		assert.notEqual(rubric, "");
		assert.match(rubric, /cursor-style/);
		assert.match(rubric, /brand/);
		assert.match(rubric, /document/);
	});
});

// --- buildJudgePrompt(). Pure assembly; the trajectory strings are another model's output and
// the prompt must say so — an injection-shaped verificationNote must read as data, not orders.

test("buildJudgePrompt__IncludesClaimAndSteps__When__SummaryPresent", () => {
	const log = makeRunLog({
		steps: [
			makeStep({
				index: 7,
				expectation: { description: "the font picker popup lists Cereal as selected", textIncludes: ["Cereal"] },
				verificationNote: 'matched substring "Cereal" in the font combobox value',
			}),
			makeStep({
				index: 12,
				expectation: { description: "the Brand Kit panel shows caption font Cereal", textIncludes: ["Cereal"] },
				verificationNote: 'combobox "Caption font" reads Cereal after commit',
			}),
		],
	});
	const prompt = buildJudgePrompt(log, "", false);
	// The task and the agent's claim.
	assert.match(prompt, /switch the caption font to Cereal for the whole brand/);
	assert.match(prompt, /Set the brand-wide caption font to Cereal via Brand Kit/);
	// Each step: index, expectation description, verification note.
	assert.match(prompt, /\b7\b/);
	assert.match(prompt, /\b12\b/);
	assert.match(prompt, /the font picker popup lists Cereal as selected/);
	assert.match(prompt, /matched substring "Cereal" in the font combobox value/);
	assert.match(prompt, /the Brand Kit panel shows caption font Cereal/);
	assert.match(prompt, /combobox "Caption font" reads Cereal after commit/);
	// Steps appear in order.
	assert.ok(
		prompt.indexOf("the font picker popup lists Cereal as selected") <
			prompt.indexOf("the Brand Kit panel shows caption font Cereal"),
		"step 7 must precede step 12 in the prompt",
	);
	// The data/instructions boundary statement. Loose on wording, firm on presence.
	assert.match(prompt, /instructions?/i);
	assert.match(prompt, /data/i);
});

test("buildJudgePrompt__IncludesRubric__When__RubricNonEmpty", () => {
	const rubric = "JUDGE-RUBRIC-MARKER: cursor-style exists at brand AND document scopes — separate stores";
	const log = makeRunLog();
	assert.match(buildJudgePrompt(log, rubric, true), /JUDGE-RUBRIC-MARKER: cursor-style exists at brand AND document scopes/);
	assert.equal(buildJudgePrompt(log, "", true).includes("JUDGE-RUBRIC-MARKER"), false);
});

// --- parseJudgeVerdict(). The verdict comes back as labelled lines; anything without a
// TRAJECTORY line is not a verdict at all.

test("parseJudgeVerdict__ParsesAllFields__When__WellFormed", () => {
	const text = [
		"TRAJECTORY: FAIL",
		"VISUAL: UNPROVEN",
		"SCOPE: document (per-draft Screen Clip Settings)",
		"CITATION: step 3: opened a draft, brand route never does",
		'CITATION: run-level: commit affordance was "Done"',
		"WHY: the agent claimed a brand-wide change but every step operated inside a draft",
	].join("\n");
	const v = parseJudgeVerdict(text);
	assert.ok(v, "well-formed verdict must parse");
	assert.equal(v.trajectory, "FAIL");
	assert.equal(v.visual, "UNPROVEN");
	assert.match(v.scope, /document/);
	assert.match(v.scope, /per-draft Screen Clip Settings/);
	assert.equal(v.citations.length, 2);
	const stepped = v.citations.find((c: { step?: number; note: string }) => c.step !== undefined);
	assert.ok(stepped, 'the "step 3:" citation must carry its step number');
	assert.equal(stepped.step, 3);
	assert.match(stepped.note, /opened a draft/);
	const runLevel = v.citations.find((c: { step?: number; note: string }) => c.step === undefined);
	assert.ok(runLevel, "the run-level citation must parse with step undefined");
	assert.match(runLevel.note, /commit affordance/);
});

test("parseJudgeVerdict__ReturnsUndefined__When__TrajectoryLineMissing", () => {
	const text = ["SCOPE: brand (Brand Kit)", "WHY: everything checked out"].join("\n");
	assert.equal(parseJudgeVerdict(text), undefined);
});

test("parseJudgeVerdict__OmitsVisual__When__VisualLineAbsent", () => {
	const text = ["TRAJECTORY: PASS", "SCOPE: brand (Brand Kit → Screen Clips)", "WHY: steps and claim agree"].join("\n");
	const v = parseJudgeVerdict(text);
	assert.ok(v);
	assert.equal(v.trajectory, "PASS");
	assert.equal(v.visual, undefined);
});

test("parseJudgeVerdict__NormalisesVerdict__When__VerdictWordIsLowercase", () => {
	const v = parseJudgeVerdict("TRAJECTORY: fail\nSCOPE: brand\nWHY: lowercase model");
	assert.ok(v);
	assert.equal(v.trajectory, "FAIL");
});

// --- judgeReportPath(). Verdicts live beside the log they judge, and the .judge.json suffix
// is what resolveRunLog excludes — the two must stay in agreement.

test("judgeReportPath__AppendsJudgeSuffix__When__GivenLogPath", () => {
	assert.equal(
		judgeReportPath("/data/out/runs/2026-07-29T18-58-28-yarn.json"),
		"/data/out/runs/2026-07-29T18-58-28-yarn.judge.json",
	);
});
