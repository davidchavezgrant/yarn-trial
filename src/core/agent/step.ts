import Anthropic from "@anthropic-ai/sdk";
import type { CdpBackend } from "../../backends/cdp.js";
import type { DomBackend } from "../../backends/dom.js";
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
	dom: DomBackend | undefined;
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
	const { driver, cdp, dom, win, app, doObserve, overlay, sync, rec, records, messages, vision, noAx, cleanupMode, journalPath, graph } = ctx;

	let resultText = "";
	let isError = false;
	let request: ActionRequest | null = null;

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
			// dom.toRequest is driver I/O (find → snapshot, plus an AX-centre probe), so
			// it belongs inside the mutex with the act itself: the recording frame
			// poller shares the driver, and a request resolved outside the hold
			// interleaves with its captures.
			if (cdp) {
				cdp.assertSupported(input.action.name);
				request = input.action.name === "wait" ? null : cdp.requestForLog(input.action);
			} else request = dom ? await dom.toRequest(input.action) : toActionRequest(input.action, win!);
		} catch (err) {
			// Unsupported action: report it back so the model can pick a real one.
			resultText = `ACTION REJECTED: ${err instanceof Error ? err.message : String(err)}`;
			isError = true;
		}

		if (!isError) {
			try {
				resultText = cdp
					? (await cdp.act(input.action)).slice(0, 400)
					: request
						? (await driver!.act(request)).text.slice(0, 400)
						: "waited (no driver action)";
			} catch (err) {
				resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}
			actedAt = Date.now();
		}

		const settleMs = settleMsFor(input.action, SETTLE_MS);
		if (settleMs > SETTLE_MS) console.log(`    waiting ${Math.round(settleMs / 1000)}s before re-observing`);
		await new Promise((r) => setTimeout(r, settleMs));
		ls.obs = await doObserve(`agent-step-${step}`);
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
	const curShot = ls.obs.screenshotB64 ? `${OUT}/agent-step-${step}.png` : undefined;
	ls.lastShot = curShot;
	// `wait` legitimately changes nothing, so exempt it from the discrimination
	// requirement (its point is that already-true state persists).
	let verdict: VerifyResult = isError
		? { verified: false, note: "action errored" }
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
			...(pointer && target && target.w > 0 ? { clickPoint: { x: target.x + target.w / 2, y: target.y + target.h / 2 } } : {}),
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
		...(target
			? {
					targetRole: target.role,
					targetRect: { x: target.x, y: target.y, w: target.w, h: target.h },
					targetName: target.name,
					...(target.namedBy ? { targetNamedBy: target.namedBy } : {}),
				}
			: {}),
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
						text: `Driver result: ${resultText}\nVerification: ${verdict.verified ? "PASSED" : `FAILED — ${verdict.note}`}\n\nNew observation follows.`,
					},
					...observationBlocks(ls.obs, vision, !noAx),
				],
			},
		],
	});
}
