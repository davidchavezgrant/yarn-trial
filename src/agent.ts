import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Driver } from "./driver.js";
import {
	ACT_TOOL,
	appSlug,
	assertObservable,
	auditTaskPrompt,
	DRIVER_RULES,
	findWindow,
	makeClient,
	observationBlocks,
	observe,
	OUT,
	resetToHome,
	TargetNotObservableError,
	toActionRequest,
	verify,
} from "./harness.js";
import { DOM_ACT_TOOL, DOM_RULES, DomBackend } from "./dom.js";
import type { ActionRequest, Expectation, StepRecord } from "./types.js";

const MAX_STEPS = Number(process.env.AGENT_STEPS ?? 15);
const SETTLE_MS = 900;

const systemPrompt = (rules: string): string => `You are a UI automation agent driving a macOS app through a UI driver. Each turn you receive an observation: the target window's interactive elements (addressing handle, role, label/value) and a screenshot. You perform ONE action per turn by calling the "act" tool, then the harness executes it, waits, re-observes, and reports back.

${rules}
- Set a concrete, checkable expectation for every action: textIncludes and/or textExcludes, literal substrings checked against the window title plus all element labels and values in the NEXT observation. This is MANDATORY — an act call carrying only a prose description is rejected and NOT executed, costing you a turn. Supply it even when you are certain the action will work.
- Expectations must DISCRIMINATE: at least one substring that appears (or disappears) BECAUSE of the action. A check that was already true before the action is rejected as evidence — in particular, text you typed earlier does not verify a later action.
- If verification fails, do not repeat the same action blindly — re-read the observation, diagnose, and recover.

Call "done" when the task is complete (success: true) — you MUST attach evidence: substring checks proving the GOAL state, which the harness verifies against a fresh final observation before accepting. Call done with success: false when you are stuck after genuine recovery attempts. Always call exactly one tool per turn.`;

const DONE_TOOL: Anthropic.Tool = {
	name: "done",
	description:
		"End the run: the task is complete and verified, or unrecoverable. A success claim is only accepted if your evidence checks pass against a FRESH final observation taken by the harness.",
	input_schema: {
		type: "object",
		properties: {
			success: { type: "boolean" },
			summary: { type: "string", description: "What was done and how the final state verifies it (or why it failed)." },
			evidence: {
				type: "object",
				description:
					"REQUIRED when success is true. Substring checks proving the GOAL state (not merely the last action) — run against a fresh observation. E.g. for a timezone change: textIncludes ['GMT+2'].",
				properties: {
					description: { type: "string" },
					textIncludes: { type: "array", items: { type: "string" } },
					textExcludes: { type: "array", items: { type: "string" } },
				},
				required: ["description"],
			},
		},
		required: ["success", "summary"],
	},
};

interface GroundingMeta {
	/** "none" | "explore" (autonomous exploration output) | "curated" (human-edited — a recipe tier, not measurable as grounding) */
	provenance: "none" | "explore" | "curated";
	path?: string;
	notes?: string;
}

