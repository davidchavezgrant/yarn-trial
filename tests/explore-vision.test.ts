import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appmapVariant, isVagueSurface, loadAppMapGraph } from "../src/core/harness.js";
import {
	declaredCredit,
	declaredDismiss,
	declaredIngest,
	declaredKey,
	declaredMatches,
	declaredRemaining,
	declaredSummary,
	newDeclaredLedger,
} from "../src/core/harness/declared-frontier.js";
import { loadGrounding } from "../src/core/agent/grounding.js";
import { coverageNow, provenanceHeader, writeArtifacts } from "../src/core/explore/artifacts.js";
import { parseCli, noAxRefusal } from "../src/core/explore/cli.js";
import { SURVEY_TOOL, systemPrompt, VISION_ACT_TOOL } from "../src/core/explore/prompt.js";
import { newPass } from "../src/core/explore/state.js";

/**
 * The vision-only exploration variant: the DECLARED frontier (coverage from the model's own
 * survey/target declarations, because the mechanical frontier's summary would leak the AX
 * element list to a model meant to see only pixels), the `.vision.*` artifact pair that must
 * never overwrite the element-grounded map, and the APPMAP_VARIANT consumption switch.
 */

function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const prev = process.env[name];
	try {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

function inTempRoot(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explore-vision-"));
	try {
		withEnv("YARN_RUNNER_DATA", dir, () => fn(dir));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── declared ledger ──────────────────────────────────────────────────────────────────────

test("declaredIngest__AddsControls__When__SurveyDeclaresThem", () => {
	const ledger = newDeclaredLedger();
	const added = declaredIngest(ledger, "Brand Kit", [{ name: "Cursor style" }, { name: "Save", note: "commits" }]);
	assert.equal(added, 2);
	assert.deepEqual(declaredRemaining(ledger).map((e) => e.name), ["Cursor style", "Save"]);
});

test("declaredIngest__IsIdempotent__When__TheSameSurveyRepeats", () => {
	// The model re-declares freely rather than remembering what it already sent; a repeat must
	// refresh, not duplicate — and the note from the later sighting wins.
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Brand Kit", [{ name: "Save" }]);
	const added = declaredIngest(ledger, "Brand Kit", [{ name: "Save", note: "now with a note" }]);
	assert.equal(added, 0);
	assert.equal(ledger.seen.size, 1);
	assert.equal(declaredRemaining(ledger)[0].note, "now with a note");
});

test("declaredIngest__DropsTheEntry__When__ItHasNoName", () => {
	// An unnamed declaration could never be credited or dismissed — it would sit on the
	// frontier forever, unclearable.
	const ledger = newDeclaredLedger();
	const added = declaredIngest(ledger, "Rail", [{ name: "" }, { name: "   " }, {} as { name?: string }, { name: "Real" }]);
	assert.equal(added, 1);
	assert.deepEqual(declaredRemaining(ledger).map((e) => e.name), ["Real"]);
});

test("declaredIngest__CollapsesToTopLevel__When__SurfaceIsAPlaceholderSpelling", () => {
	// Surface strings round-trip through the model's context; every spelling of "no panel"
	// must be ONE group, or the summary fragments and dismiss-by-surface stops matching.
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "<top level>", [{ name: "Search" }]);
	declaredIngest(ledger, "top level", [{ name: "Search" }]);
	declaredIngest(ledger, "", [{ name: "Search" }]);
	assert.equal(ledger.seen.size, 1);
	assert.equal(declaredRemaining(ledger)[0].surface, "");
});

test("declaredCredit__RemovesFromFrontier__When__ActNamesASurveyedControl", () => {
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Toolbar", [{ name: "Save" }, { name: "Cancel" }]);
	const { key, surveyed } = declaredCredit(ledger, { name: "Save", surface: "Toolbar" });
	assert.equal(surveyed, true);
	assert.equal(key, declaredKey("Save", "Toolbar"));
	assert.deepEqual(declaredRemaining(ledger).map((e) => e.name), ["Cancel"]);
});

test("declaredCredit__IngestsAndCredits__When__TargetWasNeverSurveyed", () => {
	// Acting on a control is also seeing it: under-declaring cannot hide an OPERATED control
	// from the map, only an unoperated one.
	const ledger = newDeclaredLedger();
	const { surveyed } = declaredCredit(ledger, { name: "Settings", surface: "" });
	assert.equal(surveyed, false);
	assert.equal(ledger.seen.size, 1);
	assert.equal(ledger.operated.size, 1);
	assert.equal(declaredRemaining(ledger).length, 0);
});

test("declaredCredit__MatchesCaseInsensitively__When__TheTargetSpellingDiffers", () => {
	// name|surface keys are normalised the way dismissal matching already is — the strings
	// round-trip through the model twice (survey, then target).
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Brand Kit", [{ name: "Cursor Style" }]);
	declaredCredit(ledger, { name: "cursor style", surface: "brand kit" });
	assert.equal(declaredRemaining(ledger).length, 0);
});

test("declaredDismiss__ClearsBySurface__When__NoNamesGiven", () => {
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Transcript", [{ name: "Row 1" }, { name: "Row 2" }]);
	declaredIngest(ledger, "Toolbar", [{ name: "Save" }]);
	const gone = declaredDismiss(ledger, { surface: "Transcript", reason: "content, not navigation" });
	assert.equal(gone.length, 2);
	assert.deepEqual(declaredRemaining(ledger).map((e) => e.name), ["Save"]);
});

test("declaredDismiss__ClearsTopLevel__When__SurfaceIsThePrintedPlaceholder", () => {
	for (const spelling of ["<top level>", "top level", "&lt;top level&gt;", ""]) {
		const ledger = newDeclaredLedger();
		declaredIngest(ledger, "", [{ name: "Search" }]);
		declaredIngest(ledger, "Toolbar", [{ name: "Save" }]);
		assert.equal(declaredDismiss(ledger, { surface: spelling, reason: "r" }).length, 1, spelling);
	}
});

test("declaredMatches__LeavesTheFrontierIntact__When__SizingASweep", () => {
	// The dismissal cap sizes a sweep BEFORE committing to it — sizing must not itself dismiss,
	// or a refused sweep would still have cleared the list. Same contract as frontierMatches.
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Transcript", [{ name: "Row 1" }, { name: "Row 2" }]);
	assert.equal(declaredMatches(ledger, { surface: "Transcript" }).length, 2);
	assert.equal(declaredRemaining(ledger).length, 2);
});

test("declaredMatches__SizesTheSweepForTheCap__When__AVagueSurfaceWouldClearEverything", () => {
	// The loop's DISMISS_CAP check is `matches.length > cap && isVagueSurface(surface)`; this
	// pins the declared half of it — a top-level sweep across many declared controls sizes to
	// all of them, exactly what the cap exists to refuse, while a named panel sizes to itself.
	const ledger = newDeclaredLedger();
	for (let i = 0; i < 25; i++) declaredIngest(ledger, "", [{ name: `Control ${i}` }]);
	declaredIngest(ledger, "Transcript", [{ name: "Row 1" }, { name: "Row 2" }]);
	assert.equal(declaredMatches(ledger, { surface: "<top level>" }).length, 25);
	assert.equal(isVagueSurface("<top level>"), true);
	assert.equal(declaredMatches(ledger, { surface: "Transcript" }).length, 2);
	assert.equal(isVagueSurface("Transcript"), false);
});

test("declaredMatches__Throws__When__NeitherNamesNorSurfaceGiven", () => {
	// An argument-less dismiss would silently clear the entire frontier and end the run.
	assert.throws(() => declaredMatches(newDeclaredLedger(), {}), /needs names, a surface, or both/);
});

test("declaredRemaining__ExcludesDismissed__When__SeenAgainAfterDismissal", () => {
	// Re-surveying a screen must not resurrect a dismissal, or a control on a surface surveyed
	// twice can never be got rid of.
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Transcript", [{ name: "Row 1" }]);
	declaredDismiss(ledger, { names: ["Row 1"], reason: "content" });
	declaredIngest(ledger, "Transcript", [{ name: "Row 1" }]);
	assert.equal(declaredRemaining(ledger).length, 0);
});

test("declaredSummary__SaysNothingSurveyed__When__TheLedgerIsEmpty", () => {
	// An empty declared ledger is zero coverage, not full coverage — the summary must demand a
	// survey rather than read as "frontier empty, call finish".
	assert.match(declaredSummary(newDeclaredLedger()), /Nothing has been surveyed yet/);
});

test("declaredSummary__GroupsBySurface__When__ControlsRemain", () => {
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Brand Kit", [{ name: "Cursor style" }, { name: "Background" }]);
	declaredIngest(ledger, "", [{ name: "Search" }]);
	const s = declaredSummary(ledger);
	assert.match(s, /"Cursor style"/);
	assert.match(s, /in "Brand Kit" \(2\)/);
	assert.match(s, /<top level>/);
});

test("declaredSummary__SaysEmpty__When__EverythingIsOperatedOrDismissed", () => {
	const ledger = newDeclaredLedger();
	declaredIngest(ledger, "Toolbar", [{ name: "Save" }]);
	declaredCredit(ledger, { name: "Save", surface: "Toolbar" });
	assert.match(declaredSummary(ledger), /declared frontier is empty/);
});

// ── artifacts: naming and provenance ─────────────────────────────────────────────────────

test("newPass__WritesTheVisionPair__When__PassIsVisionOnly", () => {
	inTempRoot(() => {
		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, true);
		// Backend AND tier are both in the name now: every Yarn explore used to write
		// yarn.json and the last to finish won (ax 156 nodes, cdp 196, no-vision 180).
		assert.match(p.outPath, /\/yarn\.ax\.vision\.md$/);
		assert.match(p.graphPath, /\/yarn\.ax\.vision\.json$/);

		// The element-grounded pass on the same backend must NOT collide with it, which is
		// the pair the old naming got wrong twice.
		const grounded = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, false);
		assert.match(grounded.outPath, /\/yarn\.ax\.md$/);
		assert.notEqual(grounded.outPath, p.outPath);

		// And the element-ONLY pass differs from both — same backend, different perception.
		const noVision = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", false, undefined, false);
		assert.match(noVision.outPath, /\/yarn\.ax\.novision\.md$/);
		assert.notEqual(noVision.outPath, grounded.outPath);
	});
});

