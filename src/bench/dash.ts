import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJournal } from "../core/journal.js";
import type { FleetRow } from "../remote/control/fleet.js";
import type { EngineHandle } from "../remote/liveview.js";
import { appSlug, dataRoot } from "../paths.js";
import { appmapSlug } from "../core/target.js";
import { archiveDirFor } from "./collect.js";
import { estimateCost, rollupCost, usd } from "./cost.js";
import { type Arm, armById, flagsLine, MATRIX, type Phase } from "./matrix.js";
import { benchDir, type Manifest, type ManifestEntry, readManifest, utcDate } from "./manifest.js";
import { judgeDisagreements, modelPasses, passLabel, rollup } from "./report.js";

/**
 * `./run dash` — a live web dashboard over the benchmark matrix.
 *
 * The report (docs/research/…-benchmarks.md) is the durable artifact; this is the glanceable
 * one: which Mac is doing what right now, how far the matrix has drained, and the arm
 * comparisons charted as they land. It exists because the orchestrator submits and EXITS —
 * the fleet drains for hours with nothing watching, and `bench collect` is a manual step.
 *
 * Three inputs, three cadences:
 *  - the manifest (fs-watched — an external `bench collect` shows up instantly),
 *  - the fleet (the same `fleetStatus()` ssh fan-out the fleet panel uses, polled),
 *  - `collect()` itself, run on a loop so results land without a human typing collect.
 *    Collect is idempotent and its writes are atomic BY DESIGN (see collect.ts) — a manual
 *    collect racing this loop converges on the same bytes. `--no-collect` makes the
 *    dashboard a pure reader.
 *
 * Everything derived (rollups, cost, judge tallies) reuses the report's own exported math —
 * the dashboard must never disagree with the report over the same manifest.
 */

export interface DashEvent {
	t: string;
	line: string;
}

export interface FleetView {
	rows: FleetRow[];
	polledAt?: string;
	error?: string;
}

/** One manifest entry, enriched with what the fleet says is happening to it RIGHT NOW. */
export interface EntryView {
	jobId: string;
	host: string;
	/** When the manifest accepted the submission — the timeline fallback for jobs not yet started. */
	submittedAt: string;
	collected: boolean;
	/**
	 * running/queued come from the live fleet (authoritative while the poll is fresh);
	 * succeeded/failed kinds from collected metrics; "awaiting-collect" when the job's host
	 * answered and no longer holds it; the manifest's stale state string otherwise.
	 */
	status: string;
	/** Seconds the run has been going (running) or took per its own log (collected). */
	elapsedSec?: number;
	queuePosition?: number;
	stalled?: boolean;
	success?: boolean;
	failureKind?: string;
	steps?: number;
	verifiedSteps?: number;
	modelCalls?: number;
	outputTokens?: number;
	usd?: number;
	docScopeMutations?: number;
	judgeTrajectory?: string;
	judgeVisual?: string;
	queueWaitSec?: number;
	runSec?: number;
	endedAt?: string;
	note?: string;
}

export interface PassView {
	model: string;
	/** Distinct model ids the collected runs actually recorded — divergence from `model` is a finding. */
	ranModels?: string[];
	submitted: number;
	collected: number;
	successes: number;
	usd: number;
	unpriced: number;
	meanSteps?: number;
	meanElapsedSec?: number;
	meanModelCalls?: number;
	meanOutputTokens?: number;
	meanObsNodes?: number;
	meanShownLines?: number;
	rejections: number;
	documentScopeMutations: number;
	failureBreakdown: string;
	/** Explore arms: the stamp + graph numbers, off the one collected entry. */
	explore?: {
		actions?: number;
		elapsed?: string;
		controlsActuated?: number;
		controlsDismissed?: number;
		controlsSeen?: number;
		surfaces?: number;
		graphNodes?: number;
		graphEdges?: number;
		scopeAmbiguities?: number;
	};
	/** Replay arms. */
	replay?: { meanRecipeSteps?: number; meanRescuedSteps?: number };
	entries: EntryView[];
}

export interface ArmView {
	id: string;
	phase: Phase;
	kind: string;
	n: number;
	flags: string;
	app: string;
	/**
	 * The two axes an arm's cryptic name used to fold together ("vision-only explore (AX)"
	 * = sees pixels only, acts via AX). Same semantics as matrix.ts's perceptionLine, with
	 * the element channel named per backend (AX tree vs DOM).
	 */
	perception: string;
	actuation: string;
	/** Task arms: the goal-only prompt the run was given. */
	task?: string;
	/** Web arms: the URL the run pointed at (off the dispatch flags). */
	url?: string;
	informs?: string;
	passes: PassView[];
}

export interface DashState {
	date: string;
	generatedAt: string;
	autoCollect: boolean;
	/**
	 * What "(default)" resolves to in THIS environment (makeClient's key precedence) — a
	 * hint for uncollected passes. The fleet Macs resolve their own env, so collected runs'
	 * ranModels is the truth and always wins in the UI.
	 */
	defaultModel?: string;
	progress: { planned: number; submitted: number; collected: number; running: number; queued: number; successes: number };
	fleet: FleetView;
	arms: ArmView[];
	cost: { totalUsd: number; unpriced: number; passes: Array<{ pass: string; usd: number; priced: number; unpriced: number }> };
	/** Cumulative dollars in collection-time order — the "what has this cost so far" line. */
	costSeries: Array<{ t: string; jobId: string; cumulativeUsd: number }>;
	judge: {
		judged: number;
		trajectory: { pass: number; fail: number; unproven: number };
		visual: { pass: number; fail: number; unproven: number };
		disagreements: Array<{ armId: string; jobId: string; success?: boolean; judgeTrajectory?: string; judgeScope?: string }>;
	};
	/** The narrator's latest plain-English read of the data. Model-written; verify before quoting. */
	narrative?: { updatedAt: string; text: string; model: string };
	events: DashEvent[];
}

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

