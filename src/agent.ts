import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Driver } from "./driver.js";
import {
	ACT_TOOL,
	appSlug,
	auditTaskPrompt,
	dragMoved,
	DRIVER_RULES,
	ensureObservable,
	failedProvider,
	findScopeAmbiguities,
	findWindow,
	framesShifted,
	loadAppMapGraph,
	makeClient,
	observationBlocks,
	observe,
	onInterrupt,
	OUT,
	pixelDelta,
	providerRouting,
	resetToHome,
	runKey,
	scopeWarnings,
	settleMsFor,
	stageWindowForRecording,
	TargetNotObservableError,
	toActionRequest,
	unpaintedStreak,
	UNREADY_EXIT,
	verificationTallies,
	verify,
	visualJudge,
} from "./harness.js";
import { DOM_ACT_TOOL, DOM_RULES, DomBackend, FIND_TOOL } from "./dom.js";
import { appendMutation, detectMutation, readJournal } from "./journal.js";
import { runTeardown } from "./teardown.js";
import { startOverlay } from "./overlay.js";
import { appmapsDir, recipesDir, relToData } from "./paths.js";
import type { ActionRequest, Expectation, StepRecord } from "./types.js";
import type { ObservationBundle, VerifyResult, VisualVerdict } from "./harness.js";

const MAX_STEPS = Number(process.env.AGENT_STEPS ?? 15);
/**
 * Steps a single restore entry may spend before it is abandoned.
 *
 * Restoring is strictly easier than the task that caused it — the target value is already
 * known, so the harness writes the expectation instead of trusting one — and the route comes
 * from the appmap. A budget this small is therefore a real signal: an entry that cannot be
 * put back in ten steps is reporting that the control moved or the surface changed, which is
 * worth saying rather than grinding on.
 */
const CLEANUP_STEPS = Number(process.env.CLEANUP_STEPS ?? 10);
/**
 * Consecutive steps with nothing verified and nothing repainted before the run says so. It
 * used to abort here, and that was wrong for a whole class of target: apps with an embedded
 * agent of their own, where waiting on a think that runs for minutes produces exactly this
 * signature — nothing verified, no pixels moved — and is the correct thing to be doing. A
 * frozen window and a working one waiting on a slow model are indistinguishable from
 * outside, so the run no longer decides between them. The diagnosis stays: the case that
 * motivated it (a run that held a full AX tree while saving 247 byte-identical frames)
 * looked healthy on every channel except this one.
 */
const FROZEN_STEPS = 4;
/** Free read-only page searches per run, beyond which a find costs an action. */
const MAX_FINDS = Number(process.env.AGENT_FINDS ?? 20);
const SETTLE_MS = 900;

const systemPrompt = (rules: string, vision: boolean): string => `You are a UI automation agent driving a macOS app through a UI driver. Each turn you receive an observation: the target window's interactive elements (addressing handle, role, label/value)${vision ? " and a screenshot" : "; element frames give positions — there is no screenshot"}. You perform ONE action per turn by calling the "act" tool, then the harness executes it, waits, re-observes, and reports back.

${rules}
- Set a concrete, checkable expectation for every action: textIncludes and/or textExcludes, literal substrings checked against the window title plus all element labels and values in the NEXT observation. This is MANDATORY — an act call carrying only a prose description is rejected and NOT executed, costing you a turn. Supply it even when you are certain the action will work.
- Expectations must DISCRIMINATE: at least one substring that appears (or disappears) BECAUSE of the action. A check that was already true before the action is rejected as evidence — in particular, text you typed earlier does not verify a later action.
- If verification fails, do not repeat the same action blindly — re-read the observation, diagnose, and recover.
- There is no time limit, so when the app is working on something slow — a long render, an upload, an assistant of its own thinking — do not treat the unchanged screen as failure and do not poke at it. Call wait with a generous "seconds" (a whole minute or several is fine; one long wait costs one step, many short ones cost many) and set the expectation to the finished state you are waiting for.

DEMONSTRATE BY DOING. Your runs are recorded as product demos, so the video must show the outcome, not a tour of where the buttons are. Phrasings like "show me how to X", "walk me through X", "demo X" are requests to PERFORM X, end to end, leaving the app in the changed state. Navigating to a control, opening a dropdown, and describing the remaining steps in your summary is a FAILED run, however accurate the description.

- If the task names no specific value ("change the cursor type" — to what?), CHOOSE a sensible one — any value different from the current one — and commit it. An unspecified value is not a reason to stop short; it is yours to pick. Say which you chose in your summary.
- Commit the change: if there is a Save / Done / Apply control, click it, and confirm the change survived (the unsaved-changes affordance disappears, or the control still reads the new value on re-observation).
- Your "done" evidence must prove the NEW state, so pair textIncludes on the new value with textExcludes on the old one wherever the change replaces a value.

WORK IN SCRATCH, NOT IN THE USER'S CONTENT. When a task needs something to operate on — a document, a project, a draft — CREATE A NEW ONE with a distinctive name rather than opening something that is already there, and call "claim" the moment it exists. The workspace you are driving may be a real person's, and a demo that edits their actual work is a failure even when the task succeeds.

Settings you change are put back after the run, so change them freely. Things you CREATE are not removed automatically — they are only reported — so creating a scratch document is safe and preferable, but creating five of them leaves five behind.

The one exception is irreversible or externally-visible actions — deleting, publishing, exporting, sending, sharing, purchasing, account changes. For those, and ONLY those, go as far as the final confirmation step WITHOUT confirming, then call done with success: true, evidence showing you reached that point, and a summary saying plainly that you stopped before the irreversible step.

Call "done" when the task is complete (success: true) — you MUST attach evidence: substring checks proving the GOAL state, which the harness verifies against a fresh final observation before accepting. Call done with success: false when you are stuck after genuine recovery attempts. Always call exactly one tool per turn.`;