test("newPass__WritesThePlainPair__When__PassIsElementGrounded", () => {
	inTempRoot(() => {
		// `yarn.ax`, not `yarn`: the backend is part of the name because a map is not
		// backend-portable — ax and cdp name the same surface `editor` and `draft-editor`,
		// and a grounded run resolves controls by name.
		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined);
		assert.match(p.outPath, /\/yarn\.ax\.md$/);
		assert.match(p.graphPath, /\/yarn\.ax\.json$/);

		// The other backend gets its own pair rather than overwriting this one.
		const cdp = newPass({ kind: "app", name: "Yarn" }, "Yarn", "cdp", true, undefined);
		assert.match(cdp.outPath, /\/yarn\.cdp\.md$/);
		assert.notEqual(cdp.outPath, p.outPath);
	});
});

test("provenanceHeader__StampsExploreVision__When__PassIsVisionOnly", () => {
	const header = provenanceHeader({
		app: "Yarn",
		actions: 3,
		elapsed: "5m",
		findings: 2,
		backend: "ax",
		findCalls: 0,
		vision: true,
		visionOnly: true,
		stopped: "frontier-empty",
		seen: 4,
		actuated: 3,
		dismissed: 1,
		surfaces: 2,
		chapters: 1,
	});
	assert.match(header, /^<!-- provenance: explore-vision \|/);
	assert.match(header, /controls \(DECLARED\): 3 actuated/);
	// The variant's known weakness must be stated where the numbers are.
	assert.match(header, /DECLARED — self-reported/);
});

