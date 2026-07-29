import type Anthropic from "@anthropic-ai/sdk";
import { makeClient } from "./harness.js";

/**
 * Measures the model's PRIOR knowledge of a target app: no observation, no tools, no
 * appmap, no screenshot — memory only.
 *
 * This is the control for every "ungrounded" run. `NO_GROUNDING=1` removes our appmap,
 * but it cannot remove what the model absorbed in pretraining. If the model can already
 * name the control path from memory, an ungrounded run of that task is RECALL, not
 * discovery, and must not be cited as evidence of discovery from zero.
 *
 * usage: tsx src/prior.ts "<App Name>" "<goal>"
 */
async function main(): Promise<void> {
	const [app, goal] = process.argv.slice(2);
	if (!app || !goal) {
		console.error('usage: tsx src/prior.ts "<App Name>" "<goal>"');
		process.exit(1);
	}

	const { client, model } = makeClient();
	const response = await client.messages.create({
		model,
		max_tokens: 1200,
		system:
			"You are being tested on recall only. You have NO access to the app, no screenshot, " +
			"and no notes. Answer strictly from prior knowledge.\n\n" +
			"Report in exactly this shape:\n" +
			"KNOWN: yes | partial | no\n" +
			"PATH: the precise UI steps, naming the actual controls, or UNKNOWN\n" +
			"CONFIDENCE: high | medium | low\n" +
			"BASIS: one sentence on why you believe this (specific memory vs. inference from " +
			"conventions in similar apps)\n\n" +
			"Do not hedge into a plausible-sounding guess. If you are pattern-matching to how " +
			"apps of this kind usually work rather than recalling this specific app, say so in " +
			"BASIS and set KNOWN to no.",
		messages: [{ role: "user", content: `App: ${app}\nGoal: ${goal}\n\nHow would a user accomplish this?` }],
	});

	const text = response.content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	console.log(`=== prior-knowledge probe: ${app} ===`);
	console.log(`goal: ${goal}\n`);
	console.log(text.trim());
}

main().catch((err) => {
	console.error("prior probe failed:", err);
	process.exit(1);
});
