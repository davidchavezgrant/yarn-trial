import fs from "node:fs";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FleetRow } from "../remote/control/fleet.js";
import { estimateCost, rollupCost, usd } from "./cost.js";
import { type Arm, flagsLine, MATRIX, type Phase } from "./matrix.js";
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
	informs?: string;
	passes: PassView[];
}

export interface DashState {
	date: string;
	generatedAt: string;
	autoCollect: boolean;
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

	return {
		model: passLabel(model),
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

export function buildState(manifest: Manifest, fleet: FleetView, events: DashEvent[], autoCollect: boolean): DashState {
	const arms: ArmView[] = MATRIX.map((arm) => ({
		id: arm.id,
		phase: arm.phase,
		kind: arm.kind,
		n: arm.n,
		flags: flagsLine(arm),
		app: arm.app,
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

	const addEvent = (line: string): void => {
		events.push({ t: new Date().toISOString(), line });
		if (events.length > 200) events.shift();
	};

	const push = (): void => {
		const data = `data: ${JSON.stringify(buildState(manifest, fleet, events, autoCollect))}\n\n`;
		for (const res of clients) res.write(data);
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

	const htmlPath = resolveHtml();
	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(htmlPath));
		} else if (url === "/api/state") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(buildState(manifest, fleet, events, autoCollect), null, "\t"));
		} else if (url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`data: ${JSON.stringify(buildState(manifest, fleet, events, autoCollect))}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
		} else {
			res.writeHead(404);
			res.end("not found");
		}
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

	setInterval(() => {
		for (const res of clients) res.write(": ping\n\n");
	}, 25_000);
	setInterval(pollFleet, FLEET_POLL_SEC * 1000);
	void pollFleet();
	if (autoCollect) {
		setInterval(runCollect, COLLECT_SEC * 1000);
		void runCollect();
	}

	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	startDash(parseDashArgs(process.argv.slice(2))).catch((err) => {
		console.error(`dash failed: ${err}`);
		process.exit(1);
	});