test("provenanceHeader__StampsExplore__When__PassIsElementGrounded", () => {
	const header = provenanceHeader({
		app: "Yarn",
		actions: 3,
		elapsed: "5m",
		findings: 2,
		backend: "ax",
		findCalls: 0,
		vision: true,
		stopped: "frontier-empty",
		seen: 4,
		actuated: 3,
		dismissed: 1,
		surfaces: 2,
		chapters: 1,
	});
	assert.match(header, /^<!-- provenance: explore \|/);
	assert.match(header, /controls: 3 actuated/);
});

test("coverageNow__CountsTheDeclaredLedger__When__PassIsVisionOnly", () => {
	inTempRoot(() => {
		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, true);
		declaredIngest(p.declared, "Toolbar", [{ name: "Save" }, { name: "Cancel" }]);
		declaredCredit(p.declared, { name: "Save", surface: "Toolbar" });
		declaredDismiss(p.declared, { names: ["Cancel"], surface: "Toolbar", reason: "r" });
		const cov = coverageNow(p, "frontier-empty");
		assert.equal(cov.seen, 2);
		assert.equal(cov.actuated, 1);
		assert.equal(cov.dismissed, 1);
		assert.equal(cov.surfaces, 1);
	});
});

test("writeArtifacts__NeverTouchesTheElementGroundedMap__When__PassIsVisionOnly", () => {
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		const committedProse = "<!-- provenance: explore -->\ncommitted element-grounded map";
		fs.writeFileSync(`${appmaps}/yarn.md`, committedProse);
		fs.writeFileSync(`${appmaps}/yarn.json`, JSON.stringify({ app: "Yarn", capturedAt: "2026-07-30T00:00:00.000Z", provenance: "explore", nodes: [], edges: [] }));

		const p = newPass({ kind: "app", name: "Yarn" }, "Yarn", "ax", true, undefined, true);
		declaredIngest(p.declared, "Toolbar", [{ name: "Save" }]);
		declaredCredit(p.declared, { name: "Save", surface: "Toolbar" });
		writeArtifacts(p, { document: "# Yarn map from pixels", nodes: [], edges: [] }, "frontier-empty");

		const visionProse = fs.readFileSync(`${appmaps}/yarn.ax.vision.md`, "utf8");
		assert.match(visionProse, /^<!-- provenance: explore-vision \|/);
		assert.match(visionProse, /map from pixels/);
		const visionGraph = JSON.parse(fs.readFileSync(`${appmaps}/yarn.ax.vision.json`, "utf8"));
		assert.equal(visionGraph.provenance, "explore-vision");
		// The committed pair is byte-identical: the whole point of the separate filenames.
		assert.equal(fs.readFileSync(`${appmaps}/yarn.md`, "utf8"), committedProse);
	});
});

