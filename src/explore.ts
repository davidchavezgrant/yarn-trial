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
import type { AppMap, AppMapEdge, AppMapNode } from "./types.js";

const MAX_STEPS = Number(process.env.EXPLORE_STEPS ?? 25);
const SETTLE_MS = 900;

const systemPrompt = (rules: string): string => `You are an exploration agent building grounding notes for a macOS app, so a future task-running agent can navigate it directly without dead ends. You drive the app through a UI driver: each turn you receive the window's elements (addressing handle, role, label/value) and a screenshot, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the app's main surfaces — menus, settings panels and their tabs, context menus on notable controls, pickers — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions: no deleting, no sending/sharing, no account or sync changes, no creating events/documents you can't discard, no toggling settings you don't revert.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- Leave the app in the state you found it.

${rules}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end.

When your step budget is spent or coverage is good, call "finish" with BOTH artifacts:

1. "document" — the prose grounding document in markdown: a "Layout" section (main surfaces and how to reach them), a "How to" section (task recipes as exact interaction sequences), and a "Dead ends & quirks" section. Be specific and terse — this document is injected into the task agent's prompt.

2. "nodes" + "edges" — the same knowledge as a graph, for code to query.

On the graph, one thing matters more than completeness: SCOPE. Many apps let the same setting be changed in more than one place — an app-wide or brand-wide default, and a per-document override — and these are usually separate stores, so changing one does not change the other. An agent that changes the wrong one appears to succeed. When you find a control, ask "whose state does this change?" and set "scope" accordingly. If you find the same underlying setting exposed in two places, give BOTH controls the identical "settingKey" and their own distinct "scope". That pairing is what lets the harness warn the next agent.`;

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
): string =>
	`<!-- provenance: explore | app: ${app} | date: ${new Date().toISOString().slice(0, 10)} | backend: ${backend} | actions: ${actions} | findings: ${findings} | finds: ${findCalls}${guidance ? " | operator-guidance: yes" : ""} -->\n` +
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
	const driver = await Driver.start("explore");
	const findings: string[] = [];
	const outPath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.md`;
	const graphPath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.json`;
	fs.mkdirSync(`${process.cwd()}/docs/appmaps`, { recursive: true });

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);
		// Exploration runs once and its whole purpose is coverage, so it exhausts the
		// continuation chain on every observation — the opposite tradeoff from the agent
		// loop, which re-observes after every action and pays per-step for depth.
		const dom = backendKind === "dom" ? await DomBackend.bind(driver, win, Infinity) : undefined;
		if (!dom) await assertObservable(driver, win, app);
		const doObserve = (name: string) => (dom ? dom.observe(name, Infinity) : observe(driver, win, name));
		const tools: Anthropic.Tool[] = dom ? [DOM_ACT_TOOL, FIND_TOOL, ...EXTRA_TOOLS] : [ACT_TOOL, ...EXTRA_TOOLS];
		const basePrompt = systemPrompt(dom ? DOM_RULES : DRIVER_RULES);
		console.log(`exploring ${app} pid=${win.pid} window=${win.windowId} backend=${backendKind}\n`);

		let blindStreak = 0;
		let findCalls = 0;
		let obs = await doObserve("explore-step-0");
		const messages: Anthropic.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: `Explore "${app}". Step budget: ${MAX_STEPS} actions. Initial observation follows.` },
					...observationBlocks(obs),
				],
			},
		];

		let actions = 0;
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

			if (toolUse.name === "finish") {
				const out = toolUse.input as { document: string; nodes?: AppMapNode[]; edges?: AppMapEdge[] };
				const prose = provenanceHeader(app, actions, findings.length, backendKind, findCalls, guidance) + out.document;
				fs.writeFileSync(outPath, prose);
				console.log(`\n=== exploration finished after ${actions} actions, ${findings.length} findings ===`);
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
	} finally {
		await driver.close();
	}
}

main().catch((err) => {
	console.error("explore failed:", err);
	process.exit(1);
});
