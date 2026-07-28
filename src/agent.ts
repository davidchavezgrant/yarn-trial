import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
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
	OUT,
	toActionRequest,
} from "./harness.js";
import type { Expectation, StepRecord } from "./types.js";

const MAX_STEPS = 15;
const SETTLE_MS = 900;

const SYSTEM_PROMPT = `You are a UI automation agent driving a macOS app through an accessibility (AX) driver. Each turn you receive an observation: the target window's interactive elements (index, role, label/value, frame) and a screenshot. You perform ONE action per turn by calling the "act" tool, then the harness executes it, waits, re-observes, and reports back.

${DRIVER_RULES}
- Set a concrete, checkable expectation for every action. Verification checks your textIncludes/textExcludes substrings against the window title plus all element labels and values in the NEXT observation.
- If verification fails, do not repeat the same action blindly — re-read the observation, diagnose, and recover.

Call "done" when the task is complete and verified by observation (success: true), or when you are stuck after genuine recovery attempts (success: false). Always call exactly one tool per turn.`;

const TOOLS: Anthropic.Tool[] = [
	ACT_TOOL,
	{
		name: "done",
		description: "End the run: the task is complete and verified, or unrecoverable.",
		input_schema: {
			type: "object",
			properties: {
				success: { type: "boolean" },
				summary: { type: "string", description: "What was done and how the final state verifies it (or why it failed)." },
			},
			required: ["success", "summary"],
		},
	},
];

function loadGrounding(app: string): string | undefined {
	const path = `${process.cwd()}/docs/appmaps/${appSlug(app)}.md`;
	if (!fs.existsSync(path)) return undefined;

	return fs.readFileSync(path, "utf8");
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

function verify(expectation: Expectation, haystack: string): { verified: boolean; note: string } {
	const missing = (expectation.textIncludes ?? []).filter((t) => !haystack.includes(t.toLowerCase()));
	const present = (expectation.textExcludes ?? []).filter((t) => haystack.includes(t.toLowerCase()));
	if (missing.length === 0 && present.length === 0)
		return { verified: true, note: "expectation met" };

	const parts: string[] = [];
	if (missing.length) parts.push(`expected but not found: ${missing.join(", ")}`);
	if (present.length) parts.push(`expected absent but found: ${present.join(", ")}`);

	return { verified: false, note: parts.join("; ") };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2).filter((a) => a !== "--record");
	const record = process.argv.includes("--record");
	const task = args[0];
	const app = args[1] ?? "Notion Calendar";
	if (!task) {
		console.error('usage: tsx src/agent.ts "<task>" ["App Name"] [--record]');
		process.exit(1);
	}

	const { client, model } = makeClient();
	const driver = await Driver.start("agent");
	const records: StepRecord[] = [];
	const runLog = `${OUT}/agent-run.json`;
	let driverBusy = false;

	// Window-scoped recording: poll the driver's window snapshots (which work even
	// when the window is occluded, backgrounded, or on another Space) and assemble
	// them into an mp4 afterwards. Polling pauses while an action/observation holds
	// the driver, so frames land in the model-thinking gaps.
	const framesDir = `${OUT}/recording/frames`;
	const frameTimes: number[] = [];
	const frameDrops: string[] = [];
	let recordingActive = false;
	let frameLoop: Promise<void> | undefined;

	const grounding = loadGrounding(app);
	const system = grounding
		? `${SYSTEM_PROMPT}\n\n# App grounding notes for ${app} (from a prior exploration pass — trust these to skip dead ends)\n${grounding}`
		: SYSTEM_PROMPT;
	if (grounding) console.log(`loaded grounding notes for ${app}`);

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);
		console.log(`target: ${app} pid=${win.pid} window=${win.windowId}`);
		console.log(`task: ${task}\n`);

		if (record) {
			// The driver's window snapshots composite incorrectly for windows on 1x
			// (non-retina) displays — stage the window onto the main display first.
			try {
				// Top-left placement also keeps the window over the macOS capture-indicator
				// pill, whose window otherwise gets unioned into the driver's snapshots.
				execSync(
					`osascript -e 'tell application "System Events" to tell process "${app}" to set position of (first window whose name contains "${app}") to {0, 38}'`,
				);
				await new Promise((r) => setTimeout(r, 1500));
			} catch {
				console.log("could not stage window onto main display; recording may be degraded");
			}
			fs.rmSync(`${OUT}/recording`, { recursive: true, force: true });
			fs.mkdirSync(framesDir, { recursive: true });
			await driver.act({ kind: "tool", name: "start_recording", args: { output_dir: `${OUT}/recording/trajectory` } });
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

		let obs = await observe(driver, win, "agent-step-0");
		const messages: Anthropic.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: `Task: ${task}\nTarget app: ${app}\n\nInitial observation follows.` },
					...observationBlocks(obs),
				],
			},
		];

		for (let step = 1; step <= MAX_STEPS; step++) {
			const response = await client.messages.create({
				model,
				max_tokens: 16000,
				system,
				tools: TOOLS,
				cache_control: { type: "ephemeral" },
				messages,
			});

			if (response.stop_reason === "refusal") throw new Error("model refused the request");

			const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			messages.push({ role: "assistant", content: response.content });

			if (!toolUse) {
				messages.push({ role: "user", content: "You must call exactly one tool (act or done)." });
				continue;
			}

			if (toolUse.name === "done") {
				const input = toolUse.input as { success: boolean; summary: string };
				console.log(`\n=== DONE (${input.success ? "success" : "failure"}) after ${records.length} actions ===`);
				console.log(input.summary);
				fs.writeFileSync(runLog, JSON.stringify({ task, app, success: input.success, summary: input.summary, steps: records }, null, 2));
				console.log(`run log: ${runLog}`);
				return;
			}

			const input = toolUse.input as { reasoning?: string; action: any; expectation: Expectation };
			console.log(`[${step}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			let resultText: string;
			let isError = false;
			while (driverBusy) await new Promise((r) => setTimeout(r, 50));
			driverBusy = true;
			try {
				try {
					const result = await driver.act(toActionRequest(input.action, win));
					resultText = result.text.slice(0, 400);
				} catch (err) {
					resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
					isError = true;
				}

				await new Promise((r) => setTimeout(r, SETTLE_MS));
				obs = await observe(driver, win, `agent-step-${step}`);
			} finally {
				driverBusy = false;
			}
			const verdict = isError
				? { verified: false, note: "action errored" }
				: input.expectation
					? verify(input.expectation, obs.haystack)
					: { verified: false, note: "no expectation provided — set one on every act call" };
			console.log(`    -> ${verdict.verified ? "✓ verified" : `✗ ${verdict.note}`}`);

			records.push({
				index: step,
				timestamp: new Date().toISOString(),
				action: toActionRequest(input.action, win),
				expectation: input.expectation ?? { description: "(none provided)" },
				verified: verdict.verified,
				verificationNote: verdict.note,
				screenshotFile: `agent-step-${step}.png`,
				modelReasoning: input.reasoning,
			});

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
							...observationBlocks(obs),
						],
					},
				],
			});
		}

		console.log(`\n=== step limit (${MAX_STEPS}) reached without done ===`);
		fs.writeFileSync(runLog, JSON.stringify({ task, app, success: false, summary: "step limit reached", steps: records }, null, 2));
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
				assembleVideo(framesDir, frameTimes, `${OUT}/recording/window.mp4`);
			} catch (err) {
				console.error("video assembly failed:", err);
			}
		}
		await driver.close();
	}
}

main().catch((err) => {
	console.error("agent failed:", err);
	process.exit(1);
});