// ── consumption: APPMAP_VARIANT ──────────────────────────────────────────────────────────

test("appmapVariant__ReturnsVisionSuffix__When__EnvSelectsIt", () => {
	withEnv("APPMAP_VARIANT", "vision", () => assert.equal(appmapVariant(), ".vision"));
	withEnv("APPMAP_VARIANT", undefined, () => assert.equal(appmapVariant(), ""));
});

test("loadGrounding__LoadsTheVisionMap__When__AppmapVariantIsVision", () => {
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		fs.writeFileSync(`${appmaps}/yarn.md`, "<!-- provenance: explore | app: Yarn -->\nelement map");
		fs.writeFileSync(`${appmaps}/yarn.ax.vision.md`, "<!-- provenance: explore-vision | app: Yarn -->\nvision map");
		withEnv("APPMAP_VARIANT", "vision", () => {
			// The backend is part of the lookup now — a map is not backend-portable, so the
			// caller says which pass's vocabulary it can resolve against.
			const g = loadGrounding("yarn", "ax");
			assert.equal(g.provenance, "explore-vision");
			assert.match(g.path ?? "", /yarn\.ax\.vision\.md$/);
			assert.match(g.notes ?? "", /vision map/);
		});
	});
});

test("loadGrounding__LoadsTheElementMap__When__NoVariantIsSelected", () => {
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		fs.writeFileSync(`${appmaps}/yarn.md`, "<!-- provenance: explore | app: Yarn -->\nelement map");
		fs.writeFileSync(`${appmaps}/yarn.ax.vision.md`, "<!-- provenance: explore-vision | app: Yarn -->\nvision map");
		withEnv("APPMAP_VARIANT", undefined, () => {
			const g = loadGrounding("yarn");
			assert.equal(g.provenance, "explore");
			assert.match(g.notes ?? "", /element map/);
		});
	});
});

test("loadGrounding__ReportsNone__When__TheVariantMapIsAbsent", () => {
	// No silent fallback to the element-grounded map: that would leak its knowledge into a
	// vision-grounded benchmark arm and the run log would say so incorrectly.
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		fs.writeFileSync(`${appmaps}/yarn.md`, "<!-- provenance: explore | app: Yarn -->\nelement map");
		withEnv("APPMAP_VARIANT", "vision", () => {
			assert.equal(loadGrounding("yarn").provenance, "none");
		});
	});
});

