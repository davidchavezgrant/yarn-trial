import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { envNum } from "../env.js";
import {
	ACT_TOOL,
	DRIVER_RULES,
	makeClient,
	onInterrupt,
	teeConsole,
	VISION_ONLY_RULES,
} from "./harness.js";
import type { AxBackend } from "../backends/ax.js";
import type { CdpBackend } from "../backends/cdp.js";
import { readJournal } from "./journal.js";
import { startOverlay } from "./overlay.js";
import { targetVocabulary } from "./target.js";
import { runTeardown } from "./teardown.js";
import type { AppMap } from "../types.js";
import { checkpoint, coverageNow, hm, provenanceHeader } from "./explore/artifacts.js";
import { parseCli } from "./explore/cli.js";
import { DESCENT_ON, MAX_ACTIONS } from "./explore/config.js";
import { runExploreLoop } from "./explore/loop.js";
import { requestFinish } from "./explore/model.js";
import { CLAIM_TOOL, EXTRA_TOOLS, SURVEY_TOOL, systemPrompt, VISION_ACT_TOOL } from "./explore/prompt.js";
import { accumulatedGraph, newPass } from "./explore/state.js";
import { LIVE_DIR, RUN_FILES, outDir, runDir } from "../paths.js";

async function main(): Promise<void> {
	const { target, app, guidance, backendKind, vision, noAx } = parseCli();
	const { client, model, transport } = makeClient();
	// A grounding pass clicks through the whole app for minutes on end — same takeover as a
	// task run, and the same backend gate: a cdp pass never touches the operator's input,
	// so it shows no banner (backendSeizesInput in overlay.ts).
	const overlay = startOverlay("explore", `Agent exploring ${app} — do not touch`, backendKind);
	// Same posture as agent.ts: the CDP backend runs with no cua driver at all — that absence
	// is its reason to exist. Everything below that needs the driver is conditional on this.
	const driver = backendKind === "cdp" ? undefined : await Driver.start("explore");
	let cdp: CdpBackend | undefined;
	const interrupted = onInterrupt(async () => {
		await driver?.close();
		await cdp?.close();
	});
	const p = newPass(target, app, backendKind, vision, guidance, noAx);
	// Create the run's directory HERE, not in newPass. Constructing a Pass is a pure description
	// of what a run would be — tests build them by the handful — and a mkdir inside it put 21
	// empty run directories into the real out/ during one afternoon's test runs. The pass is only
	// a run once something is about to be written into it.
	fs.mkdirSync(`${outDir()}/${p.stepsDir}`, { recursive: true });
	// Same rule as the task agent: the pass's console output is one of its artifacts. The tee
	// stands down on the fleet, where the runner already owns log.txt via stdio redirection.
	teeConsole(p.stamp);

	try {
		/**
		 * COLD START. Quit the app before acquiring, so acquisition relaunches it and every
		 * pass begins from the same place.
		 *
		 * Explore never normalised its start state — resetToHome is the task agent's, and an
		 * exploration pass is the thing that DISCOVERS home, so on a first pass there is
		 * nothing to reset to. The cost showed up as soon as phase 1 ran more passes than
		 * Macs: wave 2 begins wherever wave 1 left that box, and the ax and cdp arms run
		 * TWICE specifically to measure run-to-run variance — which, unreset, would include
		 * start-state variance and measure the wrong thing.
		 *
		 * A kill is better than a navigate-home (David's suggestion, and it is the right one):
		 * it needs no map, so it behaves identically on all nine arms including tiers whose
		 * map has no home recorded; and it clears in-memory state a navigation cannot reach —
		 * open modals, scroll positions, undo stacks, half-filled fields.
		 *
		 * quitApp already asks politely, falls back to pkill, and verifies the process is
		 * gone. APP TARGETS ONLY: on a web target the "app" is the profile Chrome that HOLDS
		 * the signed-in session, and killing it between passes is how you turn a grounding run
		 * into a sign-in run. COLD_START=0 disables.
		 */
		if (target.kind === "app" && process.env.COLD_START !== "0") {
			const { quitApp } = await import("./appctl.js");
			try {
				await quitApp(app);
				console.log(`cold start: quit "${app}" — acquisition relaunches it`);
			} catch (err) {
				// Non-fatal: an app that will not quit is a dirtier start, not a dead run, and
				// the alternative is refusing to explore over a normalisation nicety.
				console.log(`cold start: could not quit "${app}" (${err instanceof Error ? err.message.slice(0, 80) : err}) — starting from the state it is in`);
			}
		}

		// On the CDP backend there is no driver and no window: the page is the target, and
		// acquisition (launch-or-attach, tab pick, navigate) lives in CdpBackend.acquire —
		// which is also the whole web-target story now that the driver-owned browser path
		// went with the dom backend (web targets default to cdp in the CLI). On the ax
		// backend acquisition and window state live in AxBackend (src/backends/ax.ts).
		// Backends load lazily at their selection branch so each stays independently
		// deletable — same seam as agent.ts and teardown.ts.
		let ax: AxBackend | undefined;
		if (backendKind === "cdp") {
			cdp = await (await import("../backends/cdp.js")).CdpBackend.acquire(target);
		} else if (target.kind === "web") {
			throw new Error("web targets explore on the cdp backend — pass --backend cdp (or omit it; web targets default there)");
		} else {
			ax = await (await import("../backends/ax.js")).AxBackend.acquire(target, driver!, app);
		}
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		if (!cdp) await ax!.ensureObservable();
		const doObserve = (name: string) => (cdp ? cdp.observe(name) : ax!.observe(name));
		// The claim tool is only offered under descent — a non-descent pass never creates
		// anything, so a claim ledger it can't act on is just a distraction in the prompt.
		// Descent is forced off on a vision-only pass (boundary reading is an element-identity
		// feature), so the claim tool goes with it.
		const descent = DESCENT_ON && !noAx;
		const extra = descent ? [...EXTRA_TOOLS, CLAIM_TOOL] : EXTRA_TOOLS;
		if (cdp) {
			const { CDP_ACT_TOOL, CDP_FIND_TOOL, CDP_RULES } = await import("../backends/cdp.js");
			p.tools = [CDP_ACT_TOOL, CDP_FIND_TOOL, ...extra];
			p.basePrompt = systemPrompt(CDP_RULES, targetVocabulary(target), descent, vision);
		} else if (noAx) {
			p.tools = [VISION_ACT_TOOL, SURVEY_TOOL, ...extra];
			p.basePrompt = systemPrompt(VISION_ONLY_RULES, targetVocabulary(target), descent, vision, true);
		} else {
			p.tools = [ACT_TOOL, ...extra];
			p.basePrompt = systemPrompt(DRIVER_RULES, targetVocabulary(target), descent, vision);
		}
		console.log(
			cdp
				? `exploring ${app} url=${target.kind === "web" ? target.url : "(attached)"} backend=cdp`
				: `exploring ${app} pid=${ax!.win.pid} window=${ax!.win.windowId} backend=${backendKind}`,
		);
		console.log(`ends when the frontier empties; no time cap, action backstop ${MAX_ACTIONS}\n`);

		await runExploreLoop({ p, client, model, overlay, interrupted, driver, cdp, win: ax?.win, doObserve });
	} catch (err) {
		/**
		 * A dead driver session must not also destroy the map.
		 *
		 * "finish" was the only thing that wrote an artifact, so any throw — a collapsed AX
		 * tree, the app quitting, the driver session ending — discarded the entire pass.
		 * Observed: a run died on action 15 of 25 having just found a settings panel an
		 * earlier pass had missed, and produced nothing at all. Five minutes of driving the
		 * machine, zero output, and the loss is silent because the previous appmap is still
		 * sitting on disk looking current.
		 *
		 * Emitting the map needs no driver — everything learned is already in the transcript
		 * and the accumulated graph. So ask for it: one model call, tool_choice pinned to
		 * finish. The stamp records that the pass was salvaged, because a map built from a
		 * truncated sweep is a weaker artifact than a completed one and the next reader
		 * should be able to tell.
		 */
		if (p.findings.length === 0 && p.graphNodes.size === 0) throw err;
		console.error(`\nexploration threw after ${p.actions} actions: ${err instanceof Error ? err.message : String(err)}`);
		console.log(`salvaging ${p.findings.length} findings and ${p.graphNodes.size} graph nodes — no driver needed for this`);
		checkpoint(p);

		// The throw may have left an assistant tool_use unanswered; the API rejects that.
		const last = p.messages[p.messages.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content)) {
			const dangling = last.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			if (dangling)
				p.messages.push({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: dangling.id, is_error: true, content: "The driver session ended; that action did not run." }],
				});
		}

		try {
			await requestFinish(
				p,
				client,
				model,
				"The driver session has ended, so no further actions are possible and you will get no more observations. " +
					"Call finish NOW and emit the best map you can from what you already saw. Do not describe surfaces you never opened — " +
					"an incomplete map is fine, an invented one is not.",
				"error",
				true,
			);
		} catch (rescueErr) {
			// Last resort: the raw findings, unshaped — and to the salvage files, never
			// docs/appmaps/: overwriting the committed .md alone would leave the committed
			// .json pairing a proseSha256 that no longer matches the prose beside it.
			console.error(`salvage call failed: ${rescueErr instanceof Error ? rescueErr.message : String(rescueErr)}`);
			fs.writeFileSync(
				p.appmapProsePath,
				provenanceHeader({
					app: p.app,
					actions: p.actions,
					elapsed: hm(Date.now() - p.startedAt),
					findings: p.findings.length,
					backend: p.backendKind,
					findCalls: p.findCalls,
					vision: p.vision,
					visionOnly: p.visionOnly,
					guidance: p.guidance,
					salvaged: true,
					...coverageNow(p, "error"),
				}) + `# ${p.app} — grounding notes (raw findings only)\n\n${p.findings.map((f) => `- ${f}`).join("\n")}`,
			);
			const rawGraph: AppMap = {
				app: p.app,
				capturedAt: new Date().toISOString(),
				provenance: p.visionOnly ? "explore-vision" : "explore",
				coverage: coverageNow(p, "error"),
				nodes: [...p.graphNodes.values()],
				edges: [...p.graphEdges.values()],
				...(p.gated.length ? { gated: p.gated } : {}),
			};
			fs.mkdirSync(runDir(p.stamp), { recursive: true });
			fs.writeFileSync(p.appmapGraphPath, JSON.stringify(rawGraph, null, 2));
			console.log(`wrote ${p.findings.length} raw findings to ${p.appmapProsePath}`);
			console.log(`graph: ${p.appmapGraphPath} (${rawGraph.nodes.length} nodes); promote by hand if it is the better map:`);
			console.log(`  cp ${p.appmapProsePath} ${p.outPath}`);
			console.log(`  cp ${p.appmapGraphPath} ${p.graphPath}`);
		}
	} finally {
		// Put the app back BEFORE closing the backends — teardown needs one of them. Wrapped so
		// a teardown failure never buries the map the pass already wrote, exactly as the task
		// agent guards its own cleanup. Teardown takes exactly one of driver/cdp, so it
		// restores through whichever backend drove the pass.
		//
		// No longer gated on descent. The old reasoning — "a refuse-everything pass mutates
		// nothing to restore, and its journal is empty anyway" — stopped being true the moment
		// the prompt started telling the pass that changing settings is free BECAUSE they are
		// restored. It is now the mechanism that makes that promise honest, and an empty
		// journal makes it a no-op anyway.
		{
			try {
				const journal = readJournal(p.journalPath);
				const settings = journal.filter((m) => m.kind === "setting");
				if (settings.length || p.claimed.length) {
					console.log(`\n=== descent cleanup: ${settings.length} mutation(s), ${p.claimed.length} claimed resource(s) ===`);
					overlay.setDriving(true);
					const report = await runTeardown({
						stepsDir: `${LIVE_DIR}/${p.stamp}/${RUN_FILES.steps}`,
						...(cdp ? { cdp } : { driver: driver! }),
						client,
						model,
						app,
						journal,
						claimed: p.claimed,
						graph: accumulatedGraph(p),
						steps: [],
						budget: envNum("CLEANUP_STEPS", 10),
						mode: "explore-descent",
						vision,
						usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 },
					});
					overlay.setDriving(false);
					const dirty = Array.isArray(report.dirty) ? report.dirty.length : 0;
					console.log(`cleanup: ${report.restored ?? 0} restored, ${report.failed ?? 0} failed, ${dirty} still dirty` + (p.claimed.length ? `; ${p.claimed.length} scratch resource(s) reported, not deleted` : ""));
				}
			} catch (err) {
				console.error(`descent cleanup failed (map already written): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		await driver?.close();
		// Disconnects only — the browser stays up holding the signed-in profile (src/backends/cdp.ts).
		await cdp?.close();
		overlay.stop();
	}
}

main().catch((err) => {
	console.error("explore failed:", err);
	process.exit(1);
});
