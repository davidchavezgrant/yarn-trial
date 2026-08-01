/**
 * The per-row graphs page: /graphs?arm=<id>&model=<m> renders every visualization the run
 * artifacts can carry, scoped to one matrix row (arm × model pass).
 *
 * This is a sibling of dash.ts, not part of it, so the board and the graphs page can evolve
 * without stepping on each other. dash.ts owns state assembly (arms → passes → entries) and
 * this module reads that state through the ctx it is handed; the raw per-run artifacts
 * (run.json steps, judge verdicts, journals, appmap variants, the motion corpus) are read
 * here, on request, because the board never needs them and the SSE payload must not grow
 * by megabytes.
 *
 * The deliberate import cycle with dash.js (buildDetail, exploreSeries, parseRunEvents) is
 * safe: both sides export hoisted function declarations that are only CALLED at request
 * time, never during module evaluation.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { appmapsDir, dataRoot, outDir, RUN_FILES, runFile } from "../paths.js";
import { readJsonOr } from "../fsutil.js";
import { readJournal } from "../core/journal.js";
import { synthesizeMove } from "../cursor/track.js";
import type { MotionConstants } from "../cursor/motion-types.js";
import type { AppMap, StepRecord } from "../types.js";
import type { Manifest } from "./manifest.js";
import { buildDetail, type DashState, type EntryView, exploreSeries, parseRunEvents } from "./dash.js";

/** One step, trimmed for the wire: everything the charts read, nothing they don't. */
export interface GraphsStep {
	index: number;
	timestamp?: string;
	/** Resolved action name ("click", "drag", "wait", …) — tool kind unwrapped. */
	name: string;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	seconds?: number;
	verified: boolean;
	channel?: string;
	note?: string;
	reasoning?: string;
	pixelDelta?: number;
	observationNodes?: number;
	listShownToModel?: number;
	chosenIndex?: number;
	targetRole?: string;
	targetRect?: { x: number; y: number; w: number; h: number };
	targetName?: string;
	targetSurface?: string;
	targetNamedBy?: string;
	screenshotFile?: string;
	/** Live-typed spans, epochs only — the anatomy chart needs durations, not text. */
	typed?: Array<{ s: number; e: number }>;
}

export interface GraphsRun {
	jobId: string;
	host?: string;
	status: string;
	collected: boolean;
	success?: boolean;
	failureKind?: string;
	elapsedSec?: number;
	usd?: number;
	modelCalls?: number;
	outputTokens?: number;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
	verifiedSteps?: number;
	unverifiedSteps?: number;
	verifiedByChannel?: { text?: number; geometry?: number; pixel?: number };
	steps?: GraphsStep[];
	judge?: GraphsJudge;
	judgeCross?: GraphsJudge;
	journal?: Array<{ kind: string; control: string; surface: string; settingKey?: string; scope?: string; step: number }>;
	/** Explore arms only: the discovery series the convergence chart draws. */
	series?: unknown[];
}

export interface GraphsJudge {
	model?: string;
	trajectory?: string;
	visual?: string;
	scope?: string;
	scopeDisclosed?: string;
	citations?: Array<{ step?: number; note: string }>;
}

/** A map variant, nodes only — the backend-diff chart compares identity, never topology. */
export interface GraphsMapVariant {
	slug: string;
	source: string;
	provenance?: string;
	capturedAt?: string;
	nodes: Array<{ id: string; title: string; kind: string; scope: string; settingKey?: string; options?: string[] }>;
}

export interface GraphsPayload {
	generatedAt: string;
	armId: string;
	model?: string;
	arm: Record<string, unknown>;
	/** The matrix row's cells — PassView minus its entries (those travel as `runs`). */
	pass: Record<string, unknown>;
	runs: GraphsRun[];
	/** The row's own grounding map (via the same resolution the tree view uses). */
	map?: { nodes: unknown[]; edges: unknown[]; source?: string };
	/** Every sibling map variant found for this app — the perception-diff chart's input. */
	maps: GraphsMapVariant[];
	/** Every collected run across ALL arms, for the cost scatter's context layer. */
	field: Array<{ armId: string; model?: string; jobId: string; usd?: number; verifiedSteps?: number; steps?: number; success?: boolean }>;
}