test("loadAppMapGraph__LoadsTheVisionGraph__When__AppmapVariantIsVision", () => {
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		fs.writeFileSync(`${appmaps}/yarn.json`, JSON.stringify({ app: "Yarn", capturedAt: "x", provenance: "explore", nodes: [], edges: [] }));
		fs.writeFileSync(`${appmaps}/yarn.ax.vision.json`, JSON.stringify({ app: "Yarn", capturedAt: "x", provenance: "explore-vision", nodes: [], edges: [] }));
		// With the backend named, the vision variant resolves to the ax pass's own vision graph.
		withEnv("APPMAP_VARIANT", "vision", () => assert.equal(loadAppMapGraph("yarn", "ax")?.provenance, "explore-vision"));
		// Without the variant, the backend-specific file is absent here so it falls back to the
		// plain slug — which is what keeps curated and pre-split maps working.
		withEnv("APPMAP_VARIANT", undefined, () => assert.equal(loadAppMapGraph("yarn", "ax")?.provenance, "explore"));
	});
});

test("loadAppMapGraph__ReturnsUndefined__When__TheVisionGraphIsAbsent", () => {
	// Same no-fallback rule as the prose: a vision arm with no vision graph runs graphless.
	inTempRoot((dir) => {
		const appmaps = `${dir}/docs/appmaps`;
		fs.mkdirSync(appmaps, { recursive: true });
		fs.writeFileSync(`${appmaps}/yarn.json`, JSON.stringify({ app: "Yarn", capturedAt: "x", provenance: "explore", nodes: [], edges: [] }));
		withEnv("APPMAP_VARIANT", "vision", () => assert.equal(loadAppMapGraph("yarn", "ax"), undefined));
	});
});

// ── CLI refusals ─────────────────────────────────────────────────────────────────────────

test("noAxRefusal__Refuses__When__NoAxIsCombinedWithNoVision", () => {
	assert.match(noAxRefusal(true, false, "ax") ?? "", /window title and nothing else/);
});

test("noAxRefusal__Refuses__When__BackendIsNotAx", () => {
	// A non-ax backend's observations ARE ref lists — there is no element channel to drop.
	assert.match(noAxRefusal(true, true, "cdp") ?? "", /only applies to the ax backend/);
});

test("noAxRefusal__Allows__When__NoAxRunsOnAxWithVision", () => {
	assert.equal(noAxRefusal(true, true, "ax"), undefined);
});

test("noAxRefusal__Allows__When__NoAxIsOff", () => {
	assert.equal(noAxRefusal(false, false, "cdp"), undefined);
});

// ── tools ────────────────────────────────────────────────────────────────────────────────

test("VISION_ACT_TOOL__CarriesATargetProperty__When__SchemaIsRead", () => {
	// The declared target is the only way an action reaches the frontier on this pass. It is
	// enforced at runtime for operating verbs only — schema-required would force the model to
	// fabricate a target for `wait`, false coverage the declared frontier must not count.
	const schema = VISION_ACT_TOOL.input_schema as { required: string[]; properties: Record<string, unknown> };
	assert.ok(schema.properties.target);
	assert.equal(schema.required.includes("target"), false);
	// Derived from ACT_TOOL, so the action vocabulary cannot drift between the arms.
	assert.ok(schema.required.includes("action"));
});

test("SURVEY_TOOL__RequiresSurfaceAndControls__When__SchemaIsRead", () => {
	const schema = SURVEY_TOOL.input_schema as { required: string[] };
	assert.deepEqual([...schema.required].sort(), ["controls", "surface"]);
});