function liveFor(e: ManifestEntry, fleet: FleetView): Pick<EntryView, "status" | "elapsedSec" | "queuePosition" | "stalled"> {
	const host = fleet.rows.find((r) => r.name === e.host);
	if (host?.jobId === e.jobId)
		return { status: "running", ...(host.elapsedSec !== undefined ? { elapsedSec: host.elapsedSec } : {}), ...(host.stalled ? { stalled: true } : {}) };
	const pos = host?.queue?.findIndex((q) => q.jobId === e.jobId) ?? -1;
	if (pos >= 0) return { status: "queued", queuePosition: pos + 1 };
	// The host answered and doesn't hold the job: it finished and is waiting for a collect
	// pass. An unreachable host proves nothing, so the manifest's last-known state stands.
	if (host?.reachable && host.state !== "unknown") return { status: "awaiting-collect" };

	return { status: e.state };
}

function entryView(e: ManifestEntry, fleet: FleetView): EntryView {
	const m = e.metrics;
	if (e.collected) {
		const cost = m ? estimateCost(m, m.model ?? e.model) : undefined;

		return {
			jobId: e.jobId,
			host: e.host,
			submittedAt: e.submittedAt,
			collected: true,
			status: m?.success === true ? "succeeded" : (m?.failureKind ?? (m?.success === false ? "failed" : "collected")),
			...(m?.success !== undefined ? { success: m.success } : {}),
			...(m?.failureKind ? { failureKind: m.failureKind } : {}),
			...(m?.steps !== undefined ? { steps: m.steps } : {}),
			...(m?.elapsedSec !== undefined ? { elapsedSec: m.elapsedSec } : {}),
			...(m?.verifiedSteps !== undefined ? { verifiedSteps: m.verifiedSteps } : {}),
			...(m?.modelCalls !== undefined ? { modelCalls: m.modelCalls } : {}),
			...(m?.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}),
			...(cost !== undefined ? { usd: cost } : {}),
			...(m?.mutationScopes ? { docScopeMutations: m.mutationScopes.filter((s) => s === "document").length } : {}),
			...(m?.judgeTrajectory ? { judgeTrajectory: m.judgeTrajectory } : {}),
			...(m?.judgeVisual ? { judgeVisual: m.judgeVisual } : {}),
			...(m?.queueWaitSec !== undefined ? { queueWaitSec: m.queueWaitSec } : {}),
			...(m?.runSec !== undefined ? { runSec: m.runSec } : {}),
			...(m?.endedAt ? { endedAt: m.endedAt } : {}),
			...(e.note ? { note: e.note } : {}),
		};
	}

	return { jobId: e.jobId, host: e.host, submittedAt: e.submittedAt, collected: false, ...liveFor(e, fleet) };
}

function passView(arm: Arm, model: string | undefined, entries: ManifestEntry[], fleet: FleetView): PassView {
	const r = rollup(arm, entries);
	const first = r.collected[0]?.metrics;

	const ranModels = [...new Set(r.collected.map((e) => e.metrics?.model).filter((m): m is string => typeof m === "string"))];

	return {
		model: passLabel(model),
		...(ranModels.length ? { ranModels } : {}),
		submitted: entries.length,
		collected: r.collected.length,
		successes: r.successes,
		usd: r.cost.usd,
		unpriced: r.cost.unpriced,
		...(r.meanSteps !== undefined ? { meanSteps: r.meanSteps } : {}),
		...(r.meanElapsedSec !== undefined ? { meanElapsedSec: r.meanElapsedSec } : {}),
		...(r.meanModelCalls !== undefined ? { meanModelCalls: r.meanModelCalls } : {}),
		...(r.meanOutputTokens !== undefined ? { meanOutputTokens: r.meanOutputTokens } : {}),
		...(r.meanObsNodes !== undefined ? { meanObsNodes: r.meanObsNodes } : {}),
		...(r.meanShownLines !== undefined ? { meanShownLines: r.meanShownLines } : {}),
		rejections: r.rejections,
		documentScopeMutations: r.documentScopeMutations,
		failureBreakdown: r.failureBreakdown,
		...(arm.kind === "explore" && first
			? {
					explore: {
						...(first.exploreActions !== undefined ? { actions: first.exploreActions } : {}),
						...(first.exploreElapsed ? { elapsed: first.exploreElapsed } : {}),
						...(first.controlsActuated !== undefined ? { controlsActuated: first.controlsActuated } : {}),
						...(first.controlsDismissed !== undefined ? { controlsDismissed: first.controlsDismissed } : {}),
						...(first.controlsSeen !== undefined ? { controlsSeen: first.controlsSeen } : {}),
						...(first.surfaces !== undefined ? { surfaces: first.surfaces } : {}),
						...(first.graphNodes !== undefined ? { graphNodes: first.graphNodes } : {}),
						...(first.graphEdges !== undefined ? { graphEdges: first.graphEdges } : {}),
						...(first.scopeAmbiguities !== undefined ? { scopeAmbiguities: first.scopeAmbiguities } : {}),
					},
				}
			: {}),
		...(arm.kind === "replay"
			? {
					replay: {
						...(mean(r.collected.map((e) => e.metrics?.recipeSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanRecipeSteps: mean(r.collected.map((e) => e.metrics?.recipeSteps).filter((n): n is number => n !== undefined)) }
							: {}),
						...(mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) !== undefined
							? { meanRescuedSteps: mean(r.collected.map((e) => e.metrics?.rescuedSteps).filter((n): n is number => n !== undefined)) }
							: {}),
					},
				}
			: {}),
		entries: entries.map((e) => entryView(e, fleet)),
	};
}