function loadGrounding(app: string): GroundingMeta {
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/recipes/ holds hand-curated notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	const explorePath = `${process.cwd()}/docs/appmaps/${appSlug(app)}.md`;
	const recipePath = `${process.cwd()}/docs/recipes/${appSlug(app)}.md`;
	const useRecipe = process.env.USE_RECIPE ? fs.existsSync(recipePath) : false;
	const path = useRecipe ? recipePath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	const stamped = /^<!-- provenance: explore\b/.test(notes);
	if (!useRecipe && !stamped)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/recipes/.",
		);

	return { provenance: useRecipe || !stamped ? "curated" : "explore", path, notes };
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

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const record = argv.includes("--record");
	const backendIdx = argv.indexOf("--backend");
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : "ax";
	const args = argv.filter(
		(a, i) =>
			!["--record", "--hinted", "--no-reset"].includes(a) &&
			(backendIdx < 0 || (i !== backendIdx && i !== backendIdx + 1)),
	);
	const task = args[0];
	const app = args[1] ?? "Notion Calendar";
	if (!task || !["ax", "dom"].includes(backendKind)) {
		console.error('usage: tsx src/agent.ts "<task>" ["App Name"] [--record] [--backend ax|dom]');
		console.error("--backend dom drives an Electron/browser target over CDP; launch it with --remote-debugging-port first.");
		process.exit(1);
	}

	// Prompt hygiene gate: a task prompt containing method hints is not a valid autonomy
	// test, and the resulting run log is indistinguishable from a clean one unless we
	// record the fact here. Refuse by default; --hinted opts in and marks the log.
	const noReset = argv.includes("--no-reset");
	const hintedAck = argv.includes("--hinted");
	const audit = auditTaskPrompt(task);
	if (audit.hinted && !hintedAck) {
		console.error("REFUSING TO RUN — the task prompt contains method hints, not just a goal:");
		for (const r of audit.reasons) console.error(`  · ${r}`);
		console.error(
			"\nA hinted prompt hands the model knowledge it would not have in a real run, so the\n" +
				"result cannot be reported as autonomous. Move method knowledge into\n" +
				`docs/appmaps/${appSlug(app)}.md (a declared input), and restate the task as the goal only.\n` +
				"If the hint is intentional (e.g. pinning a path for a filming take), re-run with --hinted;\n" +
				"the run log and any published result must then say so.",
		);
		process.exit(2);
	}

	const { client, model } = makeClient();
	const driver = await Driver.start("agent");
	const records: StepRecord[] = [];
	const startedAt = Date.now();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
	// Unique per run: a single overwritten agent-run.json forced hand-copying to preserve
	// A/B artifacts, which is how out/ab-grounded-script.json ended up a mislabeled
	// duplicate of a different run and its real numbers were lost.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	fs.mkdirSync(`${OUT}/runs`, { recursive: true });
	const runLog = `${OUT}/runs/${stamp}-${appSlug(app)}.json`;
	let driverBusy = false;
	let homeReset: string = noReset ? "skipped" : "pending";
	let expectationRejections = 0;

	// Window-scoped recording: poll the driver's window snapshots (which work even
	// when the window is occluded, backgrounded, or on another Space) and assemble
	// them into an mp4 afterwards. Polling pauses while an action/observation holds
	// the driver, so frames land in the model-thinking gaps.
	// Per-run directory, sharing the run log's stamp: the video and the log that proves
	// what it shows stay paired, and a recorded A/B no longer overwrites its own evidence.
	const recordingDir = `${OUT}/recording/${stamp}-${appSlug(app)}`;
	const framesDir = `${recordingDir}/frames`;
	const videoPath = `${recordingDir}/window.mp4`;
	const frameTimes: number[] = [];
	const frameDrops: string[] = [];
	let recordingActive = false;
	let frameLoop: Promise<void> | undefined;

	const grounding = loadGrounding(app);
	// What the log records: provenance + path + content hash, not the full text — enough
	// to pin exactly which appmap version grounded the run without bloating every log.
	const groundingMeta = {
		provenance: grounding.provenance,
		...(grounding.path ? { path: grounding.path.replace(`${process.cwd()}/`, "") } : {}),
		...(grounding.notes ? { sha256: createHash("sha256").update(grounding.notes).digest("hex").slice(0, 12) } : {}),
	};
	const basePrompt = systemPrompt(backendKind === "dom" ? DOM_RULES : DRIVER_RULES);
	const system = grounding.notes
		? `${basePrompt}\n\n# App grounding notes for ${app} (from a prior exploration pass — trust these to skip dead ends)\n${grounding.notes}`
		: basePrompt;
	if (grounding.notes) console.log(`loaded grounding notes for ${app} (provenance: ${grounding.provenance}, ${groundingMeta.path})`);
	const tools: Anthropic.Tool[] = [backendKind === "dom" ? DOM_ACT_TOOL : ACT_TOOL, DONE_TOOL];

	try {
		await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
		await new Promise((r) => setTimeout(r, 1500));
		const win = await findWindow(driver, app);
		// For the DOM backend the CDP bind is the observability gate; AX darkness is fine.
		const dom = backendKind === "dom" ? await DomBackend.bind(driver, win) : undefined;
		if (!dom) await assertObservable(driver, win, app);
		const doObserve = (name: string) => (dom ? dom.observe(name) : observe(driver, win, name));
		console.log(`target: ${app} pid=${win.pid} window=${win.windowId} backend=${backendKind}`);

		// Start from a declared home state, so a run never inherits the previous run's
		// navigation. --no-reset opts out (e.g. deliberately resuming mid-flow).
		if (!noReset && !dom) {
			const reset = await resetToHome(driver, win, app);
			homeReset = reset.result;
			console.log(`home reset: ${reset.result} — ${reset.detail}`);
			if (reset.result === "none")
				console.log(`  (add "${appSlug(app)}" to APP_HOME in src/harness.ts to make runs comparable)`);
		}
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
			fs.mkdirSync(framesDir, { recursive: true });
			await driver.act({ kind: "tool", name: "start_recording", args: { output_dir: `${recordingDir}/trajectory` } });
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

		let blindStreak = 0;
		let obs = await doObserve("agent-step-0");
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
				tools,
				cache_control: { type: "ephemeral" },
				messages,
			});

			usage.modelCalls++;
			usage.inputTokens += response.usage?.input_tokens ?? 0;
			usage.outputTokens += response.usage?.output_tokens ?? 0;
			usage.cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;

			if (response.stop_reason === "refusal") throw new Error("model refused the request");

			const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			messages.push({ role: "assistant", content: response.content });

			if (!toolUse) {
				messages.push({ role: "user", content: "You must call exactly one tool (act or done)." });
				continue;
			}

			if (toolUse.name === "done") {
				const input = toolUse.input as { success: boolean; summary: string; evidence?: Expectation };

				// success is a claim; the harness demands machine-checkable evidence and
				// grades it against a FRESH observation (state can have shifted since the
				// last step — e.g. a toast expired or a save silently failed).
				let finalCheck: { verified: boolean; note: string; evidence?: Expectation } | undefined;
				if (input.success) {
					const checkable = input.evidence?.textIncludes?.length || input.evidence?.textExcludes?.length;
					if (!checkable) {
						console.log("    -> done(success) rejected: no checkable evidence");
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										"DONE NOT ACCEPTED — success requires evidence.textIncludes and/or evidence.textExcludes: " +
										"substrings proving the GOAL state, verified against a fresh observation. " +
										"Re-issue done with checkable evidence, or done(success: false) if you cannot prove the goal.",
								},
							],
						});
						continue;
					}

					while (driverBusy) await new Promise((r) => setTimeout(r, 50));
					driverBusy = true;
					try {
						const finalObs = await doObserve("agent-final");
						finalCheck = { ...verify(input.evidence!, finalObs.haystack), evidence: input.evidence };
					} finally {
						driverBusy = false;
					}

					if (!finalCheck.verified) {
						console.log(`    -> done(success) REFUTED by final observation: ${finalCheck.note}`);
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										`DONE NOT ACCEPTED — your evidence failed against a fresh observation: ${finalCheck.note}\n` +
										"The goal state is not proven. Diagnose and continue, or call done(success: false).",
								},
							],
						});
						continue;
					}
				}

				const unverified = records.filter((r) => !r.verified).length;
				const verdict = !input.success
					? "failure"
					: unverified === 0
						? "success (goal check passed, all steps verified)"
						: `success (goal check passed; ${unverified}/${records.length} steps unverified)`;
				console.log(`\n=== DONE (${verdict}) after ${records.length} actions ===`);
				console.log(input.summary);
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				fs.writeFileSync(runLog, JSON.stringify({ task, app, backend: backendKind, grounding: groundingMeta, hintedPrompt: audit.hinted, hintReasons: audit.reasons, homeReset, success: input.success, finalCheck, verifiedSteps: records.length - unverified, unverifiedSteps: unverified, expectationRejections, summary: input.summary, elapsedSec, usage, ...(record ? { video: videoPath.replace(`${process.cwd()}/`, "") } : {}), steps: records }, null, 2));
				console.log(`stats: ${records.length} actions, ${elapsedSec}s, ${usage.modelCalls} model calls, ${usage.outputTokens} output tokens, grounding=${groundingMeta.provenance}, hintedPrompt=${audit.hinted}, homeReset=${homeReset}`);
				console.log(`verification: ${records.length - unverified}/${records.length} steps verified${expectationRejections ? `, ${expectationRejections} call(s) rejected for missing checks` : ""}${finalCheck ? `; final goal check: ${finalCheck.verified ? "PASSED" : "failed"} (${finalCheck.evidence?.textIncludes?.join(", ") ?? ""})` : ""}`);
				if (audit.hinted) console.log("NOTE: prompt contained method hints — NOT a clean autonomy result.");
				console.log(`run log: ${runLog}`);
				return;
			}

			const input = toolUse.input as { reasoning?: string; action: any; expectation: Expectation };
			console.log(`[${step}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			// OpenRouter does not always enforce required tool fields, so a missing
			// expectation arrives silently — and an unverifiable action that "worked"
			// is indistinguishable from one we simply never checked. Refuse to act
			// until the model commits to a checkable claim.
			const checkable = input.expectation?.textIncludes?.length || input.expectation?.textExcludes?.length;
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

			let resultText = "";
			let isError = false;
			let request: ActionRequest | null = null;
			try {
				request = dom ? dom.toRequest(input.action) : toActionRequest(input.action, win);
			} catch (err) {
				// Unsupported action: report it back so the model can pick a real one.
				resultText = `ACTION REJECTED: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}

			const prevHaystack = obs.haystack;
			while (driverBusy) await new Promise((r) => setTimeout(r, 50));
			driverBusy = true;
			try {
				if (!isError) {
					try {
						resultText = request
							? (await driver.act(request)).text.slice(0, 400)
							: "waited (no driver action)";
					} catch (err) {
						resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
						isError = true;
					}
				}

				await new Promise((r) => setTimeout(r, SETTLE_MS));
				obs = await doObserve(`agent-step-${step}`);
				if (obs.appContent === 0) {
					// AX tree collapsed (e.g. a modal/other window took over). Acting now means
					// acting blind — stop rather than let the model flail against a menu bar.
					if (++blindStreak >= 3)
						throw new TargetNotObservableError(app, "no addressable elements for 3 consecutive observations");
				} else blindStreak = 0;
			} finally {
				driverBusy = false;
			}
			// `wait` legitimately changes nothing, so exempt it from the discrimination
			// requirement (its point is that already-true state persists).
			const verdict = isError
				? { verified: false, note: "action errored" }
				: verify(input.expectation, obs.haystack, input.action.name === "wait" ? undefined : prevHaystack);
			console.log(`    -> ${verdict.verified ? "✓ verified" : `✗ ${verdict.note}`}`);

			records.push({
				index: step,
				timestamp: new Date().toISOString(),
				action: request ?? { kind: "tool", name: input.action.name, args: {} },
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
		fs.writeFileSync(runLog, JSON.stringify({ task, app, backend: backendKind, grounding: groundingMeta, hintedPrompt: audit.hinted, hintReasons: audit.reasons, homeReset, success: false, expectationRejections, summary: "step limit reached", elapsedSec: Math.round((Date.now() - startedAt) / 1000), usage, steps: records }, null, 2));
		console.log(`run log: ${runLog}`);
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
				assembleVideo(framesDir, frameTimes, videoPath);
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
