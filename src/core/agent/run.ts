import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { CdpBackend } from "../../backends/cdp.js";
import { Driver } from "../driver.js";
import { envNum } from "../../env.js";
import {
	ACT_TOOL,
	checkableCount,
	DRIVER_RULES,
	ensureObservable,
	failedProvider,
	findScopeAmbiguities,
	findWindow,
	loadAppMapGraph,
	makeClient,
	observationBlocks,
	observe,
	onInterrupt,
	OUT,
	outputEffort,
	providerRouting,
	resetToHome,
	runKey,
	scopeWarnings,
	UNREADY_EXIT,
	verificationTallies,
	VISION_ONLY_RULES,
} from "../harness.js";
import type { HomeResetResult, ObservationBundle, WindowRef } from "../harness.js";
import { readJournal } from "../journal.js";
import { startOverlay } from "../overlay.js";
import { relToData } from "../../paths.js";
import { targetSlug, targetVocabulary } from "../target.js";
import { runTeardown } from "../teardown.js";
import type { Expectation, StepRecord } from "../../types.js";
import { parseCli } from "./cli.js";
import { gradeDone } from "./done.js";
import { loadGrounding } from "./grounding.js";
import { CLAIM_TOOL, DONE_TOOL, systemPrompt } from "./prompt.js";
import { type DriverSync, finishRecording, newRecording, startRecording } from "./recording.js";
import { executeAction, type StepLoopState } from "./step.js";

const MAX_STEPS = envNum("AGENT_STEPS", 15);
/**
 * Steps a single restore entry may spend before it is abandoned.
 *
 * Restoring is strictly easier than the task that caused it — the target value is already
 * known, so the harness writes the expectation instead of trusting one — and the route comes
 * from the appmap. A budget this small is therefore a real signal: an entry that cannot be
 * put back in ten steps is reporting that the control moved or the surface changed, which is
 * worth saying rather than grinding on.
 */
const CLEANUP_STEPS = envNum("CLEANUP_STEPS", 10);
/** Free read-only page searches per run, beyond which a find costs an action. */
const MAX_FINDS = envNum("AGENT_FINDS", 20);