export interface Narrative {
	updatedAt: string;
	text: string;
	model: string;
}

/**
 * The digest the narrator model reads: the same per-arm rollups the report tabulates,
 * minus per-run noise. Small on purpose — the narrator runs on every landing batch.
 */
export function narratorDigest(state: DashState): Record<string, unknown> {
	return {
		progress: state.progress,
		estCostUsd: state.cost.totalUsd,
		judge: state.judge,
		arms: state.arms
			.filter((a) => a.passes.length)
			.map((a) => ({
				id: a.id,
				kind: a.kind,
				phase: a.phase,
				flags: a.flags,
				...(a.task ? { task: a.task } : {}),
				...(a.informs ? { informs: a.informs } : {}),
				passes: a.passes.map(({ entries, ...p }) => ({ ...p, statuses: entries.map((e) => e.status) })),
			})),
	};
}

export function narratorPrompt(digest: Record<string, unknown>, previous?: string): string {
	return [
		"You are the running commentator on a live benchmark matrix for a self-driving UI agent",
		"(backends: ax = macOS accessibility, cdp = Chrome DevTools Protocol; grounded = the agent",
		"gets an app map from a prior explore pass; explore passes measure discovery). The data",
		"below is per-arm rollups collected so far. Sample sizes are small — say so where it matters.",
		"",
		"Questions the matrix exists to answer (from the plan): which backend to build on;",
		"what grounding buys (actions, tokens, wrong-scope mutations); whether cdp's leaner",
		"observations are denser or blinder (compare explore discovery: controls seen/actuated,",
		"surfaces, graph nodes, scope ambiguities); what vision costs/buys; whether recipe replay",
		"is fleet-ready; judge disagreements with self-reports.",
		"",
		"Write 2-5 short paragraphs of plain-English findings the CURRENT data actually supports.",
		"Lead with whatever is newest or most decision-relevant. Use concrete numbers and ratios.",
		"Never speculate past the data; an empty cell is 'not in yet', not a finding. Plain prose,",
		"no headers, no bullet lists, no markdown emphasis.",
		...(previous ? ["", "Your previous note (readers have seen it — lead with what CHANGED):", previous] : []),
		"",
		"Data:",
		JSON.stringify(digest, null, 1),
	].join("\n");
}

export function buildState(manifest: Manifest, fleet: FleetView, events: DashEvent[], autoCollect: boolean, defaultModel?: string): DashState {
	const perceptionOf = (arm: Arm): string => {
		const els = arm.dispatch.backend === "cdp" ? "DOM" : "AX";
		const { noAx, noVision, axdomOff } = arm.dispatch;
		const base = noAx && noVision ? "nothing" : noAx ? "vision only" : noVision ? `${els} only` : `${els} + vision`;

		return axdomOff ? `${base}, axdom off` : base;
	};

	const arms: ArmView[] = MATRIX.map((arm) => ({
		id: arm.id,
		phase: arm.phase,
		kind: arm.kind,
		n: arm.n,
		flags: flagsLine(arm),
		app: arm.app,
		perception: perceptionOf(arm),
		actuation: (arm.dispatch.backend ?? "ax").toUpperCase(),
		...(arm.task ? { task: arm.task } : {}),
		...(arm.dispatch.url ? { url: arm.dispatch.url } : {}),
		...(arm.informs ? { informs: arm.informs } : {}),
		passes: modelPasses(manifest, arm.id)
			.map((model) => passView(arm, model, manifest.entries.filter((e) => e.armId === arm.id && e.model === model), fleet))
			.filter((p) => p.submitted > 0),
	}));

	const allEntries = arms.flatMap((a) => a.passes.flatMap((p) => p.entries));
	const collectedEntries = manifest.entries.filter((e) => e.collected);

	// Per model pass, same grouping as the report's cost section: only dollars are summed.
	const byPass = new Map<string, ManifestEntry[]>();
	for (const e of collectedEntries) byPass.set(passLabel(e.model), [...(byPass.get(passLabel(e.model)) ?? []), e]);
	const passes = [...byPass].map(([pass, entries]) => {
		const c = rollupCost(entries.map((e) => ({ ...e.metrics, ...(e.metrics?.model ? { model: e.metrics.model } : e.model ? { model: e.model } : {}) })));

		return { pass, usd: c.usd, priced: c.priced, unpriced: c.unpriced };
	});

	// Cumulative cost in the order runs ENDED (submit time as the fallback for artifacts
	// without job timing) — the line an operator reads as "spend so far".
	let cumulative = 0;
	const costSeries = collectedEntries
		.map((e) => ({ e, t: e.metrics?.endedAt ?? e.metrics?.startedAt ?? e.submittedAt, cost: e.metrics ? estimateCost(e.metrics, e.metrics.model ?? e.model) : undefined }))
		.filter((x) => x.cost !== undefined)
		.sort((a, b) => a.t.localeCompare(b.t))
		.map((x) => ({ t: x.t, jobId: x.e.jobId, cumulativeUsd: (cumulative += x.cost as number) }));

	const judged = collectedEntries.filter((e) => e.metrics?.judgeTrajectory !== undefined);
	const tally = (pick: (e: ManifestEntry) => string | undefined) => ({
		pass: judged.filter((e) => pick(e) === "PASS").length,
		fail: judged.filter((e) => pick(e) === "FAIL").length,
		unproven: judged.filter((e) => pick(e) === "UNPROVEN").length,
	});

	return {
		date: manifest.date,
		generatedAt: new Date().toISOString(),
		autoCollect,
		...(defaultModel ? { defaultModel } : {}),
		progress: {
			planned: MATRIX.reduce((sum, a) => sum + a.n, 0),
			submitted: manifest.entries.length,
			collected: collectedEntries.length,
			running: allEntries.filter((e) => e.status === "running").length,
			queued: allEntries.filter((e) => e.status === "queued").length,
			successes: collectedEntries.filter((e) => e.metrics?.success === true).length,
		},
		fleet,
		arms,
		cost: { totalUsd: passes.reduce((s, p) => s + p.usd, 0), unpriced: passes.reduce((s, p) => s + p.unpriced, 0), passes },
		costSeries,
		judge: {
			judged: judged.length,
			trajectory: tally((e) => e.metrics?.judgeTrajectory),
			visual: tally((e) => e.metrics?.judgeVisual),
			disagreements: judgeDisagreements(manifest.entries).map((e) => ({
				armId: e.armId,
				jobId: e.jobId,
				...(e.metrics?.success !== undefined ? { success: e.metrics.success } : {}),
				...(e.metrics?.judgeTrajectory ? { judgeTrajectory: e.metrics.judgeTrajectory } : {}),
				...(e.metrics?.judgeScope ? { judgeScope: e.metrics.judgeScope } : {}),
			})),
		},
		events: events.slice(-100),
	};
}

