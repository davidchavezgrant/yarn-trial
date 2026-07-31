import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Driver } from "./driver.js";
import { envNum } from "./env.js";
import {
	ACT_TOOL,
	appSlug,
	checkHome,
	destructiveTarget,
	DRIVER_RULES,
	ensureObservable,
	failedProvider,
	findScopeAmbiguities,
	findWindow,
	frontierCredit,
	frontierDismiss,
	frontierIngest,
	frontierMatches,
	frontierRemaining,
	frontierSummary,
	isVagueSurface,
	makeClient,
	mergeGraph,
	newFrontier,
	observationBlocks,
	type ObservationBundle,
	observe,
	onInterrupt,
	OUT,
	providerRouting,
	recoverLeakedGraph,
	retryTransient,
	runKey,
	settleMsFor,
	TargetNotObservableError,
	toActionRequest,
	type WindowRef,
} from "./harness.js";
import { ensureBrowser } from "./browser.js";
import { DOM_ACT_TOOL, DOM_RULES, DomBackend, FIND_TOOL } from "./dom.js";
import { startOverlay } from "./overlay.js";
import { appmapsDir } from "./paths.js";
import { parseTarget, type Target, targetLabel, targetSlug, type TargetVocabulary, targetVocabulary } from "./target.js";
import type { AppMap, AppMapEdge, AppMapHome, AppMapNode } from "./types.js";

/**
 * The only backstop, and it counts actions rather than seconds on purpose. A wall-clock cap
 * used to sit beside it and was removed: some apps embed an agent of their own, and waiting
 * out a five-minute think is legitimate exploration that a clock cannot distinguish from a
 * hang. Actions are the honest unit — a pass that is stuck is stuck at some count, however
 * long each one took. What ends a pass normally is the frontier emptying (see harness.ts).
 *
 * Sized so it cannot be what ends a long pass. An action is a model call plus a driver call
 * plus an observation, which has never measured under ~10s (Yarn's finished pass ran ~25s),
 * so 24 hours is at most ~8,600 actions and realistically a third of that. 10,000 clears the
 * ceiling either way, which is the point: reaching it means something is looping, not that
 * the app was large.
 */
const MAX_ACTIONS = envNum("EXPLORE_MAX_ACTIONS", 10_000);
/**
 * Most controls a single `dismiss` may retire when it does not name a specific surface.
 * Measured need: an uncapped pass cleared 104 unrelated top-level controls in one call and
 * declared the frontier empty at 25 actuated of 262 seen. Named panels are exempt — a list
 * of 80 identical rows is one honest decision; a hundred scattered controls are not.
 */
const DISMISS_CAP = envNum("EXPLORE_DISMISS_CAP", 20);
/** The destructive-label pre-flight. Its own switch, deliberately not tied to `guidance`. */
const GUARD_ON = (process.env.EXPLORE_GUARD ?? "on") !== "off";
/**
 * Observations kept in one context window before it is reset. Each costs ~7k tokens (AX
 * text plus a screenshot), so ~12 is ~85k — comfortable, and bounded no matter how long the
 * pass runs. See the chapter comment at the reset site.
 */
const CHAPTER_OBSERVATIONS = envNum("EXPLORE_CHAPTER", 12);
const SETTLE_MS = 900;

/** The payload of the "finish" tool — the pass's entire output, prose plus graph. */
type FinishInput = { document: string; nodes?: AppMapNode[]; edges?: AppMapEdge[]; home?: AppMapHome };
type GraphInput = { nodes?: AppMapNode[]; edges?: AppMapEdge[] };
type StopReason = "frontier-empty" | "action-ceiling" | "frontier-conceded" | "interrupted" | "error";

