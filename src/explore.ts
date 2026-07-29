import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Driver } from "./driver.js";
import {
	ACT_TOOL,
	appSlug,
	assertObservable,
	DRIVER_RULES,
	findScopeAmbiguities,
	findWindow,
	makeClient,
	observationBlocks,
	observe,
	TargetNotObservableError,
	toActionRequest,
} from "./harness.js";
import { DOM_ACT_TOOL, DOM_RULES, DomBackend, FIND_TOOL } from "./dom.js";
import { startOverlay } from "./overlay.js";
import type { AppMap, AppMapEdge, AppMapNode } from "./types.js";

const MAX_STEPS = Number(process.env.EXPLORE_STEPS ?? 25);
const SETTLE_MS = 900;

/** The payload of the "finish" tool — the pass's entire output, prose plus graph. */
type FinishInput = { document: string; nodes?: AppMapNode[]; edges?: AppMapEdge[] };

const systemPrompt = (rules: string): string => `You are an exploration agent building grounding notes for a macOS app, so a future task-running agent can navigate it directly without dead ends. You drive the app through a UI driver: each turn you receive the window's elements (addressing handle, role, label/value) and a screenshot, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the app's main surfaces — menus, settings panels and their tabs, context menus on notable controls, pickers — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions: no deleting, no sending/sharing, no account or sync changes, no creating events/documents you can't discard, no toggling settings you don't revert.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- Leave the app in the state you found it.

${rules}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end.

Breadth before depth. A map with one richly-detailed region and whole panels never opened is worse than an even one, because the task agent cannot tell the difference between "not in this app" and "not visited". Before you finish, every settings-bearing surface the app offers should have been opened at least once — each tab of a settings page, each section of a preferences area, each context menu on a distinct kind of object. Depth on any one region is worth spending steps on only once that sweep is done.

When your step budget is spent or coverage is good, call "finish" with BOTH artifacts:

1. "document" — the prose grounding document in markdown: a "Layout" section (main surfaces and how to reach them), a "How to" section (task recipes as exact interaction sequences), and a "Dead ends & quirks" section. Be specific and terse — this document is injected into the task agent's prompt.

2. "nodes" + "edges" — the same knowledge as a graph, for code to query.

On the graph, one thing matters more than completeness: SCOPE. Many apps let the same setting be changed in more than one place — an app-wide or brand-wide default, and a per-document override — and these are usually separate stores, so changing one does not change the other. An agent that changes the wrong one appears to succeed. When you find a control, ask "whose state does this change?" and set "scope" accordingly. If you find the same underlying setting exposed in two places, give BOTH controls the identical "settingKey" and their own distinct "scope". That pairing is what lets the harness warn the next agent.

Go looking for those pairs rather than waiting to stumble on them. Whenever you find a panel of defaults, spend steps hunting for where the same settings are overridden for a single document — and vice versa. A pair you never looked for is indistinguishable, in the finished map, from a setting that genuinely lives in one place, and it is the failure the next agent cannot detect on its own.`;

const EXTRA_TOOLS: Anthropic.Tool[] = [
	{
		name: "record",
		description: "Record one finding for the grounding notes.",
		input_schema: {
			type: "object",
			properties: { finding: { type: "string" } },
			required: ["finding"],
		},
	},
	{
		name: "finish",
		description:
			"End exploration and emit BOTH artifacts: the prose grounding document (read by the task agent) and the structured graph (queried by code).",
		input_schema: {
			type: "object",
			properties: {
				document: { type: "string", description: "The prose grounding document (markdown), as described in your instructions." },
				nodes: {
					type: "array",
					description:
						"Every surface you visited and every notable control you found. Controls that edit the same underlying setting from different places MUST share a settingKey and differ in scope — that is how the harness detects scope ambiguity.",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: 'Stable slug path, e.g. "brand-kit/screen-clips" or "brand-kit/screen-clips/cursor-style".' },
							title: { type: "string" },
							kind: { type: "string", enum: ["surface", "control"] },
							scope: {
								type: "string",
								enum: ["app", "workspace", "brand", "document", "unknown"],
								description:
									"Whose state this changes. A per-document override is 'document'; an app-wide or brand-wide default is 'app'/'workspace'/'brand'. Use 'unknown' only if you genuinely could not tell.",
							},
							settingKey: {
								type: "string",
								description:
									'Controls only: identity of the SETTING itself, independent of where it is edited, e.g. "cursor-style". Two controls editing the same setting at different scopes MUST use the identical settingKey.',
							},
							options: { type: "array", items: { type: "string" }, description: "Selectable values, for enumerable controls." },
							notes: { type: "string" },
						},
						required: ["id", "title", "kind", "scope"],
					},
				},
				edges: {
					type: "array",
					description: "How to reach each surface from another.",
					items: {
						type: "object",
						properties: {
							from: { type: "string", description: "Source node id (use \"root\" for the app's initial surface)." },
							to: { type: "string", description: "Destination node id." },
							action: { type: "string", description: 'How to traverse, e.g. \'click "Brand Kit"\'.' },
						},
						required: ["from", "to", "action"],
					},
				},
			},
			required: ["document", "nodes", "edges"],
		},
	},
];