const truncate = (s: unknown, n: number): string | undefined => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);

/** Unwrap an ActionRequest into the compact wire shape. Coordinates stay in screenshot pixels. */
export function trimStep(raw: StepRecord): GraphsStep {
	const a = raw.action as Record<string, any>;
	const args = (a?.args ?? {}) as Record<string, any>;
	const name = a?.kind === "tool" ? String(a.name) : String(a?.kind ?? "?");
	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

	return {
		index: raw.index,
		...(raw.timestamp ? { timestamp: raw.timestamp } : {}),
		name,
		...(num(args.x ?? a?.x) !== undefined ? { x: num(args.x ?? a?.x) } : {}),
		...(num(args.y ?? a?.y) !== undefined ? { y: num(args.y ?? a?.y) } : {}),
		...(num(args.from_x) !== undefined ? { x: num(args.from_x) } : {}),
		...(num(args.from_y) !== undefined ? { y: num(args.from_y) } : {}),
		...(num(args.to_x) !== undefined ? { toX: num(args.to_x) } : {}),
		...(num(args.to_y) !== undefined ? { toY: num(args.to_y) } : {}),
		...(name === "wait" && num(args.seconds) !== undefined ? { seconds: num(args.seconds) } : {}),
		verified: raw.verified === true,
		...(raw.verificationChannel ? { channel: raw.verificationChannel } : {}),
		...(truncate(raw.verificationNote, 280) ? { note: truncate(raw.verificationNote, 280) } : {}),
		...(truncate(raw.modelReasoning, 280) ? { reasoning: truncate(raw.modelReasoning, 280) } : {}),
		...(typeof raw.pixelDelta === "number" ? { pixelDelta: raw.pixelDelta } : {}),
		...(typeof raw.observationNodes === "number" ? { observationNodes: raw.observationNodes } : {}),
		...(typeof raw.listShownToModel === "number" ? { listShownToModel: raw.listShownToModel } : {}),
		...(typeof raw.chosenIndex === "number" ? { chosenIndex: raw.chosenIndex } : {}),
		...(raw.targetRole ? { targetRole: raw.targetRole } : {}),
		...(raw.targetRect ? { targetRect: raw.targetRect } : {}),
		...(raw.targetName ? { targetName: raw.targetName } : {}),
		...(raw.targetSurface ? { targetSurface: raw.targetSurface } : {}),
		...(raw.targetNamedBy ? { targetNamedBy: raw.targetNamedBy } : {}),
		...(raw.screenshotFile ? { screenshotFile: raw.screenshotFile } : {}),
		...(Array.isArray(raw.typedChunks) && raw.typedChunks.length
			? { typed: raw.typedChunks.map((c) => ({ s: c.epochStartMs, e: c.epochEndMs })) }
			: {}),
	};
}

const trimJudge = (j: Record<string, any> | undefined): GraphsJudge | undefined =>
	j
		? {
				...(j.model ? { model: String(j.model) } : {}),
				...(j.trajectory ? { trajectory: String(j.trajectory) } : {}),
				...(j.visual ? { visual: String(j.visual) } : {}),
				...(j.scope ? { scope: truncate(j.scope, 200) } : {}),
				...(j.scopeDisclosed ? { scopeDisclosed: String(j.scopeDisclosed) } : {}),
				...(Array.isArray(j.citations)
					? { citations: j.citations.map((c: any) => ({ ...(typeof c.step === "number" ? { step: c.step } : {}), note: truncate(c.note, 300) ?? "" })) }
					: {}),
			}
		: undefined;

