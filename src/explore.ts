import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { Driver } from "./driver.js";
import {
	ACT_TOOL,
	appSlug,
	DRIVER_RULES,
	findWindow,
	makeClient,
	observationBlocks,
	observe,
	toActionRequest,
} from "./harness.js";

const MAX_STEPS = 25;
const SETTLE_MS = 900;

const SYSTEM_PROMPT = `You are an exploration agent building grounding notes for a macOS app, so a future task-running agent can navigate it directly without dead ends. You drive the app through an accessibility (AX) driver: each turn you receive the window's elements (index, role, label/value, frame) and a screenshot, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the app's main surfaces — menus, settings panels and their tabs, context menus on notable controls, pickers — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions: no deleting, no sending/sharing, no account or sync changes, no creating events/documents you can't discard, no toggling settings you don't revert.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- Leave the app in the state you found it.

${DRIVER_RULES}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end.

When your step budget is spent or coverage is good, call "finish" with the final grounding document in markdown: a "Layout" section (main surfaces and how to reach them), a "How to" section (task recipes as exact interaction sequences), and a "Dead ends & quirks" section. Be specific and terse — this document is injected into the task agent's prompt.`;

const TOOLS: Anthropic.Tool[] = [
	ACT_TOOL,
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
		description: "End exploration and emit the final grounding document (markdown).",
		input_schema: {
			type: "object",
			properties: { document: { type: "string" } },
			required: ["document"],
		},
	},
];

async function main(): Promise<void> {
	const app = process.argv[2] ?? "Notion Calendar";
	const { client, model } = makeClient();
	const driver = await Driver.start("explore");
	const findings: string[] = [];
	const outPath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.md`;
	fs.mkdirSync(`${process.cwd()}/docs/appmaps`, { recursive: true });

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);
		console.log(`exploring ${app} pid=${win.pid} window=${win.windowId}\n`);

		let obs = await observe(driver, win, "explore-step-0");
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
				system: SYSTEM_PROMPT,
				tools: TOOLS,
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
				const doc = (toolUse.input as { document: string }).document;
				fs.writeFileSync(outPath, doc);
				console.log(`\n=== exploration finished after ${actions} actions, ${findings.length} findings ===`);
				console.log(`grounding notes: ${outPath}`);
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

			const input = toolUse.input as { reasoning?: string; action: any };
			actions++;
			console.log(`[${actions}/${MAX_STEPS}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			let resultText: string;
			let isError = false;
			try {
				const result = await driver.act(toActionRequest(input.action, win));
				resultText = result.text.slice(0, 400);
			} catch (err) {
				resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}

			await new Promise((r) => setTimeout(r, SETTLE_MS));
			obs = await observe(driver, win, `explore-step-${actions}`);

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
		fs.writeFileSync(outPath, `# ${app} — grounding notes (partial)\n\n${findings.map((f) => `- ${f}`).join("\n")}`);
		console.log(`\n=== turn limit reached; wrote ${findings.length} raw findings ===`);
	} finally {
		await driver.close();
	}
}

main().catch((err) => {
	console.error("explore failed:", err);
	process.exit(1);
});