/** ---- run detail: the appmap graph + the path a run took through it ---------------------- */

export interface DetailStep {
	index: number;
	/** What the step did, human-readable: the element it acted on, or the keys/text it sent. */
	label: string;
	kind: string;
	verified: boolean;
	channel?: string;
	reasoning?: string;
	/** Where the run believed it was after this step (graph surface id). */
	surface?: string;
	/** Matched graph node (control) this step acted on. */
	nodeId?: string;
	/** Matched navigation edge (surface transition) this step performed. */
	edgeTo?: string;
}

export interface DashDetail {
	jobId: string;
	armId: string;
	graph?: { nodes: any[]; edges: any[]; home?: string; gated?: string[] };
	/** Where the graph came from — archived arm map, live docs/appmaps, or nothing. */
	graphSource?: string;
	steps: DetailStep[];
	/** settingKeys the run's journal recorded as actually mutated. */
	mutatedKeys: string[];
	/**
	 * Traversal counts over THIS graph aggregated across every collected task/replay run
	 * that consumed it (same grounding arm + model pass) — the tree view's heat. Keyed by
	 * node id, so it is per-graph by construction: ax and cdp maps name nodes differently.
	 */
	heat?: { surfaces: Record<string, number>; controls: Record<string, number>; runs: number };
	note?: string;
}

function heatFor(
	graph: NonNullable<DashDetail["graph"]>,
	exploreArmId: string,
	model: string | undefined,
	manifest: Manifest,
	dataDir: string,
): DashDetail["heat"] {
	const out = { surfaces: {} as Record<string, number>, controls: {} as Record<string, number>, runs: 0 };
	for (const e of manifest.entries) {
		if (!e.collected || e.model !== model) continue;
		const a = armById(e.armId);
		if (!a || a.kind === "explore" || a.kind === "compile" || groundingArmId(a) !== exploreArmId) continue;
		const runLog = readJsonFile(path.join(dataDir, "out", "runs", `${e.jobId}.json`));
		const rawSteps = Array.isArray(runLog?.steps) ? runLog.steps : [];
		if (!rawSteps.length) continue;
		out.runs++;
		for (const st of matchPath(graph, rawSteps)) {
			if (st.edgeTo) out.surfaces[st.edgeTo] = (out.surfaces[st.edgeTo] ?? 0) + 1;
			if (st.nodeId) out.controls[st.nodeId] = (out.controls[st.nodeId] ?? 0) + 1;
		}
	}

	return out;
}

/**
 * Which phase-1 explore produced the map a task arm ran against. Mirrors how orchestrate
 * grounds the arms: web arms read the web explore, APPMAP_VARIANT=vision reads the
 * vision-only pass, otherwise the arm's own backend's map.
 */
export function groundingArmId(arm: Arm): string {
	if (arm.dispatch.url || arm.id.startsWith("p2-web")) return "p1-explore-web-cdp";
	if (arm.env?.APPMAP_VARIANT === "vision") return "p1-explore-vision";
	if (arm.dispatch.backend === "cdp") return "p1-explore-cdp";

	return "p1-explore-ax";
}

const stepLabel = (a: Record<string, any>, s: Record<string, any>): { label: string; kind: string } => {
	if (s.targetName) return { label: String(s.targetName), kind: a.kind === "tool" ? String(a.name ?? "act") : String(a.kind) };
	if (a.kind === "type") return { label: `type "${a.text}"`, kind: "type" };
	if (a.kind === "key") return { label: `key ${a.key}`, kind: "key" };
	if (a.kind === "hotkey") return { label: `keys ${(a.keys ?? []).join("+")}`, kind: "hotkey" };
	if (a.kind === "scroll") return { label: `scroll ${a.direction}`, kind: "scroll" };
	if (a.kind === "tool") return { label: String(a.name ?? "tool"), kind: "tool" };

	return { label: a.kind ?? "action", kind: String(a.kind ?? "action") };
};