/**
 * Sibling map variants for an app: every committed docs/appmaps JSON whose `app` matches.
 * Nodes only — the diff compares WHAT each perception tier saw (settingKey/scope identity),
 * for which topology is noise. Per-run maps are deliberately not swept here: the committed
 * map is the one a task run would actually ground on, so it is the honest comparison set.
 */
export function mapsForApp(app: string): GraphsMapVariant[] {
	let files: string[];
	try {
		files = fs.readdirSync(appmapsDir()).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: GraphsMapVariant[] = [];
	for (const f of files) {
		const m = readJsonOr<AppMap | undefined>(path.join(appmapsDir(), f), undefined);
		if (!m || m.app !== app || !Array.isArray(m.nodes)) continue;
		out.push({
			slug: f.replace(/\.json$/, ""),
			source: `docs/appmaps/${f}`,
			...(m.provenance ? { provenance: m.provenance } : {}),
			...(m.capturedAt ? { capturedAt: m.capturedAt } : {}),
			nodes: m.nodes.map((n) => ({
				id: n.id,
				title: n.title,
				kind: n.kind,
				scope: n.scope,
				...(n.settingKey ? { settingKey: n.settingKey } : {}),
				...(n.options ? { options: n.options } : {}),
			})),
		});
	}

	return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function buildGraphsData(armId: string, model: string | undefined, manifest: Manifest, state: DashState): GraphsPayload | { error: string } {
	const arm = state.arms.find((a) => a.id === armId);
	if (!arm) return { error: `unknown arm ${JSON.stringify(armId)}` };
	// PassView.model is never undefined — passLabel() renders the default-model pass "(default)".
	const want = model ?? "(default)";
	const pass = arm.passes.find((p) => p.model === want);
	if (!pass) return { error: `arm ${armId} has no ${JSON.stringify(want)} pass (has: ${arm.passes.map((p) => p.model).join(", ") || "none"})` };

	const runs: GraphsRun[] = pass.entries.map((e: EntryView) => {
		const log = readJsonOr<Record<string, any> | undefined>(runFile(e.jobId, RUN_FILES.log), undefined);
		const rawSteps: StepRecord[] = Array.isArray(log?.steps) ? log.steps : [];
		const journal = readJournal(runFile(e.jobId, RUN_FILES.journal))
			.map((m: Record<string, any>) => ({
				kind: String(m.kind),
				control: String(m.control ?? ""),
				surface: String(m.surface ?? ""),
				...(m.settingKey ? { settingKey: String(m.settingKey) } : {}),
				...(m.scope ? { scope: String(m.scope) } : {}),
				step: Number(m.step ?? 0),
			}));
		let series: unknown[] = [];
		if (arm.kind === "explore") {
			try {
				series = exploreSeries(parseRunEvents(fs.readFileSync(runFile(e.jobId, RUN_FILES.events), "utf8")));
			} catch {
				// Pre-events pass, or artifacts not pulled to this machine — the chart is simply absent.
			}
		}

		return {
			jobId: e.jobId,
			...(e.host ? { host: e.host } : {}),
			status: e.status,
			collected: e.collected,
			...(typeof e.success === "boolean" ? { success: e.success } : {}),
			...(e.failureKind ? { failureKind: e.failureKind } : {}),
			...(typeof e.elapsedSec === "number" ? { elapsedSec: e.elapsedSec } : {}),
			...(typeof e.usd === "number" ? { usd: e.usd } : {}),
			...(typeof e.modelCalls === "number" ? { modelCalls: e.modelCalls } : {}),
			...(typeof e.outputTokens === "number" ? { outputTokens: e.outputTokens } : {}),
			...(e.startedAt ? { startedAt: e.startedAt } : {}),
			...(e.endedAt ? { endedAt: e.endedAt } : {}),
			...(truncate(log?.summary, 500) ? { summary: truncate(log?.summary, 500) } : {}),
			...(typeof log?.verifiedSteps === "number" ? { verifiedSteps: log.verifiedSteps } : {}),
			...(typeof log?.unverifiedSteps === "number" ? { unverifiedSteps: log.unverifiedSteps } : {}),
			...(log?.verifiedByChannel ? { verifiedByChannel: log.verifiedByChannel } : {}),
			...(rawSteps.length ? { steps: rawSteps.map(trimStep) } : {}),
			...(trimJudge(readJsonOr(runFile(e.jobId, RUN_FILES.judge), undefined)) ? { judge: trimJudge(readJsonOr(runFile(e.jobId, RUN_FILES.judge), undefined)) } : {}),
			...(trimJudge(readJsonOr(runFile(e.jobId, RUN_FILES.judgeCross), undefined)) ? { judgeCross: trimJudge(readJsonOr(runFile(e.jobId, RUN_FILES.judgeCross), undefined)) } : {}),
			...(journal.length ? { journal } : {}),
			...(series.length ? { series } : {}),
		};
	});

	// The row's grounding map, resolved exactly the way the tree view resolves it. Any entry
	// works — resolution is keyed by arm — so use the first; absent entries mean no map yet.
	let map: GraphsPayload["map"];
	const anyEntry = pass.entries[0];
	if (anyEntry) {
		const d = buildDetail(anyEntry.jobId, manifest);
		if (d.graph) map = { nodes: d.graph.nodes, edges: d.graph.edges, ...(d.graphSource ? { source: d.graphSource } : {}) };
	}

	const field: GraphsPayload["field"] = [];
	for (const a of state.arms)
		for (const p of a.passes)
			for (const e of p.entries) {
				if (!e.collected) continue;
				field.push({
					armId: a.id,
					...(p.model ? { model: p.model } : {}),
					jobId: e.jobId,
					...(typeof e.usd === "number" ? { usd: e.usd } : {}),
					...(typeof e.verifiedSteps === "number" ? { verifiedSteps: e.verifiedSteps } : {}),
					...(typeof e.steps === "number" ? { steps: e.steps } : {}),
					...(typeof e.success === "boolean" ? { success: e.success } : {}),
				});
			}

	const { entries: _entries, ...passRow } = pass as unknown as Record<string, unknown>;

	return {
		generatedAt: new Date().toISOString(),
		armId,
		...(model ? { model } : {}),
		arm: arm as unknown as Record<string, unknown>,
		pass: passRow,
		runs,
		...(map ? { map } : {}),
		maps: mapsForApp(arm.app),
		field,
	};
}

/** ---- motion corpus ----------------------------------------------------------------------- */

/**
 * data/ is a committed repo directory; humanize.ts resolves it off cwd, which a server must
 * not trust. Probe the data root first (covers YARN_RUNNER_DATA setups that mirror the repo),
 * then walk up from this module to the repo checkout it was loaded from.
 */
function resolveDataDir(): string | undefined {
	const candidates = [path.join(dataRoot(), "data")];
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		candidates.push(path.join(dir, "data"));
		dir = path.dirname(dir);
	}
	for (const c of candidates) if (fs.existsSync(path.join(c, "motion-segments.json"))) return c;

	return undefined;
}

/**
 * Synthesized tracks re-expressed in the corpus's own normalized shape (par/perp fractions of
 * distance, t in ms) so the page renders human and synthetic through one code path. Seeded
 * LCG, not Math.random: the fidelity panel should not redraw differently on every fetch.
 */
export function synthesizedAsSegments(constants: MotionConstants): Array<{ logDistance: number; distancePx: number; durationMs: number; par: number[]; perp: number[]; t: number[] }> {
	let s = 0x5eed;
	const rand = (): number => {
		s = (s * 1664525 + 1013904223) >>> 0;

		return s / 2 ** 32;
	};
	const out: Array<{ logDistance: number; distancePx: number; durationMs: number; par: number[]; perp: number[]; t: number[] }> = [];
	for (let ld = 5; ld <= 11; ld++)
		for (let rep = 0; rep < 2; rep++) {
			const dist = 2 ** ld * (0.75 + rand() * 0.5);
			const track = synthesizeMove({ x: 0, y: 0 }, { x: dist, y: 0 }, constants, rand);
			if (track.length < 2) continue;
			out.push({
				logDistance: ld,
				distancePx: dist,
				durationMs: track[track.length - 1]!.tMs,
				par: track.map((p) => p.x / dist),
				perp: track.map((p) => p.y / dist),
				t: track.map((p) => p.tMs),
			});
		}

	return out;
}

/** Gzipped once, served many: the corpus is 2.4MB of numbers that compress ~4x. */
let motionCache: { raw: Buffer; gz: Buffer } | undefined;

function motionPayload(): { raw: Buffer; gz: Buffer } | undefined {
	if (motionCache) return motionCache;
	const dir = resolveDataDir();
	if (!dir) return undefined;
	const constants = readJsonOr<MotionConstants | undefined>(path.join(dir, "motion-constants.json"), undefined);
	const library = readJsonOr<{ fittedFrom?: unknown; segments?: unknown[] } | undefined>(path.join(dir, "motion-segments.json"), undefined);
	if (!constants || !library?.segments) return undefined;
	const raw = Buffer.from(JSON.stringify({
		constants,
		fittedFrom: library.fittedFrom,
		segments: library.segments,
		synthesized: synthesizedAsSegments(constants),
	}));
	motionCache = { raw, gz: zlib.gzipSync(raw) };

	return motionCache;
}

/** ---- HTTP -------------------------------------------------------------------------------- */

/** Root-relative, no traversal, PNG only — the shot route serves run artifacts and nothing else. */
const SHOT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/;

function serveShot(res: http.ServerResponse, params: URLSearchParams): void {
	const f = params.get("f") ?? "";
	if (!SHOT_RE.test(f) || f.includes("..")) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "bad shot path" }));

		return;
	}
	const root = path.resolve(outDir());
	const abs = path.resolve(root, f);
	if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "no such screenshot" }));

		return;
	}
	res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
	res.end(fs.readFileSync(abs));
}