test("systemPrompt__TellsThePassToPressCreateControls__When__TheyOpenNewSurfaces", () => {
	const EXPLORE_PROMPT = systemPrompt("", { subject: "an app", container: "the window" } as any, false);
	// Three passes independently wrote down "New Template" and declined to press it — ax said
	// "state-changing; not operated", cdp "creates persistent content", no-vision "mapped but
	// not operated to preserve state" — and all three missed the entire template editor behind
	// it. No safety guard fired; the prompt did it.
	//
	// The cause was ordering: an absolute "NEVER ... no creating documents you can't discard"
	// came first, and permission to create scratch appeared twelve lines later, scoped to
	// mapping DELETE flows and hedged with "five is a mess left behind".
	assert.match(EXPLORE_PROMPT, /CREATE control is usually a door/i);
	assert.match(EXPLORE_PROMPT, /PRESS create controls/);
	// The prohibition must now name whose content it protects, or the model generalises it
	// back over its own scratch.
	assert.match(EXPLORE_PROMPT, /destructive or externally visible actions on THE USER'S existing content/);
	// And the old discouraging budget must be gone — it is what made one scratch object feel
	// like the ceiling.
	assert.doesNotMatch(EXPLORE_PROMPT, /five is a mess left behind/);
});

test("parseCli__UpgradesToAnElectronTarget__When__TheBackendIsCdp", () => {
	// Without cdpAttach the CDP backend never launches the app with a debug port — it probes
	// 9222 and fails — so explore on cdp worked ONLY while some earlier flagged run had left
	// the app running with one. Cold start removed that accident and all three cdp arms failed
	// instantly. agent/cli.ts has had this line since the cdp backend landed; explore never did.
	const cdp = parseCli(["Yarn", "--backend", "cdp"]);
	assert.equal(cdp.target.kind, "app");
	assert.equal((cdp.target as any).cdpAttach, true, "a cdp app target must be launchable");

	// The ax path is untouched — AxBackend opens the app itself and needs no debug port.
	const ax = parseCli(["Yarn", "--backend", "ax"]);
	assert.equal((ax.target as any).cdpAttach, undefined);

	// And the name still comes from the positional, not parseTarget's fallback — the bug the
	// rebuild above it exists to prevent (stamping every map "notion-calendar").
	assert.equal((cdp.target as any).name, "Yarn");
});

test("writeArtifacts__DemotesACutShortPass__When__ThereIsNoCommittedMapToBeat", () => {
	// The rule was BACKWARDS where it mattered most. A pass that did not finish on its own terms
	// publishes only if it beats half the committed map — but with no committed map the
	// comparison was `size * 2 < 0`, always false, so it published unconditionally. Least
	// protective exactly where there is no baseline, which is every arm's state after a wipe.
	//
	// On 2026-08-01 that was live: all nine phase-1 arms had their maps cleared, so a run that
	// died at action 12 with two nodes would have become Yarn's grounding and phase 2 would have
	// reported `provenance: explore` over it.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "explore", "artifacts.ts"), "utf8");
	assert.match(src, /const beatsBaseline = committedNodes > 0 && p\.graphNodes\.size \* 2 >= committedNodes/, "no baseline must mean demote");
	assert.match(src, /const demoted = salvaged \|\| \(!modelFinished && !beatsBaseline\)/);

	// And the bar stays STRUCTURAL — did the pass end on its own terms — never a quality score.
	// A coverage ratio counts dismissals, so the pre-fix passes that skipped 1933 of 1985
	// controls would score 0.97 while the best pass of the night scores 0.06.
	assert.equal(/coverageRatio|actuated \/ seen|resolvedRatio/.test(src), false, "publication must not depend on a gameable quality score");
});

test("exploreLoop__OffersTheModelAnExit__When__TheAppStopsExposingAnything", () => {
	// Six AX passes died on 2026-08-01 with the app exposing nothing, and the model was never
	// told it could stop. blindStreak counted invisibly: the logs show the agent waiting, pressing
	// Escape, then cmd+W on a helper window it had correctly identified as blank — sensible
	// recovery — and then the harness killed the run at three strikes. One had 27 findings and 86
	// graph nodes at the time.
	//
	// Conceding on the FIRST blank observation would be wrong too: sometimes closing the window
	// does bring the app back. What was missing is the information to choose.
	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "explore", "loop.ts"), "utf8");
	assert.match(src, /observation \$\{blindStreak\} of 3/, "the model must be told the count it is being judged on");
	assert.match(src, /call finish now with what you have already mapped/i, "the exit must be named, not implied");
	// A pass that takes the exit ends `frontier-conceded`, which is a model finish — so its map
	// publishes through the ordinary path instead of being salvaged into a folder nobody reads.
	assert.match(src, /legitimate ending/i);
});