/**
 * Walk a run's steps through the appmap graph. Matching is by the names the run RESOLVED
 * (StepRecord.targetName — what was actually clicked), against edge actions' quoted names
 * (`click "Brand Kit" …` → the root→brand-kit transition) and control titles, preferring
 * matches under the surface the walk currently stands on. Heuristic by construction — an
 * unmatched step stays in the list unanchored rather than being guessed onto the map.
 */
export function matchPath(graph: { nodes: any[]; edges: any[] }, rawSteps: Array<Record<string, any>>): DetailStep[] {
	const norm = (s: string): string => s.trim().toLowerCase();
	const controls = graph.nodes.filter((n) => n.kind === "control");
	let surface = "root";

	return rawSteps.map((s) => {
		const { label, kind } = stepLabel(s.action ?? {}, s);
		const out: DetailStep = {
			index: s.index,
			label,
			kind,
			verified: s.verified === true,
			...(s.verificationChannel ? { channel: String(s.verificationChannel) } : {}),
			...(s.modelReasoning ? { reasoning: String(s.modelReasoning) } : {}),
		};
		const name = s.targetName ? norm(String(s.targetName)) : undefined;
		if (name) {
			// Surface transition first: an edge whose quoted name is what was clicked.
			const edges = graph.edges.filter((e) => {
				const quoted = String(e.action ?? "").match(/"([^"]+)"/)?.[1];

				return quoted !== undefined && norm(quoted) === name;
			});
			const edge = edges.find((e) => e.from === surface) ?? edges[0];
			if (edge) {
				surface = String(edge.to);
				out.edgeTo = surface;
			} else {
				const hits = controls.filter((n) => norm(String(n.title ?? "")) === name);
				const hit = hits.find((n) => String(n.id).startsWith(`${surface}/`)) ?? hits[0];
				if (hit) out.nodeId = String(hit.id);
			}
		}
		out.surface = surface;

		return out;
	});
}

const readJsonFile = (file: string): Record<string, any> | undefined => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** The archived graph for an explore arm's pass, else the live docs/appmaps copy. */
function resolveGraph(
	entry: ManifestEntry,
	exploreArmId: string,
	app: string,
	benchRoot: string,
	dataDir: string,
): { graph?: DashDetail["graph"]; source?: string } {
	const archive = archiveDirFor(benchRoot, { ...entry, armId: exploreArmId });
	try {
		const file = fs.readdirSync(archive).find((f) => f.endsWith(".json"));
		if (file) {
			const g = readJsonFile(path.join(archive, file));
			if (g?.nodes) return { graph: shapeGraph(g), source: `${exploreArmId} pass (archived)` };
		}
	} catch {
		// No archive for that arm yet — fall through to the live map.
	}
	// appmapSlug, not appSlug: a web arm's `app` is a URL, and appSlug turns
	// https://app.notion.com into `https-app.notion.com` while the pass wrote
	// `web-app.notion.com`. The dash then reported no map for a 471-node map that existed.
	const slug = appmapSlug(app);
	const live = readJsonFile(path.join(dataDir, "docs", "appmaps", `${slug}.json`));
	if (live?.nodes) return { graph: shapeGraph(live), source: `docs/appmaps/${slug}.json (live)` };

	return {};
}

/** The graph fields the page renders — including gated node ids, the per-node "refused" signal. */
function shapeGraph(g: Record<string, any>): NonNullable<DashDetail["graph"]> {
	const gated = Array.isArray(g.gated) ? g.gated.map((x: any) => String(x?.id)).filter(Boolean) : [];

	return {
		nodes: g.nodes,
		edges: g.edges ?? [],
		...(g.home ? { home: String(g.home) } : {}),
		...(gated.length ? { gated } : {}),
	};
}

/** Everything the board's dropdown needs for one run: the map, the walk, the mutations. */
export function buildDetail(jobId: string, manifest: Manifest, opts: { dataDir?: string; benchRoot?: string } = {}): DashDetail {
	const dataDir = opts.dataDir ?? dataRoot();
	const benchRoot = opts.benchRoot ?? benchDir(manifest.date);
	const entry = manifest.entries.find((e) => e.jobId === jobId);
	if (!entry) return { jobId, armId: "?", steps: [], mutatedKeys: [], note: "no manifest entry for this job" };
	const arm = armById(entry.armId);
	if (!arm) return { jobId, armId: entry.armId, steps: [], mutatedKeys: [], note: "unknown arm" };

	const exploreArmId = arm.kind === "explore" ? arm.id : groundingArmId(arm);
	const { graph, source } = resolveGraph(entry, exploreArmId, arm.app, benchRoot, dataDir);

	const notes: string[] = [];
	if (!graph) notes.push("no appmap graph found for this arm yet");
	if (arm.kind === "explore") notes.push("grounding pass — the map IS the output; there is no task path");
	if (flagsLine(arm).includes("NO_GROUNDING")) notes.push("ungrounded run — the agent never saw this map; the walk is reconstructed for comparison");

	let steps: DetailStep[] = [];
	if (arm.kind !== "explore") {
		const runLog = readJsonFile(path.join(dataDir, "out", "runs", `${jobId}.json`));
		const rawSteps: Array<Record<string, any>> = Array.isArray(runLog?.steps) ? runLog.steps : [];
		if (!runLog) notes.push("run log not on this machine yet — collect pulls it when the run lands");
		steps = graph ? matchPath(graph, rawSteps) : rawSteps.map((s) => ({ ...stepLabel(s.action ?? {}, s), index: s.index, verified: s.verified === true }));
	}

	const mutatedKeys = [
		...new Set(
			readJournal(path.join(dataDir, "out", "runs", `${jobId}.journal.jsonl`))
				.filter((m) => m.kind === "setting")
				.map((m) => (m as Record<string, any>).settingKey)
				.filter((k): k is string => typeof k === "string"),
		),
	];

	return {
		jobId,
		armId: entry.armId,
		...(graph ? { graph } : {}),
		...(source ? { graphSource: source } : {}),
		steps,
		mutatedKeys,
		...(graph ? { heat: heatFor(graph, exploreArmId, entry.model, manifest, dataDir) } : {}),
		...(notes.length ? { note: notes.join("; ") } : {}),
	};
}