/**
 * Machine-readable stamp distinguishing autonomous exploration output from
 * hand-curated notes. loadGrounding() in agent.ts treats unstamped appmaps as
 * "curated" and the run log records the difference — hand edits to a stamped
 * file MUST remove the stamp (or move the file to docs/recipes/).
 */
const provenanceHeader = (
	app: string,
	actions: number,
	findings: number,
	backend: string,
	findCalls: number,
	guidance?: string,
	salvaged = false,
): string =>
	`<!-- provenance: explore | app: ${app} | date: ${new Date().toISOString().slice(0, 10)} | backend: ${backend} | actions: ${actions} | findings: ${findings} | finds: ${findCalls}${guidance ? " | operator-guidance: yes" : ""}${salvaged ? " | salvaged: session died before finish" : ""} -->\n` +
	"<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->\n\n";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const backendIdx = argv.indexOf("--backend");
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : "ax";
	const positional = argv.filter((_, i) => backendIdx < 0 || (i !== backendIdx && i !== backendIdx + 1));
	const app = positional[0] ?? "Notion Calendar";
	// Optional per-run guidance: relaxes or tightens the safety rules for this app
	// (e.g. "creating a draft is allowed; use <address> if a form needs an email").
	const guidance = positional[1];
	if (!["ax", "dom"].includes(backendKind)) {
		console.error('usage: tsx src/explore.ts ["App Name"] ["guidance"] [--backend ax|dom]');
		process.exit(1);
	}
	const { client, model } = makeClient();
	// A grounding pass clicks through the whole app for minutes on end — same takeover as a
	// task run, different colour so the mode is readable at a glance.
	const overlay = startOverlay("explore", `Agent exploring ${app} — do not touch`);
	const driver = await Driver.start("explore");
	const findings: string[] = [];
	const outPath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.md`;
	const graphPath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.json`;
	fs.mkdirSync(`${process.cwd()}/docs/appmaps`, { recursive: true });

	// Declared out here, not in the try, because the salvage path in the catch needs them:
	// the transcript IS the pass's memory, and a throw must not put it out of reach.
	const messages: Anthropic.MessageParam[] = [];
	let tools: Anthropic.Tool[] = [];
	let basePrompt = "";
	let actions = 0;
	let findCalls = 0;

	const writeArtifacts = (out: FinishInput, noteCount: number, salvaged = false): void => {
		const prose = provenanceHeader(app, actions, noteCount, backendKind, findCalls, guidance, salvaged) + out.document;
		fs.writeFileSync(outPath, prose);
		console.log(`\n=== exploration ${salvaged ? "SALVAGED" : "finished"} after ${actions} actions, ${noteCount} findings ===`);
		console.log(`grounding notes: ${outPath}`);

		const graph: AppMap = {
			app,
			capturedAt: new Date().toISOString(),
			provenance: "explore",
			proseSha256: createHash("sha256").update(prose).digest("hex").slice(0, 12),
			nodes: out.nodes ?? [],
			edges: out.edges ?? [],
		};
		fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
		const ambiguities = findScopeAmbiguities(graph);
		console.log(`structured graph: ${graphPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
		if (ambiguities.length > 0) {
			console.log(`scope ambiguities found (${ambiguities.length}) — the task agent will be warned about these:`);
			for (const a of ambiguities)
				console.log(`  · ${a.settingKey}: ${a.nodes.map((n) => `${n.id} [${n.scope}]`).join(" vs ")}`);
		}
	};

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		// Exploration runs once and its whole purpose is coverage, so it exhausts the
		// continuation chain on every observation — the opposite tradeoff from the agent
		// loop, which re-observes after every action and pays per-step for depth.
		const dom = backendKind === "dom" ? await DomBackend.bind(driver, win, Infinity) : undefined;
		if (!dom) await assertObservable(driver, win, app);
		const doObserve = (name: string) => (dom ? dom.observe(name, Infinity) : observe(driver, win, name));
		tools = dom ? [DOM_ACT_TOOL, FIND_TOOL, ...EXTRA_TOOLS] : [ACT_TOOL, ...EXTRA_TOOLS];
		basePrompt = systemPrompt(dom ? DOM_RULES : DRIVER_RULES);
		console.log(`exploring ${app} pid=${win.pid} window=${win.windowId} backend=${backendKind}\n`);

		let blindStreak = 0;
		// Same handoff as the loop below: the banner starts visible and only a setDriving(false)
		// takes it down, so the opening observation has to be the thing that lowers it — else it
		// sits red through the first (long) model call with the machine idle.
		overlay.setDriving(true);
		let obs: Awaited<ReturnType<typeof doObserve>>;
		try {
			obs = await doObserve("explore-step-0");
		} finally {
			overlay.setDriving(false);
		}
		messages.push({
			role: "user",
			content: [
				{ type: "text", text: `Explore "${app}". Step budget: ${MAX_STEPS} actions. Initial observation follows.` },
				...observationBlocks(obs),
			],
		});

		// One-shot: an early finish is bounced back once for a coverage self-audit, and
		// whatever comes next is accepted. See the challenge text below for why.
		let coverageChallenged = false;
		for (let turn = 1; turn <= MAX_STEPS * 2; turn++) {
			const response = await client.messages.create({
				model,
				max_tokens: 16000,
				system: guidance ? `${basePrompt}\n\n# Operator guidance for this run\n${guidance}` : basePrompt,
				tools,
				cache_control: { type: "ephemeral" },
				messages,
			});

			if (response.stop_reason === "refusal") throw new Error("model refused");

			const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			messages.push({ role: "assistant", content: response.content });

			if (!toolUse) {
				messages.push({ role: "user", content: "Call exactly one tool (act, record, or finish)." });
				continue;
			}

			/**
			 * Challenge an early finish once, then take the answer either way.
			 *
			 * "Coverage is good" is the model's own unexamined judgement, and it is reached
			 * from inside a transcript that necessarily contains only surfaces already
			 * visited — the panels never opened are exactly the ones absent from the context
			 * informing the call. Observed: a pass with 60% of its budget unspent finished
			 * having swept one region deeply, and the resulting map lost an entire settings
			 * panel that a previous pass had found. The map cannot express that gap, so the
			 * task agent reads "not present in this app".
			 *
			 * Asking costs one turn, no action, and no app-specific knowledge — it names the
			 * CLASS of thing to re-check, never a particular surface. Once only: a second
			 * refusal would be badgering, and a model that has genuinely finished should be
			 * able to say so and be believed.
			 */
			if (toolUse.name === "finish" && !coverageChallenged && actions < MAX_STEPS) {
				coverageChallenged = true;
				console.log(`  finish at ${actions}/${MAX_STEPS} actions — asking for a coverage self-audit first`);
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							content:
								`Before this is accepted: you have ${MAX_STEPS - actions} of ${MAX_STEPS} actions left, so budget is not what is ending the run.\n\n` +
								"List the settings-bearing surfaces this app offers — every tab of every settings or preferences area, every distinct kind of object with a context menu — and mark which you actually OPENED versus inferred. Then answer: for each panel of defaults you found, did you look for where those same settings are overridden for a single document, or the reverse?\n\n" +
								"If anything is unopened, go open it — that is what the remaining budget is for. If coverage really is complete, call finish again and it will be accepted.",
						},
					],
				});
				continue;
			}

			if (toolUse.name === "finish") {
				writeArtifacts(toolUse.input as FinishInput, findings.length);

				return;
			}

			if (toolUse.name === "record") {
				const finding = (toolUse.input as { finding: string }).finding;
				findings.push(finding);
				console.log(`  note: ${finding}`);
				messages.push({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: toolUse.id, content: `recorded (${findings.length} total)` }],
				});
				continue;
			}

			// Read-only page search: costs a turn but not an action, like record.
			if (toolUse.name === "find") {
				const q = (toolUse.input as { query: string }).query;
				let text: string;
				try {
					const hits = await dom!.find(q);
					text = hits.length
						? `find("${q}") matched ${hits.length}:\n` +
							hits
								.slice(0, 40)
								.map((r) => `[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}" (${r.actions.join(",") || "no actions"}) ${r.visibility}`)
								.join("\n")
						: `find("${q}") matched nothing. Try a shorter or differently-worded string.`;
				} catch (err) {
					text = `find("${q}") failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
				}
				findCalls++;
				console.log(`  find "${q}" -> ${text.split("\n")[0]}`);
				messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: text }] });
				continue;
			}

			const input = toolUse.input as { reasoning?: string; action: any };
			actions++;
			console.log(`[${actions}/${MAX_STEPS}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			let resultText: string;
			let isError = false;
			// Banner up only while the pointer is ours. Exploration is as intrusive as a task
			// run, and just as thinking-dominated, so it gets the same treatment: visible for
			// the act/settle/re-observe window, hidden for the model call between.
			overlay.setDriving(true);
			try {
				try {
					const request = dom ? await dom.toRequest(input.action) : toActionRequest(input.action, win);
					resultText = request
						? (await driver.act(request)).text.slice(0, 400)
						: "waited (no driver action)";
				} catch (err) {
					resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
					isError = true;
				}

				await new Promise((r) => setTimeout(r, SETTLE_MS));
				obs = await doObserve(`explore-step-${actions}`);
			} finally {
				// finally, not a trailing call: a throw from doObserve (a collapsed AX tree is
				// routine here) would otherwise strand the banner up for the rest of the pass.
				overlay.setDriving(false);
			}
				if (obs.appContent === 0) {
					// AX tree collapsed (e.g. a modal/other window took over). Acting now means
					// acting blind — stop rather than let the model flail against a menu bar.
					if (++blindStreak >= 3)
						throw new TargetNotObservableError(app, "no addressable elements for 3 consecutive observations");
				} else blindStreak = 0;

			const budgetNote =
				actions >= MAX_STEPS
					? "\nSTEP BUDGET EXHAUSTED — call finish with the grounding document now."
					: `\n${MAX_STEPS - actions} actions remaining.`;
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: isError,
						content: [
							{ type: "text", text: `Driver result: ${resultText}${budgetNote}\n\nNew observation follows.` },
							...observationBlocks(obs),
						],
					},
				],
			});
		}

		// Turn limit without finish — salvage what we have.
		fs.writeFileSync(
			outPath,
			provenanceHeader(app, actions, findings.length, backendKind, findCalls, guidance) +
				`# ${app} — grounding notes (partial)\n\n${findings.map((f) => `- ${f}`).join("\n")}`,
		);
		console.log(`\n=== turn limit reached; wrote ${findings.length} raw findings ===`);
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
		 * Emitting the map needs no driver — everything learned is already in the transcript.
		 * So ask for it: one model call, tool_choice pinned to finish. The stamp records that
		 * the pass was salvaged, because a map built from a truncated sweep is a weaker
		 * artifact than a completed one and the next reader should be able to tell.
		 */
		if (findings.length === 0) throw err;
		console.error(`\nexploration threw after ${actions} actions: ${err instanceof Error ? err.message : String(err)}`);
		console.log(`salvaging ${findings.length} findings into a map — no driver needed for this`);

		// The throw may have left an assistant tool_use unanswered; the API rejects that.
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content)) {
			const dangling = last.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			if (dangling)
				messages.push({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: dangling.id, is_error: true, content: "The driver session ended; that action did not run." }],
				});
		}
		messages.push({
			role: "user",
			content:
				"The driver session has ended, so no further actions are possible and you will get no more observations. " +
				"Call finish NOW and emit the best map you can from what you already saw. Do not describe surfaces you never opened — " +
				"an incomplete map is fine, an invented one is not.",
		});

		try {
			const rescue = await client.messages.create({
				model,
				max_tokens: 16000,
				system: guidance ? `${basePrompt}\n\n# Operator guidance for this run\n${guidance}` : basePrompt,
				tools,
				tool_choice: { type: "tool", name: "finish" },
				messages,
			});
			const out = rescue.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			if (!out) throw new Error("model did not emit finish");
			writeArtifacts(out.input as FinishInput, findings.length, true);
		} catch (rescueErr) {
			// Last resort: the raw findings, unshaped. Still better than nothing.
			console.error(`salvage call failed: ${rescueErr instanceof Error ? rescueErr.message : String(rescueErr)}`);
			fs.writeFileSync(
				outPath,
				provenanceHeader(app, actions, findings.length, backendKind, findCalls, guidance, true) +
					`# ${app} — grounding notes (raw findings only)\n\n${findings.map((f) => `- ${f}`).join("\n")}`,
			);
			console.log(`wrote ${findings.length} raw findings to ${outPath}`);
		}
	} finally {
		await driver.close();
		overlay.stop();
	}
}

main().catch((err) => {
	console.error("explore failed:", err);
	process.exit(1);
});