const systemPrompt = (rules: string, vocab: TargetVocabulary): string => `You are an exploration agent building grounding notes for ${vocab.subject}, so a future task-running agent can navigate it directly without dead ends. You drive it through a UI driver: each turn you receive ${vocab.container}'s elements (addressing handle, role, label/value) and a screenshot, and you perform ONE action via the "act" tool.

Your goal is a map, not a task: systematically visit the main surfaces — ${vocab.surfaces} — and record where things live and how to operate them.

Safety rules (absolute):
- NEVER take destructive or externally visible actions: no deleting, no sending/sharing, no account or sync changes, no creating events/documents you can't discard, no toggling settings you don't revert.
- Opening panels, tabs, menus, and pickers is fine. Close what you open (escape, foreground) before moving on.
- Leave it in the state you found it.
${vocab.cautions ? `\n${vocab.cautions}\n` : ""}
${rules}

Use the "record" tool whenever you learn something a task agent would need: where a setting lives, the exact interaction pattern for a control (e.g. "right-click X, then choose Y"), a dead end ("Z is NOT in Settings"), or a quirk. Record findings as you go — do not save them all for the end. "record" also accepts graph nodes and edges: emit them as you discover surfaces rather than holding the whole graph until the end. Anything you record is checkpointed to disk immediately and survives even if this run is killed, and it is preserved verbatim across context resets — anything you merely reasoned about is not.

# How this run ends

There is no step budget and no time limit. After every action you are told the FRONTIER: interactive controls that have been seen in some observation but never operated. The run ends when that list is empty, and "finish" is refused while it is not.

Because there is no clock, a slow surface is worth waiting for rather than abandoning — a long render, an upload, an assistant of the app's own thinking. Call wait with a generous "seconds" (a whole minute or several is fine; one long wait costs one action, many short ones cost many) instead of poking at an unchanged screen. A surface you gave up on early is a hole in the map that reads exactly like a surface that does not exist.

So you have two ways to shrink it, and both are legitimate:
- Operate the control (this is the default: it is how surfaces get discovered — opening one panel adds everything inside it to the frontier).
- Call "dismiss" for controls you have deliberately decided not to operate — content rather than navigation (list rows, transcript chunks, individual documents), destructive things, or anything that would leave the app changed. Dismiss by surface to clear a whole panel of repetitive items at once. Dismissals are recorded and published with the map, so give a real reason; they are the honest way to say "I chose not to", which silence is not.

Dismissal is bounded on purpose: a single call that does not name a specific surface may retire at most ${DISMISS_CAP} controls, because one sentence cannot honestly justify a hundred unrelated decisions. Scattered top-level controls must be dismissed in groups small enough to each have a real reason — or opened. A named panel of repetitive rows is exempt.

Breadth before depth. A map with one richly-detailed region and whole panels never opened is worse than an even one, because the task agent cannot tell the difference between "not in this app" and "not visited". Prefer a frontier entry that opens a new surface over one more control in a surface you have already mapped.

When the frontier is empty, call "finish" with BOTH artifacts:

1. "document" — the prose grounding document in markdown: a "Layout" section (main surfaces and how to reach them), a "How to" section (task recipes as exact interaction sequences), and a "Dead ends & quirks" section. Be specific and terse — this document is injected into the task agent's prompt.

2. "nodes" + "edges" — the same knowledge as a graph, for code to query. Anything already sent via "record" is merged in; you need only add what is missing.

3. "home" — where a task run should START. Not a place you found interesting: the app's ordinary landing view, the one a person sees on opening it and returns to between jobs. Name the control in the navigation chrome that goes there from anywhere (usually a sidebar or tab item), spelled EXACTLY as its label appears in observations. Prefer a stable list or overview over a document or editor, however much of this app's substance lives inside one — a run that starts inside an open document inherits that document's state. This is used only to reset the app before a run and is never shown to the task agent.

On the graph, one thing matters more than completeness: SCOPE. Many apps let the same setting be changed in more than one place — an app-wide or brand-wide default, and a per-document override — and these are usually separate stores, so changing one does not change the other. An agent that changes the wrong one appears to succeed. When you find a control, ask "whose state does this change?" and set "scope" accordingly. If you find the same underlying setting exposed in two places, give BOTH controls the identical "settingKey" and their own distinct "scope". That pairing is what lets the harness warn the next agent.

Go looking for those pairs rather than waiting to stumble on them. Whenever you find a panel of defaults, spend steps hunting for where the same settings are overridden for a single document — and vice versa. A pair you never looked for is indistinguishable, in the finished map, from a setting that genuinely lives in one place, and it is the failure the next agent cannot detect on its own.`;