/** ---- server ---------------------------------------------------------------------------- */

const FLEET_POLL_SEC = Number(process.env.DASH_FLEET_SEC ?? 20);
const COLLECT_SEC = Number(process.env.DASH_COLLECT_SEC ?? 60);

export interface DashOptions {
	port: number;
	date: string;
	autoCollect: boolean;
}

/** CLI flags shared by the web entry (main below) and the Electron shell (electron/dash.ts). */
export function parseDashArgs(args: string[]): DashOptions {
	const flag = (name: string): string | undefined => {
		const i = args.indexOf(name);

		return i >= 0 ? args[i + 1] : undefined;
	};

	return {
		port: Number(flag("--port") ?? process.env.DASH_PORT ?? 4642),
		date: flag("--date") ?? utcDate(),
		autoCollect: !args.includes("--no-collect"),
	};
}

/**
 * The page ships beside this module in the source tree, but tsc does not copy .html into
 * dist-electron — so the compiled module walks back to the repo's src copy. Resolved once
 * at startup so a missing page fails loudly at launch, not on first request.
 */
function resolveHtml(): string {
	const candidates = [new URL("./dash.html", import.meta.url), new URL("../../../src/bench/dash.html", import.meta.url)];
	for (const url of candidates) {
		const p = fileURLToPath(url);
		if (fs.existsSync(p)) return p;
	}

	throw new Error(`dash.html not found near ${import.meta.url}`);
}