const DONE_TOOL: Anthropic.Tool = {
	name: "done",
	description:
		"End the run: the task is complete and verified, or unrecoverable. A success claim is only accepted if your evidence checks pass against a FRESH final observation taken by the harness.",
	input_schema: {
		type: "object",
		properties: {
			success: { type: "boolean" },
			summary: { type: "string", description: "What was done and how the final state verifies it (or why it failed)." },
			evidence: {
				type: "object",
				description:
					"REQUIRED when success is true. Substring checks proving the GOAL state (not merely the last action) — run against a fresh observation. " +
					"When the goal REPLACES one state with another, presence of the new value is NOT sufficient: apps routinely show the new value ALONGSIDE the old " +
					"one (a preview, a secondary column, an unsaved draft), so a presence-only check passes while nothing actually changed. Pair textIncludes on the " +
					"new value with textExcludes on the old one. E.g. changing the timezone from EDT to Paris: textIncludes ['GMT+2'] AND textExcludes ['EDT'].",
				properties: {
					description: { type: "string" },
					textIncludes: { type: "array", items: { type: "string" } },
					textExcludes: { type: "array", items: { type: "string" } },
				},
				required: ["description"],
			},
		},
		required: ["success", "summary"],
	},
};

/**
 * The agent's declaration that it brought something into existence.
 *
 * This is the sandbox half of cleanup, and it exists because restoring a value and disposing
 * of a thing are not the same operation: a setting has a previous value to write back, while
 * a draft the run created has no "before" at all — the only way to leave the workspace as it
 * was found is to remove it. A claimed name is the whole of teardown's authority to do that:
 * disposal is matched against this ledger by code, so an unclaimed document cannot be deleted
 * however convinced the model is that it is scratch.
 */
const CLAIM_TOOL: Anthropic.Tool = {
	name: "claim",
	description:
		"Declare a resource this run created (or is about to modify) so the harness can account for it afterwards. " +
		"Call it IMMEDIATELY after creating the thing, with the exact name as the app renders it.",
	input_schema: {
		type: "object",
		properties: {
			kind: {
				type: "string",
				enum: ["created", "will-modify"],
				description:
					'"created" is a thing that did not exist before this run. ' +
					'"will-modify" is pre-existing content you are about to change, recorded so the change can be reported.',
			},
			name: { type: "string", description: 'Exact name as it appears in the app, e.g. "scratch-demo-7f3a".' },
			note: { type: "string", description: "One sentence: what it is and why the task needed it." },
		},
		required: ["kind", "name"],
	},
};

interface GroundingMeta {
	/** "none" | "explore" (autonomous exploration output) | "curated" (human-edited — a recipe tier, not measurable as grounding) */
	provenance: "none" | "explore" | "curated";
	path?: string;
	notes?: string;
}

function loadGrounding(app: string): GroundingMeta {
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/recipes/ holds hand-curated notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	const explorePath = `${appmapsDir()}/${appSlug(app)}.md`;
	const recipePath = `${recipesDir()}/${appSlug(app)}.md`;
	const useRecipe = process.env.USE_RECIPE ? fs.existsSync(recipePath) : false;
	const path = useRecipe ? recipePath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	const stamped = /^<!-- provenance: explore\b/.test(notes);
	if (!useRecipe && !stamped)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/recipes/.",
		);

	return { provenance: useRecipe || !stamped ? "curated" : "explore", path, notes };
}

function pngSize(path: string): { w: number; h: number } {
	const buf = Buffer.alloc(8);
	const fd = fs.openSync(path, "r");
	fs.readSync(fd, buf, 0, 8, 16);
	fs.closeSync(fd);

	return { w: buf.readUInt32BE(0), h: buf.readUInt32BE(4) };
}