const NODES_SCHEMA = {
	type: "array" as const,
	description:
		"Every surface you visited and every notable control you found. Controls that edit the same underlying setting from different places MUST share a settingKey and differ in scope — that is how the harness detects scope ambiguity.",
	items: {
		type: "object" as const,
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
};

const EDGES_SCHEMA = {
	type: "array" as const,
	description: "How to reach each surface from another.",
	items: {
		type: "object" as const,
		properties: {
			from: { type: "string", description: 'Source node id (use "root" for the app\'s initial surface).' },
			to: { type: "string", description: "Destination node id." },
			action: { type: "string", description: 'How to traverse, e.g. \'click "Brand Kit"\'.' },
		},
		required: ["from", "to", "action"],
	},
};

const HOME_SCHEMA = {
	type: "object" as const,
	description:
		"Where a task run should start: the app's ordinary landing view, and the navigation control that returns there from anywhere. Used only to reset the app before a run; never shown to the task agent.",
	properties: {
		surface: { type: "string", description: "Node id of that landing surface." },
		control: {
			type: "string",
			description: "Label of the control that navigates there, EXACTLY as it appears in observations — it is matched literally against element labels.",
		},
		description: { type: "string", description: 'What is on screen once it is reached, e.g. "left-rail Library view".' },
	},
	required: ["surface", "control", "description"],
};

const EXTRA_TOOLS: Anthropic.Tool[] = [
	{
		name: "record",
		description:
			"Record one finding for the grounding notes, and optionally the graph nodes/edges you just learned. Checkpointed to disk immediately and preserved across context resets.",
		input_schema: {
			type: "object",
			properties: { finding: { type: "string" }, nodes: NODES_SCHEMA, edges: EDGES_SCHEMA },
			required: ["finding"],
		},
	},
	{
		name: "dismiss",
		description:
			"Deliberately skip frontier controls you have decided not to operate. Give names, a surface, or both — a surface with no names clears every remaining control in that surface.",
		input_schema: {
			type: "object",
			properties: {
				names: { type: "array", items: { type: "string" }, description: "Exact control labels as printed in the frontier listing." },
				surface: { type: "string", description: 'The containing surface as printed in the frontier listing, e.g. "Brand Kit". Omit to match any surface.' },
				reason: { type: "string", description: "Why these are not worth operating. Published with the map." },
			},
			required: ["reason"],
		},
	},
	{
		name: "finish",
		description:
			"End exploration and emit BOTH artifacts: the prose grounding document (read by the task agent) and the structured graph (queried by code). Refused while the frontier is non-empty.",
		input_schema: {
			type: "object",
			properties: {
				document: { type: "string", description: "The prose grounding document (markdown), as described in your instructions." },
				nodes: NODES_SCHEMA,
				edges: EDGES_SCHEMA,
				home: HOME_SCHEMA,
			},
			required: ["document", "nodes", "edges", "home"],
		},
	},
];

/**
 * Machine-readable stamp distinguishing autonomous exploration output from
 * hand-curated notes. loadGrounding() in agent.ts treats unstamped appmaps as
 * "curated" and the run log records the difference — hand edits to a stamped
 * file MUST remove the stamp (or move the file to docs/recipes/).
 */
const provenanceHeader = (p: {
	app: string;
	actions: number;
	elapsed: string;
	findings: number;
	backend: string;
	findCalls: number;
	guidance?: string;
	salvaged?: boolean;
	stopped: string;
	seen: number;
	actuated: number;
	dismissed: number;
	surfaces: number;
	chapters: number;
}): string =>
	`<!-- provenance: explore | app: ${p.app} | date: ${new Date().toISOString().slice(0, 10)} | backend: ${p.backend} | actions: ${p.actions} | elapsed: ${p.elapsed} | findings: ${p.findings} | finds: ${p.findCalls}` +
	` | controls: ${p.actuated} actuated / ${p.dismissed} dismissed / ${p.seen} seen | surfaces: ${p.surfaces} | chapters: ${p.chapters} | stopped: ${p.stopped}` +
	`${p.guidance ? " | operator-guidance: yes" : ""}${p.salvaged ? " | salvaged: session died before finish" : ""} -->\n` +
	"<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->\n" +
	"<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->\n\n";

const hm = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60000));

	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const backendIdx = argv.indexOf("--backend");
	// `--url` is VALUE-bearing, like --backend and unlike --record: parsed as a pair, or its
	// value falls through into the positionals and is read as the guidance string.
	let target: Target;
	let afterUrl: string[];
	try {
		({ target, rest: afterUrl } = parseTarget(argv, "Notion Calendar"));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	const bi = afterUrl.indexOf("--backend");
	let positional = afterUrl.filter((_, i) => bi < 0 || (i !== bi && i !== bi + 1));
	const app = target.kind === "web" ? targetLabel(target) : (positional[0] ?? "Notion Calendar");
	// parseTarget returns the FALLBACK name for an app run, not the positional, so the slug
	// below would stamp this pass's output to "notion-calendar" no matter which app was named —
	// overwriting another app's committed map. Rebuild the target from the resolved name.
	if (target.kind === "app") target = { kind: "app", name: app };
	// `buildRunArgs` keeps the label in positional 0 for a web target too, so that guidance
	// stays where every caller already puts it. Drop it here rather than teaching the guidance
	// slot to move — a shifted positional is how a target name becomes a safety instruction.
	if (target.kind === "web" && positional[0] === app) positional = positional.slice(1);
	// Optional per-run guidance: relaxes or tightens the safety rules for this app
	// (e.g. "creating a draft is allowed; use <address> if a form needs an email").
	const guidance = target.kind === "web" ? positional[0] : positional[1];
	// A web target defaults to the CDP backend: it snapshots the page rather than the window,
	// so the browser's own tab strip, omnibox and menu bar never reach the frontier.
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : target.kind === "web" ? "dom" : "ax";
	if (!["ax", "dom"].includes(backendKind)) {
		console.error('usage: tsx src/explore.ts ["App Name" | --url <https://…>] ["guidance"] [--backend ax|dom]');
		process.exit(1);
	}
	const { client, model } = makeClient();
	// A grounding pass clicks through the whole app for minutes on end — same takeover as a
	// task run, different colour so the mode is readable at a glance.
	const overlay = startOverlay("explore", `Agent exploring ${app} — do not touch`);
	const driver = await Driver.start("explore");
	const interrupted = onInterrupt(() => driver.close());
	const findings: string[] = [];
	const slug = targetSlug(target);
	const outPath = `${appmapsDir()}/${slug}.md`;
	const graphPath = `${appmapsDir()}/${slug}.json`;
	fs.mkdirSync(appmapsDir(), { recursive: true });
	fs.mkdirSync(`${OUT}/runs`, { recursive: true });

	// Declared out here, not in the try, because the salvage path in the catch needs them:
	// the transcript IS the pass's memory, and a throw must not put it out of reach.
	const messages: Anthropic.MessageParam[] = [];
	let tools: Anthropic.Tool[] = [];
	let basePrompt = "";
	let actions = 0;
	let findCalls = 0;
	let chapters = 1;
	let refusals = 0;
	const startedAt = Date.now();
	// Upstream providers this pass has watched fail. Fed back to OpenRouter as an ignore list so
	// a retry is routed elsewhere; a plain backoff re-asks the same broken host. An exploration
	// pass is 40 minutes of actions, so losing it to one bad route is the expensive case.
	const badProviders = new Set<string>();
	const noteProvider = (attempt: number, e: unknown): void => {
		const provider = failedProvider(e);
		if (provider && !badProviders.has(provider)) {
			badProviders.add(provider);
			console.log(`  routing around provider "${provider}" for the rest of this pass`);
		}
		console.log(`  retry ${attempt} after transient API error: ${(e as Error).message}`);
	};
	const ledger = newFrontier();

	/**
	 * The graph, accumulated as the pass goes rather than assembled at the end.
	 *
	 * Everything learned used to live only in the transcript until "finish", which made a
	 * truncated pass a weak map and a crashed pass nothing at all. Accumulating here is what
	 * makes the two things below safe: resetting the context (the model need not remember
	 * chapter 1 at hour 11) and being killed (the checkpoint on disk is already current).
	 */
	const graphNodes = new Map<string, AppMapNode>();
	const graphEdges = new Map<string, AppMapEdge>();
	const merge = (g: GraphInput): number => mergeGraph(graphNodes, graphEdges, g);

	const coverageNow = (stopped: string) => ({
		seen: ledger.seen.size,
		actuated: [...ledger.actuated].filter((k) => ledger.seen.has(k)).length,
		dismissed: ledger.dismissed.size,
		surfaces: new Set([...ledger.seen.values()].map((e) => e.surface)).size,
		chapters,
		stopped,
		dismissals: [...new Set(ledger.dismissed.values())],
	});

	/**
	 * Crash insurance. Deliberately NOT written to docs/appmaps/: a pass that dies at action
	 * 3 would otherwise overwrite a good 45-node map with two nodes, which is worse than the
	 * loss it is meant to prevent. Promote a checkpoint by hand if a run is killed.
	 */
	const stamp = runKey("explore-", app);
	const checkpointPath = `${OUT}/runs/${stamp}.checkpoint.json`;
	const checkpoint = (): void => {
		fs.writeFileSync(
			checkpointPath,
			JSON.stringify(
				{
					// Shaped as a valid AppMap so a killed run's checkpoint can be promoted to
					// docs/appmaps/<slug>.json as-is, without hand-adding fields.
					app,
					capturedAt: new Date().toISOString(),
					provenance: "explore",
					actions,
					elapsed: hm(Date.now() - startedAt),
					coverage: coverageNow("in-progress"),
					findings,
					nodes: [...graphNodes.values()],
					edges: [...graphEdges.values()],
				},
				null,
				2,
			),
		);
	};

	const writeArtifacts = (out: FinishInput, stopped: StopReason, salvaged = false): void => {
		merge(out);
		// The finish payload is the largest single generation of the run, so it is the most
		// likely place for nodes/edges to be serialised into the prose instead of alongside it.
		// Recovering here also strips the markup from the document that goes into the prompt.
		const recovered = recoverLeakedGraph(out.document);
		merge(recovered);
		const cov = coverageNow(stopped);
		// Checked, not trusted: this one field is written once and then silently governs the
		// start state of every future run, so a label the pass never actually saw would be a
		// permanent, invisible "failed" reset. Dropping it costs the normalisation and keeps
		// the readiness check, which is the safe way round.
		const { home, problem } = checkHome(out.home, [...graphNodes.values()], [...graphEdges.values()]);
		if (problem) console.log(`WARNING: discarding declared home — ${problem}`);
		const elapsed = hm(Date.now() - startedAt);
		const prose =
			provenanceHeader({ app, actions, elapsed, findings: findings.length, backend: backendKind, findCalls, guidance, salvaged, ...cov }) +
			recovered.cleaned;
		fs.writeFileSync(outPath, prose);
		console.log(`\n=== exploration ${salvaged ? "SALVAGED" : "finished"} after ${actions} actions, ${elapsed}, ${findings.length} findings ===`);
		console.log(`stopped: ${stopped} | controls: ${cov.actuated} actuated / ${cov.dismissed} dismissed / ${cov.seen} seen across ${cov.surfaces} surfaces | chapters: ${chapters}`);
		if (refusals > 0) console.log(`safety guard refused ${refusals} action(s) on destructive-looking labels`);
		console.log(`grounding notes: ${outPath}`);

		const graph: AppMap = {
			app,
			capturedAt: new Date().toISOString(),
			provenance: "explore",
			proseSha256: createHash("sha256").update(prose).digest("hex").slice(0, 12),
			elapsed,
			coverage: cov,
			...(home ? { home } : {}),
			nodes: [...graphNodes.values()],
			edges: [...graphEdges.values()],
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

	/**
	 * Ask for the map when the loop ends for a reason other than the model choosing to
	 * finish (action ceiling, dead session). One model call, tool_choice pinned,
	 * no driver needed — everything required is already in the transcript and the graph.
	 */
	const requestFinish = async (why: string, stopped: StopReason, salvaged: boolean): Promise<void> => {
		messages.push({ role: "user", content: why });
		// Streamed, like the loop call: the SDK refuses a non-streaming request whose
		// max_tokens could exceed a 10-minute generation, and the finish payload is the
		// largest thing this program asks for.
		const rescue = await retryTransient(
			() =>
				client.messages
					.stream({
						model,
						max_tokens: 32000,
						system: guidance ? `${basePrompt}\n\n# Operator guidance for this run\n${guidance}` : basePrompt,
						tools,
						tool_choice: { type: "tool", name: "finish" },
						messages,
						...providerRouting(badProviders),
					})
					.finalMessage(),
			{ onRetry: (n, e) => noteProvider(n, e) },
		);
		const out = rescue.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		if (!out) throw new Error("model did not emit finish");
		writeArtifacts(out.input as FinishInput, stopped, salvaged);
	};

	try {
		// A web target has no app to launch: the driver brings up its own Chromium against a
		// persistent profile and navigates it, which is also what makes a logged-in site
		// reachable without handling credentials here.
		let win: WindowRef;
		if (target.kind === "web") {
			({ win } = await ensureBrowser(driver, target, { cdp: backendKind === "dom" }));
		} else {
			await driver.act({ kind: "tool", name: "launch_app", args: { name: app } });
			await new Promise((r) => setTimeout(r, 1500));
			// Reassigned by ensureObservable — see the same call in src/agent.ts.
			win = await findWindow(driver, app);
		}
		// Last chance to take your hands off before the run owns the pointer.
		await overlay.countdown();
		// Exploration runs once and its whole purpose is coverage, so it exhausts the
		// continuation chain on every observation — the opposite tradeoff from the agent
		// loop, which re-observes after every action and pays per-step for depth.
		const dom =
			backendKind === "dom"
				? await DomBackend.bind(driver, win, Infinity, target.kind === "web" ? target.origin : undefined)
				: undefined;
		if (!dom) win = await ensureObservable(driver, win, app);
		// webAreaOnly keeps the browser's own tab strip, omnibox and menu bar out of the
		// frontier on the AX fallback. A no-op for a Mac app, and unreachable on the DOM
		// backend, which snapshots the page rather than the window.
		const webAreaOnly = target.kind === "web";
		const doObserve = (name: string) => (dom ? dom.observe(name, Infinity) : observe(driver, win, name, { webAreaOnly }));
		tools = dom ? [DOM_ACT_TOOL, FIND_TOOL, ...EXTRA_TOOLS] : [ACT_TOOL, ...EXTRA_TOOLS];
		basePrompt = systemPrompt(dom ? DOM_RULES : DRIVER_RULES, targetVocabulary(target));
		console.log(`exploring ${app} pid=${win.pid} window=${win.windowId} backend=${backendKind}`);
		console.log(`ends when the frontier empties; no time cap, action backstop ${MAX_ACTIONS}\n`);

		let blindStreak = 0;
		// Same handoff as the loop below: the banner starts visible and only a setDriving(false)
		// takes it down, so the opening observation has to be the thing that lowers it — else it
		// sits red through the first (long) model call with the machine idle.
		overlay.setDriving(true);
		let obs: ObservationBundle;
		try {
			obs = await doObserve("explore-step-0");
		} finally {
			overlay.setDriving(false);
		}
		frontierIngest(ledger, obs);
		messages.push({
			role: "user",
			content: [
				{
					type: "text",
					text:
						`Explore "${app}". There is no step budget and no time limit: this run ends when the frontier of un-operated controls is empty. ` +
						"If a surface takes minutes to respond — some apps embed an agent of their own — wait for it rather than moving on.\n\n" +
						`${frontierSummary(ledger)}\n\nInitial observation follows.`,
				},
				...observationBlocks(obs),
			],
		});

		/**
		 * Consecutive finish attempts refused for a non-empty frontier. The refusal is
		 * evidence rather than badgering — it hands back the actual list — so unlike the
		 * one-shot self-audit it replaced it can repeat. But a model that keeps calling
		 * finish and never acts would otherwise spin until the action backstop burning
		 * tokens, so after three the concession is taken and recorded as the stop reason.
		 */
		let finishRefusals = 0;
		let obsThisChapter = 1;

		for (;;) {
			// Same shape as the ceiling below: a stopped pass still asks for the map it has,
			// because forty minutes of exploration are worth more written down than discarded.
			if (interrupted()) {
				console.log(`\nstopped after ${actions} actions — asking for the map now`);
				await requestFinish("The run was stopped. Call finish NOW with the map you have.", "interrupted", true);

				return;
			}

			if (actions >= MAX_ACTIONS) {
				console.log(`\naction ceiling (${MAX_ACTIONS}) reached — asking for the map now`);
				await requestFinish(`The action ceiling of ${MAX_ACTIONS} has been reached. Call finish NOW with the map you have.`, "action-ceiling", false);

				return;
			}

			const response = await retryTransient(
				() =>
					client.messages
						.stream({
							model,
							max_tokens: 32000,
							system: guidance ? `${basePrompt}\n\n# Operator guidance for this run\n${guidance}` : basePrompt,
							tools,
							cache_control: { type: "ephemeral" },
							messages,
							...providerRouting(badProviders),
						})
						.finalMessage(),
				{ onRetry: (n, e) => noteProvider(n, e) },
			);

			if (response.stop_reason === "refusal") throw new Error("model refused");

			const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
			messages.push({ role: "assistant", content: response.content });

			if (!toolUse) {
				messages.push({ role: "user", content: "Call exactly one tool (act, record, dismiss, or finish)." });
				continue;
			}

			if (toolUse.name === "finish") {
				const rest = frontierRemaining(ledger);
				if (rest.length > 0 && ++finishRefusals <= 3) {
					console.log(`  finish refused (${finishRefusals}/3): ${rest.length} control(s) still un-operated`);
					messages.push({
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUse.id,
								content:
									`Not yet — the frontier is not empty, and there is no time limit on this pass.\n\n${frontierSummary(ledger)}\n\n` +
									"Operate the ones that could open a surface you have not mapped. Dismiss the ones that are content rather than navigation, or that you must not touch — with a reason. " +
									"Then finish will be accepted.",
							},
						],
					});
					continue;
				}
				writeArtifacts(toolUse.input as FinishInput, rest.length > 0 ? "frontier-conceded" : "frontier-empty");

				return;
			}

			if (toolUse.name === "record") {
				const input = toolUse.input as { finding: string; nodes?: AppMapNode[]; edges?: AppMapEdge[] };
				// The model sometimes writes its nodes/edges INTO the finding string as literal
				// tool-call markup. Recover them before storing, or the graph silently stalls
				// while the prose keeps growing. See recoverLeakedGraph().
				const leaked = recoverLeakedGraph(input.finding);
				findings.push(leaked.cleaned);
				const merged =
					merge(input) + (leaked.nodes.length || leaked.edges.length ? merge(leaked) : 0);
				const salvaged = leaked.nodes.length + leaked.edges.length;
				console.log(
					`  note: ${leaked.cleaned}${merged ? ` (+${merged} graph${salvaged ? `, ${salvaged} recovered` : ""})` : ""}`,
				);
				// Every record, not every Nth: the write is a few KB of local JSON, and batching
				// it only buys the chance to lose the nine findings since the last flush.
				checkpoint();
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							content: `recorded (${findings.length} findings, graph now ${graphNodes.size} nodes / ${graphEdges.size} edges)`,
						},
					],
				});
				continue;
			}

			if (toolUse.name === "dismiss") {
				const input = toolUse.input as { names?: string[]; surface?: string; reason: string };
				let text: string;
				try {
					// A sweep this wide is one sentence of justification standing in for a hundred
					// separate decisions, and it is how a pass reaches "frontier-empty" cheaply.
					// Refused only when the surface is vague: a genuinely repetitive named panel
					// (80 identical list rows) is exactly what bulk dismissal is for.
					const matches = frontierMatches(ledger, input);
					if (matches.length > DISMISS_CAP && isVagueSurface(input.surface)) {
						const surfaces = [...new Set(matches.map((e) => e.surface || "<top level>"))].slice(0, 12);
						console.log(`  dismiss REFUSED: ${matches.length} controls across ${surfaces.length} surface(s), no specific surface named`);
						messages.push({
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUse.id,
									is_error: true,
									content:
										`Refused: that would dismiss ${matches.length} controls at once (cap ${DISMISS_CAP}) without naming a specific surface. ` +
										"Nothing was dismissed. These are not one decision — dismiss them in groups you can each give a real reason for, " +
										`naming the surface, or open the surface and operate them. Surfaces in that match: ${surfaces.join(", ")}.`,
								},
							],
						});
						continue;
					}
					const gone = frontierDismiss(ledger, input);
					const rest = frontierRemaining(ledger);
					// A silent zero match reads as "done" and the model moves on leaving the
					// entries in place; worse, it retries the same call with cosmetic variants.
					// Naming the surfaces that DO exist turns a wasted turn into a correction.
					text = gone.length
						? `dismissed ${gone.length} control(s). ${rest.length} remain.`
						: `matched NOTHING — nothing was dismissed and ${rest.length} still remain. ` +
							`Surfaces currently on the frontier: ${[...new Set(rest.map((e) => (e.surface ? `"${e.surface}"` : "<top level>")))].slice(0, 20).join(", ")}. ` +
							"Copy a name exactly as the frontier listing prints it.";
					console.log(`  dismiss ${gone.length}${input.surface !== undefined ? ` in "${input.surface}"` : ""}: ${input.reason}`);
					finishRefusals = 0;
				} catch (err) {
					text = `dismiss failed: ${err instanceof Error ? err.message : String(err)}`;
				}
				messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: text }] });
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

			// Unattended-safety pre-flight. A label check over a fixed verb set — it knows
			// nothing about this app. Opting out is its OWN switch (EXPLORE_GUARD=off): this
			// used to ride on `guidance`, so steering the pass silently disarmed the guard.
			const danger = GUARD_ON ? destructiveTarget(input.action, obs, target.kind === "web") : undefined;
			if (danger) {
				refusals++;
				console.log(`  REFUSED: "${danger}" reads destructive and this run is unattended`);
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							is_error: true,
							content:
								`Refused by the harness: the target's label ("${danger}") matches the destructive verb list, and this pass runs unattended. ` +
								"The action did not run. Record what the control appears to do and dismiss it, or reach the surface another way.",
						},
					],
				});
				continue;
			}

			actions++;
			finishRefusals = 0;
			console.log(`[${actions}] ${input.reasoning ?? ""}`);
			console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

			// Credit before acting: the handle and the geometry are only meaningful against
			// the observation the model was looking at when it chose this action.
			const credited = frontierCredit(ledger, input.action, obs);

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

				const settleMs = settleMsFor(input.action, SETTLE_MS);
				if (settleMs > SETTLE_MS) console.log(`    waiting ${Math.round(settleMs / 1000)}s before re-observing`);
				await new Promise((r) => setTimeout(r, settleMs));
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

			const before = ledger.seen.size;
			frontierIngest(ledger, obs);
			const rest = frontierRemaining(ledger);
			const discovered = ledger.seen.size - before;
			console.log(
				`    -> ${credited.length} credited, ${discovered > 0 ? `+${discovered} new, ` : ""}${rest.length} on frontier, ${hm(Date.now() - startedAt)} elapsed`,
			);

			const frontierNote =
				rest.length === 0
					? "\n\nTHE FRONTIER IS EMPTY — every interactive control seen so far has been operated or dismissed. Call finish now, unless you know of a surface you have not opened."
					: `\n\n${frontierSummary(ledger)}`;
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: isError,
						content: [
							{ type: "text", text: `Driver result: ${resultText}${frontierNote}\n\nNew observation follows.` },
							...observationBlocks(obs),
						],
					},
				],
			});

			/**
			 * Chapter boundary: throw the transcript away and start a fresh context.
			 *
			 * Context, not step count, was the real ceiling — each observation is ~7k tokens
			 * and they all accumulate, so a 25-action pass was already ~175k. A sliding
			 * window would not survive a long run either: the assistant turns and tool
			 * results keep piling up over ~2000 actions, and pruning per turn would
			 * invalidate the prompt cache every single turn.
			 *
			 * A full reset is bounded no matter how long the pass runs. It is only safe
			 * because the durable memory now lives outside the transcript — findings and the
			 * accumulated graph, both already on disk — so what is discarded is reasoning,
			 * not knowledge. The frontier goes in the seed as well, which means the reset
			 * cannot lose track of where the pass still has to go.
			 */
			if (++obsThisChapter >= CHAPTER_OBSERVATIONS) {
				chapters++;
				obsThisChapter = 1;
				checkpoint();
				const nodeList = [...graphNodes.values()].slice(0, 300).map((n) => `${n.id} (${n.kind})`).join(", ");
				const noteList = findings.slice(-120).map((f) => `- ${f}`).join("\n");
				console.log(`  --- chapter ${chapters}: context reset (${findings.length} findings, ${graphNodes.size} nodes carried forward) ---`);
				messages.length = 0;
				messages.push({
					role: "user",
					content: [
						{
							type: "text",
							text:
								`You are exploring "${app}" and have been going for ${hm(Date.now() - startedAt)} over ${actions} actions. ` +
								`This is chapter ${chapters}: the earlier transcript has been cleared to bound context. Nothing else has changed — the app is where you left it, and everything below is what you recorded.\n\n` +
								`# Findings so far (${findings.length}${findings.length > 120 ? ", most recent 120 shown" : ""})\n${noteList}\n\n` +
								`# Graph so far (${graphNodes.size} nodes, ${graphEdges.size} edges)\n${nodeList || "(none recorded yet — start recording nodes as you go)"}\n\n` +
								`# ${frontierSummary(ledger)}\n\n` +
								"There is no time limit on this pass — take as long as a surface needs. Current observation follows.",
						},
						...observationBlocks(obs),
					],
				});
			}
		}
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
		if (findings.length === 0 && graphNodes.size === 0) throw err;
		console.error(`\nexploration threw after ${actions} actions: ${err instanceof Error ? err.message : String(err)}`);
		console.log(`salvaging ${findings.length} findings and ${graphNodes.size} graph nodes — no driver needed for this`);
		checkpoint();

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

		try {
			await requestFinish(
				"The driver session has ended, so no further actions are possible and you will get no more observations. " +
					"Call finish NOW and emit the best map you can from what you already saw. Do not describe surfaces you never opened — " +
					"an incomplete map is fine, an invented one is not.",
				"error",
				true,
			);
		} catch (rescueErr) {
			// Last resort: the raw findings, unshaped. Still better than nothing.
			console.error(`salvage call failed: ${rescueErr instanceof Error ? rescueErr.message : String(rescueErr)}`);
			fs.writeFileSync(
				outPath,
				provenanceHeader({
					app,
					actions,
					elapsed: hm(Date.now() - startedAt),
					findings: findings.length,
					backend: backendKind,
					findCalls,
					guidance,
					salvaged: true,
					...coverageNow("error"),
				}) + `# ${app} — grounding notes (raw findings only)\n\n${findings.map((f) => `- ${f}`).join("\n")}`,
			);
			console.log(`wrote ${findings.length} raw findings to ${outPath}`);
			console.log(`graph checkpoint (not promoted to docs/appmaps): ${checkpointPath}`);
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