export async function startDash(opts: DashOptions): Promise<http.Server> {
	const { port, date, autoCollect } = opts;

	let manifest = readManifest(date);
	let fleet: FleetView = { rows: [] };
	const events: DashEvent[] = [];
	const clients = new Set<http.ServerResponse>();

	// What "(default)" would run HERE — the same key precedence makeClient applies. A hint
	// for uncollected passes only; keyless environments just leave it blank.
	let defaultModel: string | undefined;
	try {
		defaultModel = (await import("../core/harness/model.js")).makeClient().model;
	} catch {
		// No usable key on this machine — collected runs will supply the truth.
	}

	const addEvent = (line: string): void => {
		events.push({ t: new Date().toISOString(), line });
		if (events.length > 200) events.shift();
	};

	let narrative: Narrative | undefined;

	const push = (): void => {
		const state = buildState(manifest, fleet, events, autoCollect, defaultModel);
		if (narrative) state.narrative = narrative;
		const data = `data: ${JSON.stringify(state)}\n\n`;
		for (const res of clients) res.write(data);
	};

	// The narrator: when a landing batch changes what is known, ask the default model for a
	// plain-English read of the rollups. A commentator, not an authority — its note renders
	// with a "verify before quoting" sub and appends to narrative.md beside the manifest.
	// DASH_NARRATE=0 disables; a keyless environment just logs and moves on.
	let narratedCount = -1;
	let narrating = false;
	const narrate = async (): Promise<void> => {
		if (process.env.DASH_NARRATE === "0" || narrating) return;
		const collectedCount = manifest.entries.filter((e) => e.collected).length;
		if (collectedCount === 0 || collectedCount === narratedCount) return;
		narrating = true;
		try {
			const { makeClient } = await import("../core/harness/model.js");
			const { client, model } = makeClient();
			const digest = narratorDigest(buildState(manifest, fleet, [], autoCollect, defaultModel));
			const res = await client.messages.create({
				model,
				max_tokens: 1000,
				messages: [{ role: "user", content: narratorPrompt(digest, narrative?.text) }],
			});
			const text = (res.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n")
				.trim();
			if (!text) throw new Error("model returned no text");
			narratedCount = collectedCount;
			narrative = { updatedAt: new Date().toISOString(), text, model };
			fs.appendFileSync(
				path.join(benchDir(date), "narrative.md"),
				`\n## ${narrative.updatedAt} — ${collectedCount} collected (${model})\n\n${text}\n`,
			);
			addEvent(`narrator: note updated (${collectedCount} collected)`);
			push();
		} catch (e) {
			addEvent(`narrator failed: ${(e as Error).message}`);
		} finally {
			narrating = false;
		}
	};

	// The manifest is replaced atomically (temp + rename), so watch the DIRECTORY — a rename
	// never fires a change event on the watched file itself. Debounced because one collect
	// pass rewrites the manifest once per entry.
	fs.mkdirSync(benchDir(date), { recursive: true });
	let watchTimer: NodeJS.Timeout | undefined;
	fs.watch(benchDir(date), () => {
		clearTimeout(watchTimer);
		watchTimer = setTimeout(() => {
			manifest = readManifest(date);
			push();
		}, 300);
	});

	// Fleet poll — lazy import so `buildState` stays importable without the ssh machinery.
	const { fleetStatus } = await import("../remote/control/fleet.js");
	let polling = false;
	const pollFleet = async (): Promise<void> => {
		if (polling) return;
		polling = true;
		try {
			fleet = { rows: await fleetStatus(), polledAt: new Date().toISOString() };
		} catch (e) {
			fleet = { ...fleet, error: (e as Error).message };
			addEvent(`fleet poll failed: ${(e as Error).message}`);
		} finally {
			polling = false;
		}
		manifest = readManifest(date);
		push();
	};

	// Collect loop — the "results come in" mechanism. Idempotent by design (collect.ts), so
	// racing a manual `bench collect` converges. Skipped while nothing is uncollected.
	let collecting = false;
	const runCollect = async (): Promise<void> => {
		if (collecting || !manifest.entries.some((e) => !e.collected && e.host !== "local")) return;
		collecting = true;
		try {
			const { collect } = await import("./collect.js");
			const outcome = await collect({ date, log: (line) => addEvent(`collect: ${line}`) });
			if (outcome.collected.length) addEvent(`collect: ${outcome.collected.length} run(s) landed`);
		} catch (e) {
			addEvent(`collect failed: ${(e as Error).message}`);
		} finally {
			collecting = false;
		}
		manifest = readManifest(date);
		push();
	};

	/**
	 * Fleet peek: a view-only live stream of a colo Mac's Chromium target, embedded in its
	 * host card. CDP-transport ONLY, on purpose: the debug port needs no TCC and no runner
	 * involvement — the dash tunnels to it (tunnelArgv, the repo's one ssh builder) and hosts
	 * the screencast engine itself, so nothing ships to the fleet mid-drain. An ax-arm run on
	 * an unflagged app has no endpoint and says so; the SCK path needs a runner verb and waits.
	 *
	 * View-only is structural: the viewer's messages are never forwarded to the engine, so a
	 * stray click cannot corrupt a live benchmark run. One peek at a time — the tunnels map
	 * the remote debug ports onto the SAME local ports (9222/9777), so a second host's peek
	 * preempts the first (last request wins, the fleet's own idiom).
	 */
	interface Peek {
		host: string;
		tunnels: ChildProcess[];
		engine?: EngineHandle;
		sockets: Set<Duplex>;
		idleTimer?: NodeJS.Timeout;
	}
	let peek: Peek | undefined;
	const PEEK_PORTS = [9222, 9777]; // app target · web-Chrome, matching the cdp backend's defaults
	const MAX_QUEUED_PEEK_BYTES = 1.5 * 1024 * 1024;

	const teardownPeek = (): void => {
		if (!peek) return;
		const p = peek;
		peek = undefined;
		clearTimeout(p.idleTimer);
		p.engine?.close();
		for (const t of p.tunnels) t.kill("SIGTERM");
		for (const s of p.sockets) s.destroy();
		addEvent(`peek: closed (${p.host})`);
	};

	const endpointUp = async (port: number): Promise<boolean> => {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });

			return res.ok;
		} catch {
			return false;
		}
	};

	/** Something ACCEPTS on the port, whatever protocol it speaks — the pre-tunnel squatter check. */
	const portAccepts = async (port: number): Promise<boolean> => {
		const { connect } = await import("node:net");

		return new Promise((resolve) => {
			const sock = connect({ port, host: "127.0.0.1" });
			const done = (v: boolean) => {
				sock.destroy();
				resolve(v);
			};
			sock.once("connect", () => done(true));
			sock.once("error", () => done(false));
			setTimeout(() => done(false), 800).unref();
		});
	};

	async function ensurePeek(hostName: string): Promise<{ ok: true } | { ok: false; error: string }> {
		if (peek?.host === hostName && peek.engine) return { ok: true };
		teardownPeek();
		const [{ loadHosts }, { tunnelArgv }] = await Promise.all([import("../remote/control/hosts.js"), import("../remote/control/ssh.js")]);
		const host = loadHosts().hosts.find((h) => h.name === hostName);
		if (!host) return { ok: false, error: `unknown host ${JSON.stringify(hostName)}` };

		// The previous session's tunnels take a beat to release their ports after SIGTERM —
		// wait them out, or switching hosts trips the squatter guard on our own dying ssh.
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		for (let i = 0; i < 20; i++) {
			const held = (await Promise.all(PEEK_PORTS.map(portAccepts))).some(Boolean);
			if (!held) break;
			await sleep(150);
		}

		// The tunnels bind the debug ports LOCALLY. If something STILL listens there — a
		// stale ControlMaster forward, a local debug-flagged Chrome, another operator tool —
		// our ssh dies on ExitOnForwardFailure and the probe below would happily stream from
		// the SQUATTER, showing pixels from the wrong machine. Refuse instead: a peek that
		// might lie about which Mac it shows is worse than no peek.
		for (const port of PEEK_PORTS)
			if (await portAccepts(port))
				return {
					ok: false,
					error: `local port ${port} is held by something that is not this dash (a stale ssh forward or a local debug Chrome) — close it first: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
				};

		const p: Peek = { host: hostName, tunnels: [], sockets: new Set() };
		peek = p;
		for (const port of PEEK_PORTS) p.tunnels.push(spawn("ssh", tunnelArgv(host, port), { stdio: "ignore" }));

		// Which debug port answers decides what we watch: 9222 is the app the run drives,
		// 9777 the web-Chrome. Poll briefly — the tunnel itself takes a moment to come up.
		let endpoint: string | undefined;
		let browserEndpoint: string | undefined;
		for (let tries = 0; tries < 5 && !endpoint; tries++) {
			for (const port of PEEK_PORTS)
				if (!endpoint && (await endpointUp(port))) endpoint = `http://127.0.0.1:${port}`;
				else if (endpoint && !endpoint.endsWith(String(port)) && (await endpointUp(port))) browserEndpoint = `http://127.0.0.1:${port}`;
		}
		if (peek !== p) return { ok: false, error: "superseded by a newer peek" };
		if (!endpoint) {
			teardownPeek();

			return {
				ok: false,
				error: `no CDP debug endpoint reachable on ${hostName} — the current run is likely an ax-arm driving an unflagged app; peek covers Chromium targets only for now`,
			};
		}

		const { connectCdpEngine } = await import("../remote/liveview-cdp.js");
		const engine = await connectCdpEngine({ endpoint, ...(browserEndpoint ? { browserEndpoint } : {}), quality: 80, maxWidth: 1600, app: hostName });
		if (peek !== p) {
			engine.close();

			return { ok: false, error: "superseded by a newer peek" };
		}
		p.engine = engine;
		const { encodeFrame } = await import("../remote/liveview-ws.js");
		const cast = (payload: Buffer, kind: "binary" | "text") => {
			for (const s of p.sockets) {
				if (kind === "binary" && (s as any).writableLength > MAX_QUEUED_PEEK_BYTES) continue;
				try {
					s.write(encodeFrame(payload, kind));
				} catch {
					s.destroy();
				}
			}
		};
		engine.onFrame((jpeg) => cast(jpeg, "binary"));
		engine.onEvent((ev) => cast(Buffer.from(JSON.stringify(ev)), "text"));
		engine.onExit(() => cast(Buffer.from(JSON.stringify({ ev: "error", message: "stream ended — the target closed or the tunnel dropped" })), "text"));
		addEvent(`peek: streaming ${hostName} via ${endpoint}${browserEndpoint ? ` (+${browserEndpoint})` : ""}`);

		return { ok: true };
	}

	const htmlPath = resolveHtml();
	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(htmlPath));
		} else if (url === "/api/state") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(buildState(manifest, fleet, events, autoCollect, defaultModel), null, "\t"));
		} else if (url.startsWith("/api/detail")) {
			const job = new URL(url, "http://localhost").searchParams.get("job") ?? "";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(buildDetail(job, manifest)));
		} else if (url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`data: ${JSON.stringify(buildState(manifest, fleet, events, autoCollect, defaultModel))}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
		} else {
			res.writeHead(404);
			res.end("not found");
		}
	});

	// The peek stream rides a WebSocket on the same port. View-only: inbound text frames are
	// deliberately dropped on the floor (only ping/close are honored), so no viewer — local,
	// LAN, or tunneled through ngrok — can inject input into a machine mid-benchmark.
	server.on("upgrade", async (req, socket: Duplex) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const key = req.headers["sec-websocket-key"];
		if (url.pathname !== "/peek" || typeof key !== "string") {
			socket.destroy();

			return;
		}
		const { encodeFrame, handshakeResponse, WsDecoder } = await import("../remote/liveview-ws.js");
		socket.write(handshakeResponse(key));
		const say = (obj: unknown) => {
			try {
				socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), "text"));
			} catch {
				socket.destroy();
			}
		};
		const r = await ensurePeek(url.searchParams.get("host") ?? "");
		if (!r.ok) {
			say({ ev: "error", message: r.error });
			socket.end();

			return;
		}
		const session = peek;
		if (!session) {
			socket.end();

			return;
		}
		clearTimeout(session.idleTimer);
		session.sockets.add(socket);
		const decoder = new WsDecoder();
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const frame of decoder.push(chunk)) {
					if (frame.opcode === "close") socket.end();
					else if (frame.opcode === "ping") socket.write(encodeFrame(frame.payload, "pong"));
					// text frames: dropped — the peek is view-only by construction.
				}
			} catch {
				socket.destroy();
			}
		});
		const gone = () => {
			session.sockets.delete(socket);
			// Last viewer gone: linger briefly (a reload, a tab hop), then drop the engine and
			// tunnels — an idle capture stream against a colo Mac serves nobody.
			if (session.sockets.size === 0 && peek === session)
				session.idleTimer = setTimeout(() => {
					if (peek === session && session.sockets.size === 0) teardownPeek();
				}, 30_000);
		};
		socket.on("close", gone);
		socket.on("error", gone);
	});

	// Listen errors (EADDRINUSE above all) must reject rather than crash the process later:
	// the Electron shell catches "port taken" and attaches its window to the dash already
	// serving there instead of dying.
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => {
			server.removeListener("error", reject);
			console.log(`bench dash: http://localhost:${port}  (date ${date}, fleet poll ${FLEET_POLL_SEC}s, ${autoCollect ? `auto-collect ${COLLECT_SEC}s` : "collect OFF — pure reader"})`);
			resolve();
		});
	});

	// Orphaned ssh tunnels outlive a dead parent silently — kill them with the process. The
	// signal handlers matter: "exit" does NOT fire on an unhandled SIGTERM/SIGINT, which is
	// exactly how a dash restart (kill + relaunch) leaks its tunnels onto the debug ports and
	// then trips its own squatter guard.
	process.on("exit", teardownPeek);
	for (const sig of ["SIGINT", "SIGTERM"] as const)
		process.on(sig, () => {
			teardownPeek();
			process.exit(0);
		});

	setInterval(() => {
		for (const res of clients) res.write(": ping\n\n");
	}, 25_000);
	setInterval(pollFleet, FLEET_POLL_SEC * 1000);
	void pollFleet();
	if (autoCollect) {
		setInterval(runCollect, COLLECT_SEC * 1000);
		void runCollect();
	}
	// Piggybacks the collect cadence: a tick only calls the model when the collected count
	// moved, so a quiet hour costs nothing.
	setInterval(() => void narrate(), COLLECT_SEC * 1000);
	void narrate();

	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	startDash(parseDashArgs(process.argv.slice(2))).catch((err) => {
		console.error(`dash failed: ${err}`);
		process.exit(1);
	});