/** Same resolution dance as dash.ts's resolveHtml: beside the module, else the source copy. */
function graphsHtmlPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [path.join(here, "graphs.html"), path.join(here, "../../../src/bench/graphs.html")];
	for (const c of candidates) if (fs.existsSync(c)) return c;

	return candidates[0]!;
}

export interface GraphsCtx {
	manifest: Manifest;
	currentState: () => DashState;
}

/** Returns true when the URL belonged to the graphs page — the caller falls through to 404 otherwise. */
export function serveGraphs(req: http.IncomingMessage, res: http.ServerResponse, url: string, ctx: GraphsCtx): boolean {
	const parsed = new URL(url, "http://localhost");
	const p = parsed.pathname;
	try {
		if (p === "/graphs") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(graphsHtmlPath()));
		} else if (p === "/api/graphs/data") {
			const body = buildGraphsData(parsed.searchParams.get("arm") ?? "", parsed.searchParams.get("model") ?? undefined, ctx.manifest, ctx.currentState());
			res.writeHead("error" in body ? 404 : 200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		} else if (p === "/api/graphs/motion") {
			const m = motionPayload();
			if (!m) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "motion corpus not present on this machine (data/motion-segments.json)" }));
			} else if ((req.headers["accept-encoding"] ?? "").includes("gzip")) {
				res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "max-age=3600" });
				res.end(m.gz);
			} else {
				res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
				res.end(m.raw);
			}
		} else if (p === "/api/graphs/shot") {
			serveShot(res, parsed.searchParams);
		} else {
			return false;
		}
	} catch (e) {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: (e as Error).message }));
	}

	return true;
}