export async function main(): Promise<void> {
	const { record, vision, noAx, judgeMode, backendKind, target, task, app, noReset, allowUnready, audit } = parseCli(
		process.argv.slice(2),
	);
	// The backend modules are reached ONLY through these imports, taken once the --backend
	// flag has selected one: a default ax run never loads src/backends/, so deleting that
	// directory must not break it. Type-only imports of the same modules elsewhere stay
	// static — they vanish at compile time.
	const cdpMod = backendKind === "cdp" ? await import("../../backends/cdp.js") : undefined;
	const domMod = backendKind === "dom" ? await import("../../backends/dom.js") : undefined;

	const { client, model } = makeClient();
	// Announce the takeover before the first action. A run seizes pointer and keyboard for
	// minutes and is otherwise indistinguishable from an idle machine, so anyone sitting in
	// front of it cannot tell when it is safe to type. OVERLAY=0 suppresses it for takes
	// where the banner would be in frame.
	const overlay = startOverlay("drive", `Agent driving ${app} — do not touch`);
	// The CDP backend runs with NO cua driver at all — that absence is its reason to exist
	// (no session TTL, no shared daemon, no consent gate; see src/backends/cdp.ts). Everything below
	// that needs the driver is therefore conditional on this being set.
	const driver = backendKind === "cdp" ? undefined : await Driver.start("agent");
	let cdp: CdpBackend | undefined;
	const interrupted = onInterrupt(async () => {
		await driver?.close();
		await cdp?.close();
	});
	const records: StepRecord[] = [];
	const startedAt = Date.now();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
	// Unique per run: a single overwritten agent-run.json forced hand-copying to preserve
	// A/B artifacts, which is how out/ab-grounded-script.json ended up a mislabeled
	// duplicate of a different run and its real numbers were lost.
	const stamp = runKey("", app);
	fs.mkdirSync(`${OUT}/runs`, { recursive: true });
	const runLog = `${OUT}/runs/${stamp}.json`;
	const sync: DriverSync = { busy: false, lastActionAt: 0 };
	let homeReset: string = noReset ? "skipped" : "pending";
	// Whether the axdom sidecar supplied DOM id/class this run. Recorded so a run's
	// element quality is legible from its log rather than inferred.
	let domEnrichment: { frames: number; unavailable?: string } = { frames: 0, unavailable: "not observed" };
	/**
	 * Window geometry, for a post-pass reconciling driver coordinates against the captured frames.
	 * Declared out here because `win` and the staging result are scoped to the try below, and the
	 * run log is written from the finally — the same reason homeReset above lives at this level.
	 */
	let windowGeometry: Record<string, unknown> | undefined;
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
					// What the MODEL was shown, so an A/B analysis reads arms off the logs
					// themselves instead of trusting a dispatch manifest.
					ax: !noAx,
					grounding: groundingMeta,
					hintedPrompt: audit.hinted,
					hintReasons: audit.reasons,
					homeReset,
					domEnrichment,
					windowGeometry,
					sessionRevivals: driver?.revivals ?? 0,
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
	const rec = newRecording();

	const slug = targetSlug(target);
	const grounding = loadGrounding(slug);
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
	const graph = grounding.notes ? loadAppMapGraph(slug) : undefined;
	const warnings = graph ? scopeWarnings(graph) : "";
	const ambiguities = graph ? findScopeAmbiguities(graph) : [];

	const basePrompt = systemPrompt(
		backendKind === "cdp" ? cdpMod!.CDP_RULES : backendKind === "dom" ? domMod!.DOM_RULES : noAx ? VISION_ONLY_RULES : DRIVER_RULES,
		vision,
		targetVocabulary(target),
		!noAx,
	);
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
	// find is DOM/CDP-only: on cua's DOM path it is the escape hatch from the semantic_v2
	// node budget; on the direct CDP path the tree is complete and find is just search. The
	// AX path has neither need (get_window_state returns the whole tree).
	const tools: Anthropic.Tool[] =
		backendKind === "cdp"
			? [cdpMod!.CDP_ACT_TOOL, cdpMod!.CDP_FIND_TOOL, CLAIM_TOOL, DONE_TOOL]
			: backendKind === "dom"
				? [domMod!.DOM_ACT_TOOL, domMod!.FIND_TOOL, CLAIM_TOOL, DONE_TOOL]
				: [ACT_TOOL, CLAIM_TOOL, DONE_TOOL];

	try {
		// A web target has no app to launch: the driver brings up its own Chromium against a
		// persistent profile and navigates it. See src/backends/browser.ts for why that profile, and
		// not the operator's own Chrome.
		// Reassigned by ensureObservable: recovering an unobservable target can relaunch it
		// onto a new window, and every later call must use that one.
		// On the CDP backend there is no driver and no window: the page is the target, and
		// acquisition (launch-or-attach, tab pick, navigate) lives in CdpBackend.acquire.
		let win: WindowRef | undefined;
		if (backendKind === "cdp") {
			cdp = await cdpMod!.CdpBackend.acquire(target);
		} else if (target.kind === "web") {
			// Loaded here, not at module top: the browser path is the only default-backend
			// route into src/backends/, and an app-target run must not depend on it existing.
			const { ensureBrowser } = await import("../../backends/browser.js");
			({ win } = await ensureBrowser(driver!, target, { cdp: backendKind === "dom" }));
		} else {
			await driver!.act({ kind: "tool", name: "launch_app", args: { name: app } });
			await new Promise((r) => setTimeout(r, 1500));
			win = await findWindow(driver!, app);
		}
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		// For the DOM backend the CDP bind is the observability gate; AX darkness is fine.
		const dom =
			backendKind === "dom"
				? await domMod!.DomBackend.bind(driver!, win!, undefined, target.kind === "web" ? target.origin : undefined)
				: undefined;
		if (!dom && !cdp) win = await ensureObservable(driver!, win!, app);
		// See the same call in src/core/explore.ts: page content only, on the AX fallback.
		const webAreaOnly = target.kind === "web";
		const doObserve = (name: string) =>
			cdp ? cdp.observe(name) : dom ? dom.observe(name) : observe(driver!, win!, name, { webAreaOnly });
		console.log(
			cdp
				? `target: ${app} url=${target.kind === "web" ? target.url : "(attached)"} backend=cdp`
				: `target: ${app} pid=${win!.pid} window=${win!.windowId} backend=${backendKind}`,
		);

		// Start from a declared home state, so a run never inherits the previous run's
		// navigation. --no-reset opts out (e.g. deliberately resuming mid-flow).
		// Runs on BOTH backends: resetToHome uses the AX path either way, and skipping it
		// for DOM made AX-vs-DOM comparisons uneven (one arm started from a declared home,
		// the other from wherever the previous run stopped).
		if (!noReset) {
			// The reset clicks, so it is actuation like any step.
			overlay.setDriving(true);
			// A web target's home state is its URL, so the CDP reset is a navigation — the
			// declared-home machinery below exists because a Mac app has no such address.
			// On the driver path, load the graph by the run's OWN slug, not resetToHome's
			// default of appSlug(app): a web target's map is stored under `web-<host>` while
			// `app` is the bare host, so the default lookup misses and every web run silently
			// starts from wherever the last one stopped. Loaded unconditionally (not gated on
			// grounding) to keep the A/B arms starting from the same normalised state.
			const reset = cdp
				? await cdp.goHome().then(
						(detail): { result: HomeResetResult; detail: string } => ({
							result: detail.startsWith("none") ? "none" : "reset",
							detail,
						}),
					)
				: await resetToHome(driver!, win!, app, loadAppMapGraph(slug));
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
					// process.exit skips the finally below, and an open session holds its 300s
					// TTL against the next job on this Mac — the unready path IS the fleet
					// path, so it must not leak one. The overlay covers itself with an exit
					// hook; the driver does not.
					await driver?.close().catch(() => {});
					process.exit(UNREADY_EXIT);
				}
				console.log("  WARNING: start state is whatever the previous run left behind — NOT comparable for A/B measurement.");
			}
		}
		console.log(`task: ${task}\n`);

		if (record) windowGeometry = await startRecording({ cdp, driver, win, app, overlay, recordingDir, framesDir, rec, sync });

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
		const ls: StepLoopState = {
			obs,
			// screenshotB64 is the "a frame really landed at this path" predicate: the DOM and
			// CDP observers tolerate a missed capture, and the CDP one never clears the path first.
			lastShot: obs.screenshotB64 ? `${OUT}/agent-step-0.png` : undefined,
			blindStreak: 0,
		};
		domEnrichment = { frames: obs.domEnriched, unavailable: obs.domUnavailable };
		console.log(`dom enrichment: ${obs.domEnriched} frames${obs.domUnavailable ? ` (${obs.domUnavailable})` : ""}`);
		const messages: Anthropic.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: `Task: ${task}\nTarget app: ${app}\n\nInitial observation follows.` },
					...observationBlocks(obs, vision, !noAx),
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
					...outputEffort(),
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
					while (sync.busy) await new Promise((r) => setTimeout(r, 50));
					sync.busy = true;
					const hits = await (cdp ?? dom!).find(q);
					sync.busy = false;
					text = hits.length
						? `find("${q}") matched ${hits.length}:\n` +
							hits
								.slice(0, 40)
								.map((r) => `[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}"${r.value && r.value !== r.name ? ` value="${r.value.slice(0, 60)}"` : ""} (${r.actions.join(",") || "no actions"}) ${r.visibility}`)
								.join("\n")
						: `find("${q}") matched nothing. Try a shorter or differently-worded string — matching is over role, accessible name, and visible text.`;
				} catch (err) {
					sync.busy = false;
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
				const graded = await gradeDone({
					toolUse,
					messages,
					records,
					sync,
					overlay,
					doObserve,
					client,
					model,
					judgeMode,
					task,
					usage,
					startedAt,
					groundingMeta,
					vision,
					noAx,
					audit,
					homeReset,
					expectationRejections,
				});
				// A rejected done (no evidence, judge veto, refuted check) has already pushed
				// its feedback onto the transcript; the turn continues.
				if (graded === undefined) continue;
				outcome = graded;

				return;
			}

			const input = toolUse.input as { reasoning?: string; action: any; expectation: Expectation };

			// Same provider gap as the expectation gate below: OpenRouter does not always
			// enforce required tool fields, so an act call can arrive with no action object at
			// all — and dereferencing action.name would abort the whole run for one bad turn.
			if (!input.action || typeof input.action.name !== "string") {
				console.log("    -> ✗ rejected: act call carried no action object");
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
										"ACTION NOT EXECUTED — the act call carried no action object. " +
										"Every act call needs an action with a string `name` plus its arguments. " +
										"Re-issue the call with a complete action.",
								},
							],
						},
					],
				});
				continue;
			}
			console.log(`[${step}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			// OpenRouter does not always enforce required tool fields, so a missing
			// expectation arrives silently — and an unverifiable action that "worked"
			// is indistinguishable from one we simply never checked. Refuse to act
			// until the model commits to a checkable claim.
			const checkable = checkableCount(input.expectation);
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

			// The vision-only arm never receives element handles, so an element_index in its act
			// call is a fabricated number — and executing it would actuate whatever element the
			// walk happens to put at that position, crediting the arm with an AX-addressed action
			// it could not have aimed. Rejected unexecuted, same shape as the expectation gate.
			if (noAx && input.action?.element_index !== undefined) {
				console.log("    -> ✗ rejected: element_index in a vision-only run");
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
										"ACTION NOT EXECUTED — you passed element_index, but this run has no element list; " +
										"any index is a guess. Address the target by screenshot pixel instead: x/y for clicks, " +
										"from_x/from_y/to_x/to_y for drags.",
								},
							],
						},
					],
				});
				continue;
			}

			await executeAction(
				{ driver, cdp, dom, win, app, doObserve, overlay, sync, rec, records, messages, vision, noAx, cleanupMode, journalPath, graph },
				ls,
				step,
				toolUse,
				input,
			);
		}

		console.log(`\n=== step limit (${MAX_STEPS}) reached without done ===`);
		outcome = { success: false, summary: "step limit reached" };
	} catch (err) {
		aborted = err;
	} finally {
		if (record) await finishRecording({ rec, driver, framesDir, videoPath });

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
						cdp,
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

		// Each cleanup step is isolated so no step can prevent the ones after it: a close()
		// rejection (a daemon already dead is a real failure class) must not replace the
		// run's own error, and the log write below must survive every exit.
		try {
			await driver?.close();
		} catch (err) {
			console.error("driver close failed:", err);
		}
		// Disconnects only — the browser stays up holding the signed-in profile (src/backends/cdp.ts).
		// Internally guarded (browser.close().catch), so it cannot reject past this line.
		await cdp?.close();
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
		// A teardown that THREW left `cleanupReport = { error }` with no `failed` count — the
		// maximally-dirty exit (nothing was restored) reading as zero failures. Block mode must
		// treat that as a dirty exit too, or CLEANUP=block passes exactly the run it exists to
		// fail.
		if (outcome && cleanupMode === "block") {
			const failedCount = Number(cleanupReport?.failed ?? 0);
			const crashed = cleanupReport?.error !== undefined;
			if (failedCount > 0)
				outcome = {
					...outcome,
					success: false,
					summary: `${outcome.summary} — but cleanup left ${failedCount} change(s) in place (CLEANUP=block)`,
				};
			else if (crashed)
				outcome = {
					...outcome,
					success: false,
					summary: `${outcome.summary} — but cleanup failed to run, so the app may be left modified (CLEANUP=block): ${cleanupReport!.error}`,
				};
		}
		if (outcome) writeRunLog(outcome);
	}

	if (aborted !== undefined) throw aborted;
}
