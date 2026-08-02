import Anthropic from "@anthropic-ai/sdk";
import type { CdpBackend } from "../../backends/cdp.js";
import type { Driver } from "../driver.js";
import {
	actionTarget,
	dragMoved,
	framesShifted,
	observationBlocks,
	OUT,
	pixelDelta,
	settleMsFor,
	TargetNotObservableError,
	toActionRequest,
	unpaintedStreak,
	verify,
} from "../harness.js";
import type { ObservationBundle, VerifyResult, WindowRef } from "../harness.js";
import { type DemoPlan, demoTranslatable, demoTranslate, freshSnapshot, type FreshSnapshot } from "../harness/fresh-target.js";
import { appendMutation, detectMutation } from "../journal.js";
import type { Overlay } from "../overlay.js";
import type { ActionRequest, AppMap, Expectation, StepRecord } from "../../types.js";
import type { DriverSync, Recording } from "./recording.js";

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
const SETTLE_MS = 900;
/** Driver yield between demo-sequence elements — just past the frame poller's post-action cadence (RESPONSE_POLL_MS in recording.ts), so mid-typing frames land. */
const CHUNK_GAP_MS = 150;
/**
 * The driver's CGEvent delivery counter ("delivered N of M character(s)"). Provably wrong:
 * turn-00007 of run 2026-07-31T05-45-03 reported "delivered 0 of 11" while the characters
 * had landed (the '#'s created two scenes). The old short-circuit to "action errored"
 * skipped verification and made the model retry — duplicate text on film — so the claim is
 * advisory on every run: attach it as a warning, re-observe, and let verify() decide.
 */
const DELIVERY_CLAIM = /delivered \d+ of \d+/;

/** Loop state the act-verify cycle reads and writes across steps. */
export interface StepLoopState {
	obs: ObservationBundle;
	/**
	 * The frame the LAST successful observation of THIS run wrote, or undefined when it
	 * wrote none. Never derived from the step number: rejected turns (no tool call, an
	 * unchecked expectation) consume a step without observing, out/ persists across runs,
	 * and a staged window keeps its dimensions run to run — so `agent-step-${step - 1}.png`
	 * can silently name a PREVIOUS run's frame, and every pixel channel downstream
	 * (pixelDelta, dragMoved, the trajectory copies) would compare against it.
	 */
	lastShot: string | undefined;
	blindStreak: number;
}

export interface StepContext {
	driver: Driver | undefined;
	cdp: CdpBackend | undefined;
	win: WindowRef | undefined;
	app: string;
	doObserve: (name: string) => Promise<ObservationBundle>;
	overlay: Overlay;
	sync: DriverSync;
	rec: Recording;
	records: StepRecord[];
	messages: Anthropic.MessageParam[];
	vision: boolean;
	noAx: boolean;
	cleanupMode: string;
	journalPath: string;
	graph: AppMap | undefined;
	/**
	 * Recorded-run demo actuation (AX backend): element clicks re-resolve against a fresh
	 * snapshot and land as real coordinate clicks, and type_text becomes a real click on the
	 * field followed by live chunked typing. Optional and default-off, so every existing
	 * caller behaves byte-identically until run.ts wires the flag.
	 */
	demo?: boolean;
	/**
	 * OUT-relative directory step screenshots land in (`runs/<stamp>-steps`). Optional so
	 * existing callers/tests keep the flat OUT/agent-step-N.png layout; run.ts always passes
	 * it, because the shared flat paths were overwritten by every later run and cross-run
	 * forensics ended up reading the wrong run's pixels.
	 */
	stepsDir?: string;
}

/**
 * Execute one accepted act call: dispatch it, settle, re-observe, verify, record the step,
 * and journal what it changed. The gates that can reject the call unexecuted (no action
 * object, no checkable expectation, element_index in a vision-only run) run in the caller,
 * before anything reaches here.
 */