function badFrames(framesDir: string): Set<number> {
	// Content-level gate, complementing the majority-vote size filter: catches
	// frames whose canvas size is right but whose content is offset (the driver
	// composites the window at an offset during Space/display transitions).
	// Measures leading pure-black columns; anything over ~6px is malformed.
	const script = `
import glob, sys
from PIL import Image
for i, p in enumerate(sorted(glob.glob("${framesDir}/f-*.png"))):
    im = Image.open(p).convert("RGB")
    w, h = im.size
    band = 0
    for x in range(0, min(w, 600), 2):
        if max(max(im.getpixel((x, y))) for y in range(0, h, 32)) < 12: band = x + 2
        else: break
    if band > 6: print(i)
`;
	const out = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`).toString().trim();

	return new Set(out ? out.split("\n").map(Number) : []);
}

function assembleVideo(framesDir: string, times: number[], outPath: string): void {
	// A run that dies before the first frame lands never creates the directory — that is a
	// failed run, already reported, and an ENOENT stack on top of it only obscures the cause.
	if (!fs.existsSync(framesDir)) {
		console.log("no frames captured — skipping video assembly");

		return;
	}
	const all = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
	// Majority vote: the modal frame size defines "tight" for this run; composite/
	// mis-scaled captures show up as size outliers.
	const sizeCounts = new Map<string, number>();
	const sizes = all.map((f) => {
		const s = pngSize(`${framesDir}/${f}`);
		const key = `${s.w}x${s.h}`;
		sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1);
		return key;
	});
	const modal = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	const bad = badFrames(framesDir);
	const keep = all.map((_, i) => sizes[i] === modal && !bad.has(i));
	const dropped = keep.filter((k) => !k).length;
	if (dropped > 0) console.log(`dropping ${dropped} malformed frame(s) (modal size ${modal})`);
	const frames = all.filter((_, i) => keep[i]);
	times = times.filter((_, i) => keep[i]);
	if (frames.length < 2) {
		console.log("not enough frames for a video");
		return;
	}
	const { w, h } = pngSize(`${framesDir}/${frames[0]}`);
	const W = w & ~1;
	const H = h & ~1;
	let list = "";
	for (let i = 0; i < frames.length; i++) {
		const dur = i < times.length - 1 ? (times[i + 1] - times[i]) / 1000 : 0.25;
		list += `file '${frames[i]}'\nduration ${Math.max(0.05, Math.min(dur, 5)).toFixed(3)}\n`;
	}
	list += `file '${frames[frames.length - 1]}'\n`;
	fs.writeFileSync(`${framesDir}/list.txt`, list);
	execSync(
		`ffmpeg -v error -f concat -safe 0 -i list.txt -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a,format=yuv420p" -y "${outPath}"`,
		{ cwd: framesDir },
	);
	console.log(`window-scoped video: ${outPath} (${frames.length} frames)`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const record = argv.includes("--record");
	// A/B arm: drop the screenshot from every model message. The observation becomes
	// text-only (title + AX elements with frames); capture for recording/artifacts is
	// unaffected. Measures what the image channel is worth in actions/tokens/correctness.
	const vision = !argv.includes("--no-vision");
	// off | advisory (default) | block. Advisory records the judge's verdict without letting
	// it decide the run: it is a second opinion, and a wrong confident verdict in either
	// direction is worse than no verdict until we have a measured error rate for it.
	const judgeMode = process.env.VISUAL_JUDGE ?? "advisory";
	const backendIdx = argv.indexOf("--backend");
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : "ax";
	const args = argv.filter(
		(a, i) =>
			!["--record", "--hinted", "--no-reset", "--no-vision", "--allow-unready"].includes(a) &&
			(backendIdx < 0 || (i !== backendIdx && i !== backendIdx + 1)),
	);
	const task = args[0];
	// Yarn is the canonical target for all runs (set by David, 2026-07-29); Notion
	// Calendar remains available by passing it explicitly.
	const app = args[1] ?? "Yarn";
	if (!task || !["ax", "dom"].includes(backendKind)) {
		console.error('usage: tsx src/agent.ts "<task>" ["App Name"] [--record] [--backend ax|dom] [--no-vision]');
		console.error("--backend dom drives an Electron/browser target over CDP; launch it with --remote-debugging-port first.");
		process.exit(1);
	}

	// Prompt hygiene gate: a task prompt containing method hints is not a valid autonomy
	// test, and the resulting run log is indistinguishable from a clean one unless we
	// record the fact here. Refuse by default; --hinted opts in and marks the log.
	const noReset = argv.includes("--no-reset");
	const allowUnready = argv.includes("--allow-unready");
	const hintedAck = argv.includes("--hinted");
	const audit = auditTaskPrompt(task);
	if (audit.hinted && !hintedAck) {
		console.error("REFUSING TO RUN — the task prompt contains method hints, not just a goal:");
		for (const r of audit.reasons) console.error(`  · ${r}`);
		console.error(
			"\nA hinted prompt hands the model knowledge it would not have in a real run, so the\n" +
				"result cannot be reported as autonomous. Move method knowledge into\n" +
				`docs/appmaps/${appSlug(app)}.md (a declared input), and restate the task as the goal only.\n` +
				"If the hint is intentional (e.g. pinning a path for a filming take), re-run with --hinted;\n" +
				"the run log and any published result must then say so.",
		);
		process.exit(2);
	}

	const { client, model } = makeClient();
	// Announce the takeover before the first action. A run seizes pointer and keyboard for
	// minutes and is otherwise indistinguishable from an idle machine, so anyone sitting in
	// front of it cannot tell when it is safe to type. OVERLAY=0 suppresses it for takes
	// where the banner would be in frame.
	const overlay = startOverlay("drive", `Agent driving ${app} — do not touch`);
	const driver = await Driver.start("agent");
	const interrupted = onInterrupt(() => driver.close());
	const records: StepRecord[] = [];
	const startedAt = Date.now();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
	// Unique per run: a single overwritten agent-run.json forced hand-copying to preserve
	// A/B artifacts, which is how out/ab-grounded-script.json ended up a mislabeled
	// duplicate of a different run and its real numbers were lost.
	const stamp = runKey("", app);
	fs.mkdirSync(`${OUT}/runs`, { recursive: true });
	const runLog = `${OUT}/runs/${stamp}.json`;
	let driverBusy = false;
	let homeReset: string = noReset ? "skipped" : "pending";
	// Whether the axdom sidecar supplied DOM id/class this run. Recorded so a run's
	// element quality is legible from its log rather than inferred.
	let domEnrichment: { frames: number; unavailable?: string } = { frames: 0, unavailable: "not observed" };
	let expectationRejections = 0;
	let findCalls = 0;
	let malformedStreak = 0;
	// Upstream providers this run has watched fail. Sent back to OpenRouter as an ignore list so
	// a retry is routed somewhere else — backoff alone re-asks the broken host. See
	// providerRouting in harness.ts for the incident that motivated it.
	const badProviders = new Set<string>();
	let aborted: unknown;
	let outcome: Record<string, unknown> | undefined;
	// off | advisory (default) | block. Advisory keeps the task's verdict and cleanup's on
	// separate axes: a demo that achieved its goal did so whether or not the app was tidied
	// afterwards, and collapsing the two would mark good runs as failures. `off` is for
	// filming takes, where the changed end state IS the artifact.
	const cleanupMode = process.env.CLEANUP ?? "advisory";
	// Appended the instant a mutation is detected rather than written with the run log,
	// because the case this most needs to survive is the one where there is no run log: a
	// crash mid-task leaves the app dirty, and the journal on disk is what lets
	// `npm run cleanup -- <stamp>` put it back without a human reconstructing what happened.
	const journalPath = `${OUT}/runs/${stamp}.journal.jsonl`;
	const claimed: Array<{ kind: string; name: string; note?: string; step: number }> = [];
	// Restore steps live apart from `records` so verificationTallies() keeps reporting the
	// TASK's numbers. Folding them in would let a run improve its own verification rate by
	// cleaning up after itself, which measures nothing.
	const cleanupSteps: StepRecord[] = [];
	let cleanupReport: Record<string, unknown> | undefined;

	/**
	 * The one place a run log is written. Every exit — done(), the step limit, an abort —
	 * sets `outcome` and this runs once from the finally, because the exits assembled the
	 * log independently and drifted: the step-limit path omitted `video`, and the gallery
	 * lists only runs that declare one. Runs that ran out of steps never appeared in the
	 * feed even though their mp4 had assembled normally.
	 *
	 * `result` carries what only the exiting path knows (success, summary, the final
	 * checks); everything derivable from the run itself is filled in here so it cannot go
	 * missing from one path again.
	 */
	const writeRunLog = (result: Record<string, unknown>): void => {
		fs.writeFileSync(
			runLog,
			JSON.stringify(
				{
					task,
					app,
					backend: backendKind,
					vision,
					grounding: groundingMeta,
					hintedPrompt: audit.hinted,
					hintReasons: audit.reasons,
					homeReset,
					domEnrichment,
					sessionRevivals: driver.revivals,
					expectationRejections,
					findCalls,
					elapsedSec: Math.round((Date.now() - startedAt) / 1000),
					usage,
					...verificationTallies(records),
					...(cleanupReport ? { cleanup: cleanupReport } : {}),
					...(claimed.length ? { claimed } : {}),
					...result,
					...(record ? { video: relToData(videoPath) } : {}),
					steps: records,
					...(cleanupSteps.length ? { cleanupSteps } : {}),
				},
				null,
				2,
			),
		);
		console.log(`run log: ${runLog}`);
	};

	// Window-scoped recording: poll the driver's window snapshots (which work even
	// when the window is occluded, backgrounded, or on another Space) and assemble
	// them into an mp4 afterwards. Polling pauses while an action/observation holds
	// the driver, so frames land in the model-thinking gaps.
	// Per-run directory, sharing the run log's stamp: the video and the log that proves
	// what it shows stay paired, and a recorded A/B no longer overwrites its own evidence.
	const recordingDir = `${OUT}/recording/${stamp}`;
	const framesDir = `${recordingDir}/frames`;
	const videoPath = `${recordingDir}/window.mp4`;
	const frameTimes: number[] = [];
	const frameDrops: string[] = [];
	let recordingActive = false;
	let frameLoop: Promise<void> | undefined;

	const grounding = loadGrounding(app);
	// What the log records: provenance + path + content hash, not the full text — enough
	// to pin exactly which appmap version grounded the run without bloating every log.
	const groundingMeta: Record<string, unknown> = {
		provenance: grounding.provenance,
		...(grounding.path ? { path: relToData(grounding.path) } : {}),
		...(grounding.notes ? { sha256: createHash("sha256").update(grounding.notes).digest("hex").slice(0, 12) } : {}),
	};
	// The structured appmap rides alongside the prose one. Its job here is the scope
	// warning: prose could not stop four ungrounded runs from silently changing a
	// per-draft override instead of the brand default, because both satisfy a
	// substring check. Naming each collision explicitly gives the model something
	// specific to act on. NO_GROUNDING drops it too, so the A/B stays honest.
	const graph = grounding.notes ? loadAppMapGraph(app) : undefined;
	const warnings = graph ? scopeWarnings(graph) : "";
	const ambiguities = graph ? findScopeAmbiguities(graph) : [];

	const basePrompt = systemPrompt(backendKind === "dom" ? DOM_RULES : DRIVER_RULES, vision);
	const system = grounding.notes
		? `${basePrompt}\n\n# App grounding notes for ${app} (from a prior exploration pass — trust these to skip dead ends)\n${grounding.notes}${warnings}`
		: basePrompt;
	if (grounding.notes) console.log(`loaded grounding notes for ${app} (provenance: ${grounding.provenance}, ${groundingMeta.path})`);
	if (graph) {
		groundingMeta.graph = { nodes: graph.nodes.length, edges: graph.edges.length, scopeAmbiguities: ambiguities.map((a) => a.settingKey) };
		console.log(`loaded appmap graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
		for (const a of ambiguities)
			console.log(`  scope ambiguity: ${a.settingKey} — ${a.nodes.map((n) => `${n.id} [${n.scope}]`).join(" vs ")}`);
	}
	// find is DOM-only: it is the escape hatch from the semantic_v2 node budget, and the
	// AX path has no budget to escape (get_window_state returns the whole tree).
	const tools: Anthropic.Tool[] = backendKind === "dom" ? [DOM_ACT_TOOL, FIND_TOOL, CLAIM_TOOL, DONE_TOOL] : [ACT_TOOL, CLAIM_TOOL, DONE_TOOL];

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		// Reassigned by ensureObservable: recovering an unobservable target can relaunch it
		// onto a new window, and every later call must use that one.
		let win = await findWindow(driver, app);
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		// For the DOM backend the CDP bind is the observability gate; AX darkness is fine.
		const dom = backendKind === "dom" ? await DomBackend.bind(driver, win) : undefined;
		if (!dom) win = await ensureObservable(driver, win, app);
		const doObserve = (name: string) => (dom ? dom.observe(name) : observe(driver, win, name));
		console.log(`target: ${app} pid=${win.pid} window=${win.windowId} backend=${backendKind}`);

		// Start from a declared home state, so a run never inherits the previous run's
		// navigation. --no-reset opts out (e.g. deliberately resuming mid-flow).
		// Runs on BOTH backends: resetToHome uses the AX path either way, and skipping it
		// for DOM made AX-vs-DOM comparisons uneven (one arm started from a declared home,
		// the other from wherever the previous run stopped).
		if (!noReset) {
			// The reset clicks, so it is actuation like any step.
			overlay.setDriving(true);
			const reset = await resetToHome(driver, win, app);
			overlay.setDriving(false);
			homeReset = reset.result;
			console.log(`home reset: ${reset.result} — ${reset.detail}`);
			if (reset.result === "none" || reset.result === "root-visible")
				console.log(`  (runs are NOT normalised for "${app}" — an exploration pass records the home state)`);
			// A failed reset means this run starts wherever the last one stopped, inheriting
			// its navigation. That is not a comparable measurement, and it is invisible in
			// the summary line unless said plainly here.
			//
			// It is also the cheapest signal we have that the app is not USABLE at all. A
			// freshly installed app on a fleet Mac sits at a sign-in wall, and its declared
			// home control is exactly what is missing there — so the same probe that keeps
			// runs comparable also catches an unauthenticated machine. Left ungated, the
			// agent treats the wall as the task: a real run on 2026-07-30 spent four steps
			// and opened an OAuth flow in Chrome before it was killed.
			//
			// Nothing here knows what a login looks like — that would be app-specific. It
			// knows only that a DECLARED home state could not be reached, which is a fact
			// about this app's own appmap data, and refuses to spend a run guessing why.
			if (reset.result === "failed") {
				if (!allowUnready) {
					console.error(`\nREFUSING TO RUN — "${app}" is not at its home state and the reason is unknown.`);
					console.error(`  ${reset.detail}`);
					console.error("  Most often this is an app that has never been signed in on this machine, or a modal");
					console.error("  the previous run left open. Driving it anyway makes the obstacle the task.");
					console.error(`  Sign in once on this Mac (./run signin <mac> "${app}"), or pass --allow-unready to drive it as-is.`);
					process.exit(UNREADY_EXIT);
				}
				console.log("  WARNING: start state is whatever the previous run left behind — NOT comparable for A/B measurement.");
			}
		}
		console.log(`task: ${task}\n`);

		if (record) {
			// Staging raises the window and resizes it to fill the display — as intrusive as
			// any click, and the one moment an operator is most likely to reach for the mouse.
			overlay.setDriving(true);
			try {
				const stage = stageWindowForRecording(app);
				console.log(`recording stage: ${stage.detail}`);
				await new Promise((r) => setTimeout(r, 1500));
			} catch {
				console.log("could not stage window for recording; recording may be degraded");
			} finally {
				overlay.setDriving(false);
			}
			fs.mkdirSync(framesDir, { recursive: true });
			await driver.act({ kind: "tool", name: "start_recording", args: { output_dir: `${recordingDir}/trajectory` } });
			recordingActive = true;
			frameLoop = (async () => {
				while (recordingActive) {
					if (!driverBusy) {
						driverBusy = true;
						const framePath = `${framesDir}/f-${String(frameTimes.length).padStart(5, "0")}.png`;
						try {
							// Capture everything; malformed frames are filtered at assembly by
							// majority vote on frame size (self-consistent — no external reference
							// that can go stale when the window resizes or the AX tree goes dark).
							await driver.act({
								kind: "tool",
								name: "get_window_state",
								args: { pid: win.pid, window_id: win.windowId, screenshot_out_file: framePath },
							});
							frameTimes.push(Date.now());
						} catch (err) {
							frameDrops.push(`error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
							fs.rmSync(framePath, { force: true });
						} finally {
							driverBusy = false;
						}
					}
					await new Promise((r) => setTimeout(r, 250));
				}
			})();
			console.log(`recording window-scoped frames -> ${framesDir}\n`);
		}

		let blindStreak = 0;
		// The first observation is the last thing that touches the app before the first model
		// call, so it owns the handoff: without this the banner — which starts visible and is
		// only ever hidden by a setDriving(false) — stays up through the whole opening think.
		overlay.setDriving(true);
		let obs: ObservationBundle;
		try {
			obs = await doObserve("agent-step-0");
		} finally {
			overlay.setDriving(false);
		}
		domEnrichment = { frames: obs.domEnriched, unavailable: obs.domUnavailable };
		console.log(`dom enrichment: ${obs.domEnriched} frames${obs.domUnavailable ? ` (${obs.domUnavailable})` : ""}`);
		const messages: Anthropic.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: `Task: ${task}\nTarget app: ${app}\n\nInitial observation follows.` },
					...observationBlocks(obs, vision),
				],
			},
		];

		for (let step = 1; step <= MAX_STEPS; step++) {
			// Between actions, never mid-action: leaving here rather than from the signal
			// handler means the finally below still assembles the video and writes the log, so
			// a stopped run is a recorded failure instead of a run that never existed.
			if (interrupted()) {
				console.log(`\n=== stopped after ${step - 1} steps ===`);
				outcome = { success: false, summary: `interrupted after ${step - 1} steps` };

				// return, not break: the step-limit lines below the loop would otherwise
				// overwrite this outcome and file the run as having exhausted its budget.
				return;
			}

			// A provider overload can arrive as an empty body, which the SDK surfaces as a
			// JSON parse error from inside the call — not something the malformed-content
			// check below can see. Both failure shapes are the same transient event, so
			// they share one backoff-and-retry path.
			let response: Anthropic.Message;
			try {
				response = await client.messages.create({
					model,
					max_tokens: 16000,
					system,
					tools,
					cache_control: { type: "ephemeral" },
					messages,
					...providerRouting(badProviders),
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message.slice(0, 200) : String(err);
				if (++malformedStreak >= 5) throw new Error(`5 consecutive model-call failures; last: ${detail}`);
				// Before the backoff: the next attempt is only different if it is routed
				// differently, and this is the one place the failing route names itself.
				const provider = failedProvider(err);
				if (provider && !badProviders.has(provider)) {
					badProviders.add(provider);
					console.log(`    -> routing around provider "${provider}" for the rest of this run`);
				}
				const backoffMs = 2000 * 2 ** (malformedStreak - 1);
				console.log(`    -> model call failed (${malformedStreak}/5), retrying in ${backoffMs / 1000}s: ${detail}`);
				await new Promise((r) => setTimeout(r, backoffMs));
				step--; // a failed call is not a step
				continue;
			}

			usage.modelCalls++;
			usage.inputTokens += response.usage?.input_tokens ?? 0;
			usage.outputTokens += response.usage?.output_tokens ?? 0;
			usage.cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;

			if (response.stop_reason === "refusal") throw new Error("model refused the request");

			// OpenRouter can return an error payload with no content array; treating that as
			// a well-formed message crashed the run and lost every step of work behind it.
			if (!Array.isArray(response.content)) {
				const detail = JSON.stringify(response).slice(0, 300);
				// Usually a transient provider overload, so back off before retrying —
				// three immediate retries just burn the allowance in under a second.
				if (++malformedStreak >= 5) throw new Error(`5 consecutive malformed model responses; last: ${detail}`);
				const backoffMs = 2000 * 2 ** (malformedStreak - 1);
				console.log(`    -> malformed model response (${malformedStreak}/5), retrying in ${backoffMs / 1000}s: ${detail}`);
				await new Promise((r) => setTimeout(r, backoffMs));
				step--; // a failed call is not a step
				continue;
			}
			malformedStreak = 0;

			const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			messages.push({ role: "assistant", content: response.content });

			if (!toolUse) {
				messages.push({ role: "user", content: "You must call exactly one tool (act or done)." });
				continue;
			}

			// find is a read-only page search, not an action: it consumes a model call but
			// not a step, so a search never costs the agent part of its action budget.
			if (toolUse.name === "find") {
				const q = (toolUse.input as { query: string }).query;
				let text: string;
				try {
					while (driverBusy) await new Promise((r) => setTimeout(r, 50));
					driverBusy = true;
					const hits = await dom!.find(q);
					driverBusy = false;
					text = hits.length
						? `find("${q}") matched ${hits.length}:\n` +
							hits
								.slice(0, 40)
								.map((r) => `[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}"${r.value && r.value !== r.name ? ` value="${r.value.slice(0, 60)}"` : ""} (${r.actions.join(",") || "no actions"}) ${r.visibility}`)
								.join("\n")
						: `find("${q}") matched nothing. Try a shorter or differently-worded string — matching is over role, accessible name, and visible text.`;
				} catch (err) {
					driverBusy = false;
					text = `find("${q}") failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
				}
				console.log(`    find "${q}" -> ${text.split("\n")[0]}`);
				findCalls++;
				messages.push({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: toolUse.id, content: text }],
				});
				// Refunding the step keeps searching free, but a model that only ever
				// searches would loop forever — past the cap, finds start costing a step.
				if (findCalls <= MAX_FINDS) step--;
				continue;
			}

			// Bookkeeping, not actuation: nothing touches the app, so the step is refunded and
			// the model goes straight back to work. Charging for it would price honesty.
			if (toolUse.name === "claim") {
				const c = toolUse.input as { kind: string; name: string; note?: string };
				claimed.push({ ...c, step });
				console.log(`    claim (${c.kind}): "${c.name}"${c.note ? ` — ${c.note}` : ""}`);
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							// Accurate about what the ledger does. Telling the model a resource
							// "will be deleted" would be false — disposal is reporting-only — and a
							// model that believes its mess is handled is the one that stops
							// preferring scratch over the user's own content.
							content:
								`Claimed "${c.name}" (${c.kind}). It is recorded and will be reported at the end of the run; ` +
								"it is NOT deleted automatically, so keep preferring scratch over existing content. Carry on with the task.",
						},
					],
				});
				step--;

				continue;
			}

			if (toolUse.name === "done") {
				const input = toolUse.input as { success: boolean; summary: string; evidence?: Expectation };

				// success is a claim; the harness demands machine-checkable evidence and
				// grades it against a FRESH observation (state can have shifted since the
				// last step — e.g. a toast expired or a save silently failed).
				let finalCheck: { verified: boolean; note: string; evidence?: Expectation } | undefined;
				let visual: VisualVerdict | undefined;
				if (input.success) {
					const checkable = input.evidence?.textIncludes?.length || input.evidence?.textExcludes?.length;
					if (!checkable) {
						console.log("    -> done(success) rejected: no checkable evidence");
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										"DONE NOT ACCEPTED — success requires evidence.textIncludes and/or evidence.textExcludes: " +
										"substrings proving the GOAL state, verified against a fresh observation. " +
										"Re-issue done with checkable evidence, or done(success: false) if you cannot prove the goal.",
								},
							],
						});
						continue;
					}

					while (driverBusy) await new Promise((r) => setTimeout(r, 50));
					driverBusy = true;
					overlay.setDriving(true);
					let finalShot = "";
					try {
						const finalObs = await doObserve("agent-final");
						finalShot = finalObs.screenshotB64;
						finalCheck = { ...verify(input.evidence!, finalObs.haystack), evidence: input.evidence };
					} finally {
						driverBusy = false;
						overlay.setDriving(false);
					}

					// Independent visual check of the goal state — a SEPARATE model call that
					// sees only the task and the final frame, never the action history or the
					// actor's summary. Substring evidence proves *a* control reads the target
					// value; it cannot prove that control is the intended one. Advisory unless
					// VISUAL_JUDGE=block, because a confident wrong verdict either stalls a good
					// run or waves through a bad one.
					if (judgeMode !== "off" && finalShot) {
						visual = await visualJudge(client, model, task, finalShot, input.summary);
						if (visual) {
							usage.modelCalls++;
							console.log(`    visual judge: ${visual.verdict} — ${visual.why}`);
							if (visual.scope) console.log(`      scope seen: ${visual.scope}`);
						} else {
							console.log("    visual judge: NO VERDICT — this run has no independent visual check.");
						}
					} else if (judgeMode !== "off") {
						console.log("    visual judge: skipped — no final screenshot was captured.");
					}

					if (judgeMode === "block" && visual?.verdict === "FAIL") {
						console.log("    -> done(success) BLOCKED by the visual judge");
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										`DONE NOT ACCEPTED — an independent visual check of the final screen says the goal was NOT achieved: ${visual.why}\n` +
										`Surface it saw: ${visual.scope}\n` +
										"Your text evidence passed, so a control does read the expected value — but possibly the wrong one " +
										"(e.g. a per-document override rather than the global default). Diagnose and continue, or call done(success: false).",
								},
							],
						});
						continue;
					}

					if (!finalCheck.verified) {
						console.log(`    -> done(success) REFUTED by final observation: ${finalCheck.note}`);
						// A run carried by pixel evidence lands here by construction: the final
						// check greps text, and a painted target has none. Say so, because
						// otherwise the model reads "evidence failed" as a miss and retries the
						// drag forever. There IS no text to find, and that is the honest answer.
						const pixelOnly = records.some((r) => r.verificationChannel === "pixel" || r.verificationChannel === "geometry") && !records.some((r) => r.verificationChannel === "text");
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										`DONE NOT ACCEPTED — your evidence failed against a fresh observation: ${finalCheck.note}\n` +
										(pixelOnly
											? "Every step in this run was verified by pixels alone, so the app exposes no text for this target and " +
												"no substring can prove the goal. Do not keep retrying. If you believe the manipulation succeeded, call " +
												"done(success: false) and say in your summary what you did and that it is unverifiable through this channel."
											: "The goal state is not proven. Diagnose and continue, or call done(success: false)."),
								},
							],
						});
						continue;
					}
				}

				const { unverifiedSteps: unverified, verifiedByChannel } = verificationTallies(records);
				const { text: textSteps, geometry: geometrySteps, pixel: pixelSteps } = verifiedByChannel;
				const verdict = !input.success
					? "failure"
					: unverified === 0
						? "success (goal check passed, all steps verified)"
						: `success (goal check passed; ${unverified}/${records.length} steps unverified)`;
				console.log(`\n=== DONE (${verdict}) after ${records.length} actions ===`);
				console.log(input.summary);
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				console.log(`stats: ${records.length} actions, ${elapsedSec}s, ${usage.modelCalls} model calls, ${usage.outputTokens} output tokens, grounding=${groundingMeta.provenance}, vision=${vision}, hintedPrompt=${audit.hinted}, homeReset=${homeReset}`);
				console.log(`verification: ${records.length - unverified}/${records.length} steps verified (${textSteps} by text, ${geometrySteps} by geometry, ${pixelSteps} by pixels only)${expectationRejections ? `, ${expectationRejections} call(s) rejected for missing checks` : ""}${finalCheck ? `; final goal check: ${finalCheck.verified ? "PASSED" : "failed"} (${finalCheck.evidence?.textIncludes?.join(", ") ?? ""})` : ""}`);
				if (visual && visual.verdict !== "PASS")
					console.log(`NOTE: visual judge returned ${visual.verdict} — text evidence passed, but the final frame did not independently confirm the goal.`);
				if (audit.hinted) console.log("NOTE: prompt contained method hints — NOT a clean autonomy result.");
				outcome = { success: input.success, finalCheck, visualCheck: visual, summary: input.summary };

				return;
			}

			const input = toolUse.input as { reasoning?: string; action: any; expectation: Expectation };
			console.log(`[${step}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			// OpenRouter does not always enforce required tool fields, so a missing
			// expectation arrives silently — and an unverifiable action that "worked"
			// is indistinguishable from one we simply never checked. Refuse to act
			// until the model commits to a checkable claim.
			const checkable = input.expectation?.textIncludes?.length || input.expectation?.textExcludes?.length;
			if (!checkable) {
				console.log("    -> ✗ rejected: no checkable expectation (textIncludes/textExcludes)");
				expectationRejections++;
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							is_error: true,
							content: [
								{
									type: "text",
									text:
										"ACTION NOT EXECUTED — your act call had no checkable expectation.\n" +
										"Every act call requires expectation.textIncludes and/or expectation.textExcludes: " +
										"concrete substrings that will appear (or disappear) in the NEXT observation's window " +
										"title, element labels, or element values.\n" +
										"A prose description alone cannot be verified, so the action was not performed. " +
										"Re-issue the same action with a checkable expectation.",
								},
							],
						},
					],
				});
				continue;
			}

			let resultText = "";
			let isError = false;
			let request: ActionRequest | null = null;
			try {
				request = dom ? await dom.toRequest(input.action) : toActionRequest(input.action, win);
			} catch (err) {
				// Unsupported action: report it back so the model can pick a real one.
				resultText = `ACTION REJECTED: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}

			const prevHaystack = obs.haystack;
			// The whole bundle, not just the derived views below: the mutation journal needs
			// the pre-action control VALUES, and `obs` is reassigned by the re-observation
			// before anything downstream could read them back.
			const prevObs = obs;
			const prevFrames = obs.frames;
			const prevShot = `${OUT}/agent-step-${step - 1}.png`;
			while (driverBusy) await new Promise((r) => setTimeout(r, 50));
			driverBusy = true;
			// Banner up only while the pointer is actually ours: this block is the whole
			// actuation window (act, settle, re-observe). It goes back down before the next
			// model call, which is most of the run's wall clock.
			overlay.setDriving(true);
			try {
				if (!isError) {
					try {
						resultText = request
							? (await driver.act(request)).text.slice(0, 400)
							: "waited (no driver action)";
					} catch (err) {
						resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
						isError = true;
					}
				}

				const settleMs = settleMsFor(input.action, SETTLE_MS);
				if (settleMs > SETTLE_MS) console.log(`    waiting ${Math.round(settleMs / 1000)}s before re-observing`);
				await new Promise((r) => setTimeout(r, settleMs));
				obs = await doObserve(`agent-step-${step}`);
				if (obs.appContent === 0) {
					// AX tree collapsed (e.g. a modal/other window took over). Acting now means
					// acting blind — stop rather than let the model flail against a menu bar.
					if (++blindStreak >= 3)
						throw new TargetNotObservableError(app, "no addressable elements for 3 consecutive observations");
				} else blindStreak = 0;
			} finally {
				driverBusy = false;
				overlay.setDriving(false);
			}
			// `wait` legitimately changes nothing, so exempt it from the discrimination
			// requirement (its point is that already-true state persists).
			let verdict: VerifyResult = isError
				? { verified: false, note: "action errored" }
				: verify(input.expectation, obs.haystack, input.action.name === "wait" ? undefined : prevHaystack);

			/**
			 * Fall back to weaker channels for a drag the text channel could not see.
			 *
			 * Only for drag, and only after text has failed: a painted target has no label to
			 * grep, so refusing the step outright would make canvas work impossible, while
			 * preferring weak evidence anywhere else would throw away the strong kind.
			 *
			 * Geometry before pixels, because it is the better evidence and costs nothing —
			 * the frames are already in the observation. A drag on painted content usually
			 * re-lays-out addressable content nearby, and a named element moving by the
			 * distance asked for is a far narrower claim than a region changing colour.
			 * Pixels remain for the case where nothing addressable sits near the target.
			 */
			if (!verdict.verified && !isError && input.action.name === "drag" && request?.kind === "tool") {
				const args = request.args as Record<string, number>;
				const g = framesShifted(prevFrames, obs.frames, args.to_x - args.from_x, args.to_y - args.from_y);
				const m = g.shifted
					? undefined
					: dragMoved(prevShot, `${OUT}/agent-step-${step}.png`, { x: args.from_x, y: args.from_y }, { x: args.to_x, y: args.to_y });
				if (g.shifted)
					verdict = {
						verified: true,
						channel: "geometry",
						note:
							`geometry evidence: ${g.movers.length} named element(s) moved by about the drag distance — ` +
							`${g.movers.slice(0, 3).map((v) => `"${v.name}" by (${Math.round(v.dx)},${Math.round(v.dy)})`).join(", ")}. ` +
							`The app re-laid-out addressable content, so the drag reached the document. This does NOT ` +
							`establish the dragged thing landed at the right position.`,
					};
				else if (m?.moved)
					verdict = {
						verified: true,
						channel: "pixel",
						note:
							`pixel evidence only: the origin changed by ${((m.origin ?? 0) * 100).toFixed(1)}% and the ` +
							`destination by ${((m.dest ?? 0) * 100).toFixed(1)}%, consistent with something moving between ` +
							`them. This does NOT establish it landed in the right place.`,
					};
			}
			// Advisory pixel signal: the AX text channel does not carry rendered content, so a
			// canvas that failed to repaint is invisible to verify(). Recorded, never a gate.
			const delta = pixelDelta(prevShot, `${OUT}/agent-step-${step}.png`);
			const deltaNote = delta === undefined ? "" : ` [pixels ${(delta * 100).toFixed(1)}%${delta < 0.001 && !isError ? " — screen essentially unchanged" : ""}]`;
			console.log(`    -> ${verdict.verified ? "✓ verified" : `✗ ${verdict.note}`}${deltaNote}`);

			records.push({
				index: step,
				timestamp: new Date().toISOString(),
				action: request ?? { kind: "tool", name: input.action.name, args: {} },
				expectation: input.expectation ?? { description: "(none provided)" },
				verified: verdict.verified,
				verificationChannel: verdict.channel,
				verificationNote: verdict.note,
				screenshotFile: `agent-step-${step}.png`,
				pixelDelta: delta,
				modelReasoning: input.reasoning,
			});

			// Journal what this step CHANGED, as opposed to what it was aimed at. Detection is
			// a value diff over the two observations rather than the model's own account of
			// what it did, for the same reason verification is: a run that reports its own
			// side effects can only restore the ones it noticed having.
			if (cleanupMode !== "off" && !isError) {
				const mutation = detectMutation(input.action, prevObs, obs, graph, step);
				if (mutation) {
					appendMutation(journalPath, mutation);
					console.log(
						`    journaled: "${mutation.control}"${mutation.surface ? ` in ${mutation.surface}` : ""} ` +
							`${JSON.stringify(mutation.before ?? "")} -> ${JSON.stringify(mutation.after ?? "")}` +
							`${mutation.scope ? ` [${mutation.scope}]` : ""}`,
					);
				}
			}

			// Advisory only — see FROZEN_STEPS. Printed at the crossing rather than every step
			// after it, so a long legitimate wait says this once instead of filling the log.
			const frozen = unpaintedStreak(records);
			if (frozen === FROZEN_STEPS)
				console.log(
					`    NOTE: ${FROZEN_STEPS} consecutive steps verified nothing and changed no pixels. Fine if you `
						+ "are waiting on the app to think; otherwise the window may not be repainting (target off the "
						+ "active Space or minimized, where Chromium suspends it while every driver call still reports success).",
				);

			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: isError,
						content: [
							{
								type: "text",
								text: `Driver result: ${resultText}\nVerification: ${verdict.verified ? "PASSED" : `FAILED — ${verdict.note}`}\n\nNew observation follows.`,
							},
							...observationBlocks(obs, vision),
						],
					},
				],
			});
		}

		console.log(`\n=== step limit (${MAX_STEPS}) reached without done ===`);
		outcome = { success: false, summary: "step limit reached" };
	} catch (err) {
		aborted = err;
	} finally {
		if (record) {
			recordingActive = false;
			await frameLoop;
			if (frameDrops.length > 0) {
				const counts = new Map<string, number>();
				for (const d of frameDrops) counts.set(d, (counts.get(d) ?? 0) + 1);
				for (const [reason, n] of counts) console.log(`frame drops x${n}: ${reason}`);
			}
			try {
				await driver.act({ kind: "tool", name: "stop_recording", args: {} });
			} catch {}
			try {
				assembleVideo(framesDir, frameTimes, videoPath);
			} catch (err) {
				console.error("video assembly failed:", err);
			}
		}

		/**
		 * Put the app back, AFTER the recording has been stopped and assembled just above.
		 *
		 * The order is the whole point. Teardown undoes exactly what the demo just
		 * demonstrated, so a frame of it in `window.mp4` turns the deliverable into a video of
		 * the agent changing its mind. The mp4 ends on the changed state; the restoration is
		 * data, kept in the run log and the journal, not footage.
		 *
		 * It sits in the `finally` rather than after a successful `done` so that the runs that
		 * most need it are covered: a step-limit exit or an abort leaves the app just as dirty
		 * as a success does, and those are the ones nobody is watching. The driver is still
		 * open here — `driver.close()` is deliberately below.
		 */
		if (cleanupMode !== "off" && !interrupted()) {
			try {
				const journal = readJournal(journalPath);
				if (journal.length || claimed.length) {
					overlay.setDriving(true);
					cleanupReport = await runTeardown({
						driver,
						client,
						model,
						app,
						journal,
						claimed,
						graph,
						steps: cleanupSteps,
						budget: CLEANUP_STEPS,
						mode: cleanupMode,
						vision,
						usage,
					});
					overlay.setDriving(false);
				}
			} catch (err) {
				// A failed teardown must never bury the run it was tidying up after. The task's
				// own result is already decided by this point; losing it to an exception thrown
				// while cleaning would be the worse outcome by far.
				cleanupReport = { mode: cleanupMode, error: err instanceof Error ? err.message : String(err) };
				console.error(`cleanup failed: ${cleanupReport.error}`);
			}
		}

		await driver.close();
		overlay.stop();

		/**
		 * The only place the log is written, and it is here — inside the finally, below the
		 * assembly — for two reasons.
		 *
		 * It catches every exit. An aborted run used to leave frames, an assembled mp4, and
		 * no log at all, so it was invisible to the gallery and, worse, invisible to any
		 * count of how often runs fail: every reliability figure we quoted was conditional
		 * on the run surviving long enough to write its own obituary.
		 *
		 * And it lands after the mp4 exists. The gallery lists a run only once the file its
		 * log names is really on disk, so writing the log first meant a finished run sat out
		 * a poll before appearing.
		 */
		if (aborted !== undefined)
			outcome = {
				success: false,
				summary: `aborted: ${aborted instanceof Error ? aborted.message : String(aborted)}`,
				aborted: true,
			};
		// CLEANUP=block makes a dirty exit a failed run. Opt-in, mirroring VISUAL_JUDGE: the
		// default keeps "did the task succeed" and "was the app left tidy" as separate
		// questions, because a demo that achieved its goal achieved it either way.
		if (outcome && cleanupMode === "block" && Number(cleanupReport?.failed ?? 0) > 0)
			outcome = {
				...outcome,
				success: false,
				summary: `${outcome.summary} — but cleanup left ${cleanupReport!.failed} change(s) in place (CLEANUP=block)`,
			};
		if (outcome) writeRunLog(outcome);
	}

	if (aborted !== undefined) throw aborted;
}

main().catch((err) => {
	console.error("agent failed:", err);
	process.exit(1);
});
