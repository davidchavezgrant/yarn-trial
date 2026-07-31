import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { envNum } from "../env.js";
import {
	ACT_TOOL,
	DRIVER_RULES,
	ensureObservable,
	findWindow,
	makeClient,
	observe,
	onInterrupt,
	VISION_ONLY_RULES,
	type WindowRef,
} from "./harness.js";
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

async function main(): Promise<void> {
	const { target, app, guidance, backendKind, vision, noAx } = parseCli();
	const { client, model } = makeClient();
	// A grounding pass clicks through the whole app for minutes on end — same takeover as a
	// task run, different colour so the mode is readable at a glance.
	const overlay = startOverlay("explore", `Agent exploring ${app} — do not touch`);
	// Same posture as agent.ts: the CDP backend runs with no cua driver at all — that absence
	// is its reason to exist. Everything below that needs the driver is conditional on this.
	const driver = backendKind === "cdp" ? undefined : await Driver.start("explore");
	let cdp: CdpBackend | undefined;
	const interrupted = onInterrupt(async () => {
		await driver?.close();
		await cdp?.close();
	});
	const p = newPass(target, app, backendKind, vision, guidance, noAx);

	try {
		// On the CDP backend there is no driver and no window: the page is the target, and
		// acquisition (launch-or-attach, tab pick, navigate) lives in CdpBackend.acquire —
		// which is also the whole web-target story now that the driver-owned browser path
		// went with the dom backend (web targets default to cdp in the CLI).
		// Backends load lazily at their selection branch so src/backends/ stays deletable
		// without breaking default ax explores — same seam as agent.ts and teardown.ts.
		let win: WindowRef | undefined;
		if (backendKind === "cdp") {
			cdp = await (await import("../backends/cdp.js")).CdpBackend.acquire(target);
		} else if (target.kind === "web") {
			throw new Error("web targets explore on the cdp backend — pass --backend cdp (or omit it; web targets default there)");
		} else {
			await driver!.act({ kind: "tool", name: "launch_app", args: { name: app } });
			await new Promise((r) => setTimeout(r, 1500));
			// Reassigned by ensureObservable — see the same call in src/core/agent.ts.
			win = await findWindow(driver!, app);
		}
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		if (!cdp) win = await ensureObservable(driver!, win!, app);
		const doObserve = (name: string) => (cdp ? cdp.observe(name) : observe(driver!, win!, name, {}));
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
				: `exploring ${app} pid=${win!.pid} window=${win!.windowId} backend=${backendKind}`,
		);
		console.log(`ends when the frontier empties; no time cap, action backstop ${MAX_ACTIONS}\n`);

		await runExploreLoop({ p, client, model, overlay, interrupted, driver, cdp, win, doObserve });
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
				p.salvageProsePath,
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
			fs.writeFileSync(p.salvageGraphPath, JSON.stringify(rawGraph, null, 2));
			console.log(`wrote ${p.findings.length} raw findings to ${p.salvageProsePath}`);
			console.log(`graph: ${p.salvageGraphPath} (${rawGraph.nodes.length} nodes); promote by hand if it is the better map:`);
			console.log(`  cp ${p.salvageProsePath} ${p.outPath}`);
			console.log(`  cp ${p.salvageGraphPath} ${p.graphPath}`);
		}
	} finally {
		// Put the app back BEFORE closing the backends — teardown needs one of them. Only under
		// descent: a refuse-everything pass mutates nothing to restore, and its journal is empty
		// anyway. Wrapped so a teardown failure never buries the map the pass already wrote,
		// exactly as the task agent guards its own cleanup. Teardown takes exactly one of
		// driver/cdp, so it restores through whichever backend drove the pass.
		if (DESCENT_ON) {
			try {
				const journal = readJournal(p.journalPath);
				const settings = journal.filter((m) => m.kind === "setting");
				if (settings.length || p.claimed.length) {
					console.log(`\n=== descent cleanup: ${settings.length} mutation(s), ${p.claimed.length} claimed resource(s) ===`);
					overlay.setDriving(true);
					const report = await runTeardown({
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