export async function executeAction(
	ctx: StepContext,
	ls: StepLoopState,
	step: number,
	toolUse: Anthropic.ToolUseBlock,
	input: { reasoning?: string; action: any; expectation: Expectation },
): Promise<void> {
	const { driver, cdp, win, app, doObserve, overlay, sync, rec, records, messages, vision, noAx, cleanupMode, journalPath, graph } = ctx;
	// `agent-step-3` → `runs/<stamp>-steps/agent-step-3` when the caller namespaced the run.
	const shotName = (suffix: string) => (ctx.stepsDir ? `${ctx.stepsDir}/${suffix}` : suffix);

	let resultText = "";
	let isError = false;
	let request: ActionRequest | null = null;
	let plan: DemoPlan | null = null;
	let driverWarning: string | undefined;
	const typedChunks: Array<{ text: string; epochStartMs: number; epochEndMs: number }> = [];
	// Demo actuation is the AX driver path's concern: the CDP backend grows its own demo
	// variant in src/backends/cdp.ts, and the DOM backend has none.
	const demoMode = ctx.demo === true && !cdp;

	const prevHaystack = ls.obs.haystack;
	// The whole bundle, not just the derived views below: the mutation journal needs
	// the pre-action control VALUES, and `obs` is reassigned by the re-observation
	// before anything downstream could read them back.
	const prevObs = ls.obs;
	const prevFrames = ls.obs.frames;
	// Resolved HERE, against the observation the model actually chose from: `obs` is
	// reassigned to the post-action observation below, and element handles are only
	// meaningful in the snapshot that produced them.
	const target = actionTarget(input.action, ls.obs);
	/**
	 * Which of several identical twins this action operated, 0-based — recorded ONLY when
	 * name+role+surface genuinely fail to separate them.
	 *
	 * Yarn's Library has two controls named "New Draft". A compiled recipe described the target
	 * by identity alone, so replay could not tell them apart and correctly refused rather than
	 * guess — which stopped every no-rescue replay on step 1, 0/3 with zero model calls. The
	 * recording always knew which one it used; it simply never wrote it down.
	 *
	 * Undefined when identity already resolves, so a recipe carries an index only where an index
	 * is the last thing left. See RecipeTarget.ordinal for why that ordering matters.
	 */
	const targetOrdinal = ((): number | undefined => {
		if (!target) return undefined;
		const twins = ls.obs.interactive.filter((e) => e.name === target.name && e.role === target.role && e.surface === target.surface);
		if (twins.length < 2) return undefined;
		const at = twins.findIndex((e) => e.handle === target.handle);

		return at >= 0 ? at : undefined;
	})();
	const prevShot = ls.lastShot;
	while (sync.busy) await new Promise((r) => setTimeout(r, 50));
	sync.busy = true;
	// Banner up only while the pointer is actually ours: this block is the whole
	// actuation window (act, settle, re-observe). It goes back down before the next
	// model call, which is most of the run's wall clock.
	overlay.setDriving(true);
	const dispatchedAt = Date.now();
	let actedAt = dispatchedAt;
	try {
		try {
			// The CDP backend acts directly (no driver dispatch), so its "request" is
			// only what the run log records; the unsupported-verb check still runs here
			// so a bad name is rejected before anything executes, same as the others.
			if (cdp) {
				cdp.assertSupported(input.action.name);
				request = input.action.name === "wait" ? null : cdp.requestForLog(input.action);
			} else {
				// Recorded runs re-resolve element targets against ONE fresh snapshot — taken
				// inside the mutex so the recording frame poller cannot interleave — and act
				// by coordinate, never AXPress (whose "click" moves no pointer and may focus
				// nothing). A null plan means no demo variant; the normal path applies.
				if (demoMode && demoTranslatable(input.action)) {
					let snap: FreshSnapshot = { elements: [] };
					if (input.action.element_index !== undefined && target)
						try {
							snap = await freshSnapshot(driver!, win!, `${OUT}/${shotName(`agent-step-${step}-fresh`)}.png`);
						} catch {
							// Degrades to the stale rect and its centre — still a coordinate click.
						}
					plan = demoTranslate(input.action, win!, target, snap);
				}
				request = plan ? plan.logRequest : toActionRequest(input.action, win!);
			}
		} catch (err) {
			// Unsupported action: report it back so the model can pick a real one.
			resultText = `ACTION REJECTED: ${err instanceof Error ? err.message : String(err)}`;
			isError = true;
		}

		if (!isError) {
			if (plan) {
				// The demo sequence: one real driver call per element, the recording mutex
				// yielded between them so the frame poller lands mid-typing captures. Any
				// element failing stops the sequence and fails the step like a failed action.
				for (const [i, el] of plan.seq.entries()) {
					if (i > 0) {
						sync.busy = false;
						await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
						while (sync.busy) await new Promise((r) => setTimeout(r, 50));
						sync.busy = true;
					}
					const chunkStart = Date.now();
					try {
						await driver!.act(el.request);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						// An under-delivery claim on a chunk is advisory (see DELIVERY_CLAIM):
						// the characters usually landed, so the sequence continues.
						if (el.chunkText !== undefined && DELIVERY_CLAIM.test(msg)) driverWarning = msg.slice(0, 300);
						else {
							resultText = `ACTION FAILED at element ${i + 1}/${plan.seq.length}: ${msg}`;
							isError = true;

							break;
						}
					}
					sync.lastActionAt = Date.now();
					if (el.chunkText !== undefined) typedChunks.push({ text: el.chunkText, epochStartMs: chunkStart, epochEndMs: Date.now() });
				}
				if (!isError) {
					const parts: string[] = [];
					if (plan.clickPoint)
						parts.push(
							`clicked (${plan.clickPoint.x}, ${plan.clickPoint.y})${plan.target?.name ? ` on "${plan.target.name}"` : ""}` +
								`${plan.target?.source === "stale" ? " [stale rect — fresh re-resolution was ambiguous]" : ""}`,
						);
					if (typedChunks.length) parts.push(`typed ${typedChunks.length} chunk(s) as live keystrokes`);
					resultText = (parts.join("; ") || "demo actuation complete").slice(0, 400);
				}
			} else {
				try {
					resultText = cdp
						? (await cdp.act(input.action)).slice(0, 400)
						: request
							? (await driver!.act(request)).text.slice(0, 400)
							: "waited (no driver action)";
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (DELIVERY_CLAIM.test(msg)) {
						driverWarning = msg.slice(0, 300);
						resultText = "driver reported incomplete text delivery (advisory — see warning); the text frequently lands anyway";
					} else {
						resultText = `ACTION FAILED: ${msg}`;
						isError = true;
					}
				}
			}
			actedAt = Date.now();
		}

		const settleMs = settleMsFor(input.action, SETTLE_MS);
		if (settleMs > SETTLE_MS) console.log(`    waiting ${Math.round(settleMs / 1000)}s before re-observing`);
		await new Promise((r) => setTimeout(r, settleMs));
		ls.obs = await doObserve(shotName(`agent-step-${step}`));
		if (ls.obs.appContent === 0) {
			// AX tree collapsed (e.g. a modal/other window took over). Acting now means
			// acting blind — stop rather than let the model flail against a menu bar.
			if (++ls.blindStreak >= 3)
				throw new TargetNotObservableError(app, "no addressable elements for 3 consecutive observations");
		} else ls.blindStreak = 0;
	} finally {
		sync.busy = false;
		sync.lastActionAt = Date.now();
		overlay.setDriving(false);
	}
	// This step's frame, by the same predicate as step 0; becomes the next step's
	// "before". On the CDP path a missed capture leaves whatever file was already at
	// this path, so the path alone proves nothing.
	const curShot = ls.obs.screenshotB64 ? `${OUT}/${shotName(`agent-step-${step}`)}.png` : undefined;
	ls.lastShot = curShot;
	// `wait` legitimately changes nothing, so exempt it from the discrimination
	// requirement (its point is that already-true state persists).
	// The error TEXT rides along: it previously reached only the model, so a remote run's
	// console and run log said "action errored" five times while the reason (a refused
	// focus, a boxless target, a stale ref) was invisible to the operator diagnosing it.
	let verdict: VerifyResult = isError
		? { verified: false, note: `action errored: ${resultText.slice(0, 200)}` }
		: verify(input.expectation, ls.obs.haystack, input.action.name === "wait" ? undefined : prevHaystack);

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
		const g = framesShifted(prevFrames, ls.obs.frames, args.to_x - args.from_x, args.to_y - args.from_y);
		// A missing frame on either side skips the fallback outright: reaching for the
		// step-numbered path instead would let a previous run's frame at the same
		// staged dimensions fabricate `verified: true` on the pixel channel.
		const m = g.shifted || !prevShot || !curShot
			? undefined
			: dragMoved(prevShot, curShot, { x: args.from_x, y: args.from_y }, { x: args.to_x, y: args.to_y });
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
	// The trajectory turn for this action, now that both frames exist on disk. The
	// click point is the target's centre — playwright clicks element centres — in the
	// same CSS pixels as the frames, so no capture-width conversion applies downstream.
	// Errored actions are skipped for the same reason a failed driver call writes no
	// turn: animating a reach toward an action that never ran is fabrication. So is
	// wait — the driver path records no turn for it, because nothing was dispatched.
	if (rec.trajectory && !isError && input.action.name !== "wait") {
		const pointer = ["click", "right_click", "double_click", "hover"].includes(String(input.action.name));
		rec.trajectory.record({
			tool: String(input.action.name),
			args: request?.kind === "tool" ? request.args : {},
			// Demo steps carry the point that was ACTUALLY clicked, from the fresh snapshot —
			// including type_text, whose sequence starts with a real click on the field. On
			// the CDP path the same guarantee comes from lastActuation: point and box from
			// the ONE boundingBox call the pointer physically visited, cleared per act.
			...(plan?.clickPoint
				? { clickPoint: plan.clickPoint }
				: cdp?.lastActuation
					? { clickPoint: cdp.lastActuation.point }
					: pointer && target && target.w > 0
						? { clickPoint: { x: target.x + target.w / 2, y: target.y + target.h / 2 } }
						: {}),
			startedAtMs: dispatchedAt,
			endedAtMs: actedAt,
			// Both optional in the writer; a path is only passed when THIS run's frame
			// is known to sit there, so a stale file is never copied into the artifact.
			beforePng: prevShot,
			afterPng: curShot,
			resultSummary: resultText,
		});
	}
	// Advisory pixel signal: the AX text channel does not carry rendered content, so a
	// canvas that failed to repaint is invisible to verify(). Recorded, never a gate.
	// Skipped when either side lacks a real frame from THIS run — pixelDelta itself
	// only checks existence, which a previous run's file at the same path satisfies.
	const delta = prevShot && curShot ? pixelDelta(prevShot, curShot) : undefined;
	const deltaNote = delta === undefined ? "" : ` [pixels ${(delta * 100).toFixed(1)}%${delta < 0.001 && !isError ? " — screen essentially unchanged" : ""}]`;
	if (driverWarning) console.log(`    driver warning (advisory): ${driverWarning}`);
	console.log(`    -> ${verdict.verified ? "✓ verified" : `✗ ${verdict.note}`}${deltaNote}`);

	// Legible-on-film bookkeeping: a cmd/ctrl chord is invisible to a viewer, so recorded
	// runs tally them. Demo-gated so unrecorded run logs stay byte-identical.
	const chord =
		demoMode &&
		input.action.name === "press_key" &&
		Array.isArray(input.action.modifiers) &&
		input.action.modifiers.some((m: unknown) => /^(cmd|command|ctrl|control)$/i.test(String(m)));

	records.push({
		index: step,
		timestamp: new Date().toISOString(),
		action: request ?? { kind: "tool", name: input.action.name, args: {} },
		expectation: input.expectation ?? { description: "(none provided)" },
		verified: verdict.verified,
		verificationChannel: verdict.channel,
		verificationNote: verdict.note,
		screenshotFile: `${shotName(`agent-step-${step}`)}.png`,
		pixelDelta: delta,
		modelReasoning: input.reasoning,
		// Counted from the PRE-action observation — the one the model chose from. The
		// prompt renders elementsText lines (interactive plus labelled context), so the
		// line count IS what the model saw; a vision-only arm shows it none of them.
		observationNodes: prevObs.interactive.length,
		listShownToModel: noAx ? 0 : prevObs.elementsText ? prevObs.elementsText.split("\n").length : 0,
		/**
		 * WHERE in the offered list the model reached, not how long the list was. True
		 * attention weights are not exposed by any provider we call, so this is the honest
		 * proxy: the index it actually picked, against the length it was offered.
		 *
		 * It answers the question the observation budget turns on. If picks cluster near the
		 * top across an arm, most of the list is being paid for and ignored, and the budget
		 * can shrink; if picks land deep, the long list is doing real work and truncating it
		 * would break runs. That is a cost AND a reliability lever, and nothing else in the
		 * matrix distinguishes the two cases — a big list and a USED list look identical in
		 * observationNodes.
		 *
		 * Absent for vision-only steps and for actions that name no element (key presses,
		 * raw coordinate clicks): those did not choose from the list at all, and scoring them
		 * as index 0 would fake shallow attention.
		 */
		...(typeof input.action.element_index === "number" && prevObs.interactive.length > 0
			? { chosenIndex: input.action.element_index, chosenDepth: input.action.element_index / prevObs.interactive.length }
			: {}),
		// Demo steps record the FRESH target — the geometry that was actually clicked and
		// that the recording frames show — instead of the stale observation's rect.
		// `targetSurface` comes off the observation element in BOTH branches, including the demo
		// one: DemoPlan.target carries only the geometry it re-resolved, while the surface is a
		// property of the control in the tree and is the same either way. Recipe replay needs it
		// to separate two same-named controls (see StepRecord.targetSurface).
		...(plan?.target
			? {
					targetRole: plan.target.role,
					targetRect: { x: plan.target.x, y: plan.target.y, w: plan.target.w, h: plan.target.h },
					targetName: plan.target.name,
					...(target?.surface ? { targetSurface: target.surface } : {}),
					...(targetOrdinal !== undefined ? { targetOrdinal } : {}),
					...(target?.namedBy ? { targetNamedBy: target.namedBy } : {}),
				}
			: target
				? {
						targetRole: target.role,
						// A CDP demo act aimed at ONE freshly-resolved boundingBox (shared with
						// the click point above); that box supersedes the observation-time rect.
						targetRect: cdp?.lastActuation ? cdp.lastActuation.box : { x: target.x, y: target.y, w: target.w, h: target.h },
						targetName: target.name,
						...(target.surface ? { targetSurface: target.surface } : {}),
						...(targetOrdinal !== undefined ? { targetOrdinal } : {}),
						...(target.namedBy ? { targetNamedBy: target.namedBy } : {}),
					}
				: {}),
		// CDP demo typing is one pressSequentially call — real keystrokes, real frames —
		// so it is `typedLive` without chunk records; the humanizer spans the turn instead.
		...(plan?.typedLive || (ctx.demo === true && cdp && input.action.name === "type_text") ? { typedLive: true } : {}),
		...(typedChunks.length ? { typedChunks } : {}),
		...(driverWarning ? { driverWarning } : {}),
		...(chord ? { chord: true as const } : {}),
	});

	// Journal what this step CHANGED, as opposed to what it was aimed at. Detection is
	// a value diff over the two observations rather than the model's own account of
	// what it did, for the same reason verification is: a run that reports its own
	// side effects can only restore the ones it noticed having.
	if (cleanupMode !== "off" && !isError) {
		const mutation = detectMutation(input.action, prevObs, ls.obs, graph, step);
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
						text: `Driver result: ${resultText}${driverWarning ? `\nDriver warning (advisory): ${driverWarning} — this delivery counter is known to be unreliable; the verification verdict is authoritative.` : ""}\nVerification: ${verdict.verified ? "PASSED" : `FAILED — ${verdict.note}`}\n\nNew observation follows.`,
					},
					...observationBlocks(ls.obs, vision, !noAx),
				],
			},
		],
	});
}
