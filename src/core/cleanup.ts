import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CdpBackend } from "../backends/cdp.js";
import { Driver } from "./driver.js";
import { envNum } from "../env.js";
import { readJsonOr } from "../fsutil.js";
import {
	appSlug,
	ensureObservable,
	findWindow,
	loadAppMapGraph,
	makeClient,
	onInterrupt,
	OUT,
	resetToHome,
} from "./harness.js";
import { type Mutation, readJournal } from "./journal.js";
import { collapseJournal, runTeardown } from "./teardown.js";
import { startOverlay } from "./overlay.js";
import { webTarget } from "./target.js";
import { ARCHIVE_DIR, LIVE_DIR, RUN_FILES, runFile } from "../paths.js";

/**
 * Replay a run's mutation journal after the run itself has gone.
 *
 * The in-run teardown covers the ordinary exit. It cannot cover the case that most needs
 * covering: a run killed mid-task — SIGKILL, a panic, a closed laptop — leaves the app dirty
 * and its `finally` never runs. The journal is written append-per-mutation precisely so that
 * it survives that, and this is the thing that reads it back.
 *
 * The restore loop itself is `runTeardown()`, unmodified. A second implementation here would
 * have to agree with it about what "restored" means — including the open-dropdown case in
 * `controlReads` — and two implementations of one check are how they stop agreeing. So this
 * file owns only what a CLI owns: which journal, which app, driver lifecycle, and the exit
 * code. Everything below the driver boundary is reused.
 *
 * usage: npm run cleanup -- <stamp> [--app "App Name"] [--url <https://…>] [--dry-run] [--no-vision]
 *
 * `--url` replays over the CDP-direct backend (no cua driver), for journals written by
 * `--backend cdp` runs. It is an operator input rather than something recovered from the
 * run log because the run most in need of this CLI died without writing one.
 */

const DEFAULT_BUDGET = 10;

export type Disposition = "restore" | "unrestorable" | "resource";

export interface EntryPlan {
	mutation: Mutation;
	disposition: Disposition;
	/** The value a restore will aim for — the earliest recorded `before`. */
	wanted?: string;
}

/**
 * What a replay will attempt, in the order it will attempt it.
 *
 * Wraps `collapseJournal` rather than reimplementing it, so the CLI's dry run and the live
 * replay cannot disagree about which entries exist or what they aim for. The wrapper earns
 * its place by recovering what the collapse drops: it filters to `kind === "setting"`, so
 * resource entries vanish, and it does not distinguish an entry with no `before` from a
 * restorable one. Both belong on a receipt.
 */
export function planRestores(journal: Mutation[]): EntryPlan[] {
	const settings = collapseJournal(journal)
		.reverse()
		.map((m): EntryPlan => ({
			mutation: m,
			// An empty string is a real prior value (a field that was blank), not a missing
			// one — restoreOne() draws the same line, and the receipt must not blur it. Only
			// `undefined` is unrestorable: a field the run typed into is put back by clearing
			// it, and calling that "unrestorable" would leave the agent's text where the user
			// had left nothing.
			disposition: m.before === undefined ? "unrestorable" : "restore",
			wanted: m.before,
		}));
	const resources = journal
		.filter((m) => m.kind === "resource")
		.map((m): EntryPlan => ({ mutation: m, disposition: "resource" }));

	return [...settings, ...resources];
}

/**
 * Which app the journal belongs to.
 *
 * The stamp carries an app slug, but de-slugging it is lossy — "yarn" and "notion-calendar"
 * recover cleanly, "iterm2" does not become "iTerm2" — and a run killed hard enough to need
 * this CLI may never have written the run log that records the name exactly. Hence the
 * override: without it such a journal is unreplayable without editing code.
 */
export function appForStamp(stamp: string, runLogApp?: string, override?: string): string {
	if (override) return override;
	if (runLogApp) return runLogApp;

	// Stamps are `<ISO-19-chars>-<app-slug>`; the timestamp half contains no letters.
	const slug = stamp.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-/, "");

	return slug
		.split("-")
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

export function formatPlan(plan: EntryPlan[]): string {
	if (plan.length === 0) return "  (nothing to do)";

	return plan
		.map(({ mutation: m, disposition, wanted }) => {
			const where = `${m.surface || "(surface not recorded)"}${m.scope ? `, ${m.scope}` : ""}`;
			if (disposition === "restore")
				return `  restore  "${m.control}" [${where}] -> ${JSON.stringify(wanted)} (run left it at ${JSON.stringify(m.after ?? "")})`;
			if (disposition === "unrestorable")
				return `  skip     "${m.control}" [${where}] — no prior value recorded; will not be guessed`;

			return `  report   resource ${JSON.stringify(m.resource ?? m.control)} — disposal is not automatic`;
		})
		.join("\n");
}

/**
 * Non-zero only when a restore was attempted and failed. An empty journal, an all-unrestorable
 * one, and a journal of nothing but resources are all successful outcomes: nothing to clean is
 * not an error, and neither is honestly declining to guess.
 */
export function exitCodeFor(summary: { attempted: number; failed: number }): number {
	return summary.attempted > 0 && summary.failed > 0 ? 1 : 0;
}

/**
 * Whether a stamp names a run that EXISTS — a directory under out/live (or out/archive), or,
 * for runs written before the layout consolidated, a `<stamp>.`-prefixed file under out/runs.
 *
 * An empty journal used to be the end of the story: a typo'd or truncated stamp built a path
 * to a file that never existed, read as [], and the CLI printed "nothing to clean up" with
 * exit 0 — indistinguishable from a genuinely clean run, for a run it never looked at. A
 * fleet sweep that passes a job id instead of a stamp would poison the next job on that Mac
 * while reporting success. Prefixes deliberately do NOT count: they name a different run.
 */
export function stampArtifacts(names: string[], stamp: string): string[] {
	return names.filter((n) => n === stamp || n.startsWith(`${stamp}.`));
}

async function main(): Promise<void> {
	// Loose parseArgs, matching what the hand-rolled parser accepted: unknown flags are
	// ignored rather than fatal, and the option values are kept out of the positionals.
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: { app: { type: "string" }, url: { type: "string" }, "dry-run": { type: "boolean" }, "no-vision": { type: "boolean" } },
		strict: false,
		allowPositionals: true,
	});
	const dryRun = values["dry-run"] === true;
	const vision = values["no-vision"] !== true;
	const appOverride = typeof values.app === "string" ? values.app : undefined;
	const url = typeof values.url === "string" ? values.url : undefined;
	const stamp = positionals[0];
	if (!stamp) {
		console.error('usage: npm run cleanup -- <stamp> [--app "App Name"] [--url <https://…>] [--dry-run] [--no-vision]');
		console.error("  stamp identifies a run, e.g. 2026-07-30T03-00-00-yarn");
		console.error("  --url replays over the CDP-direct backend, for journals written by --backend cdp runs");
		process.exit(1);
	}

	const journalPath = runFile(stamp, RUN_FILES.journal);
	const journal = readJournal(journalPath);
	if (journal.length === 0) {
		// "Nothing to clean" is only a truthful answer for a run that EXISTS. A stamp nothing
		// matches is a typo or a job id, and exiting 0 on it reports a cleanup that never
		// looked at anything.
		const listing = (dir: string): string[] => {
			try {
				return fs.readdirSync(dir);
			} catch {
				return [];
			}
		};
		// Every place a run can be: canonical, backed up, and the pre-consolidation tree.
		const live = listing(`${OUT}/${LIVE_DIR}`);
		const names = [...live, ...listing(`${OUT}/${ARCHIVE_DIR}`), ...listing(`${OUT}/runs`)];
		if (stampArtifacts(names, stamp).length === 0) {
			console.error(`no run matches stamp ${stamp} under ${OUT}/${LIVE_DIR} — check the stamp (a prefix or job id is not enough).`);
			const recent = live.sort().slice(-5);
			if (recent.length) console.error(`recent runs:\n  ${recent.join("\n  ")}`);
			process.exit(1);
		}
		// Not an error. Most runs change nothing worth journalling, and a caller sweeping a
		// directory of stamps should not have to distinguish "clean" from "broken".
		console.log(`no mutations recorded for ${stamp} (${journalPath}) — nothing to clean up`);

		return;
	}

	const plan = planRestores(journal);
	const restores = plan.filter((p) => p.disposition === "restore").length;
	const unrestorable = plan.filter((p) => p.disposition === "unrestorable").length;
	const resources = plan.filter((p) => p.disposition === "resource").length;

	// The run log is absent exactly when this CLI is most needed — a run killed before it
	// could write one. --app covers it; the stamp suffix covers the common case.
	const runLogApp: string | undefined = readJsonOr<any>(runFile(stamp, RUN_FILES.log), undefined)?.app;
	const app = appForStamp(stamp, runLogApp, appOverride);

	console.log(`=== cleanup: ${stamp} (${app}) ===`);
	console.log(
		`journal: ${journal.length} entr${journal.length === 1 ? "y" : "ies"} — ` +
			`${restores} to restore, ${unrestorable} unrestorable, ${resources} claimed resource(s)`,
	);
	console.log(formatPlan(plan));

	if (dryRun) {
		console.log("\n--dry-run: no driver started, nothing changed");

		return;
	}

	// --url selects the CDP-direct backend, mirroring the run that wrote the journal — and,
	// same as everywhere, a cdp replay never takes the operator's input, so no banner.
	const overlay = startOverlay("drive", `Agent restoring ${app} — do not touch`, url ? "cdp" : "ax");
	// The same rule as agent.ts: when cdp is set there is no driver at all. Loaded lazily so
	// src/backends/ stays deletable without breaking journal replays for ax runs.
	const cdp = url ? await (await import("../backends/cdp.js")).CdpBackend.acquire(webTarget(url)) : undefined;
	const driver = cdp ? undefined : await Driver.start("cleanup");
	const interrupted = onInterrupt(async () => {
		await driver?.close();
		await cdp?.close();
	});
	const { client, model } = makeClient();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelCalls: 0 };
	let summary = { attempted: 0, failed: 0 };

	try {
		if (cdp) {
			await overlay.countdown();
			// The dead run may have ended anywhere; a web target's home is its URL, and
			// starting the replay there is the CDP equivalent of the reset below.
			overlay.setDriving(true);
			console.log(`home reset: ${await cdp.goHome()}`);
		} else {
			await driver!.act({ kind: "tool", name: "launch_app", args: { name: app } });
			await new Promise((r) => setTimeout(r, 1500));
			let win = await findWindow(driver!, app);
			await overlay.countdown();
			win = await ensureObservable(driver!, win, app);

			// The run this is cleaning up after died wherever it died — quite possibly with a
			// dropdown or modal standing open, which is the state in which the controls a restore
			// needs are missing from the AX tree entirely. resetToHome already handles exactly
			// that (escape, then click the declared home control, then retry).
			overlay.setDriving(true);
			const reset = await resetToHome(driver!, win, app);
			console.log(`home reset: ${reset.result} — ${reset.detail}`);
		}

		if (interrupted()) return;

		const report = await runTeardown({
			driver,
			cdp,
			client,
			model,
			app,
			journal,
			// Synthesised from the journal because a crashed run left no in-memory ledger.
			// Today this is always empty: agent.ts keeps `claimed` in memory and never appends
			// it, so a resource a dead run created is not recoverable from disk at all. Reported
			// as zero rather than guessed at.
			claimed: journal
				.filter((m) => m.kind === "resource")
				.map((m) => ({ kind: "created", name: m.resource ?? m.control, step: m.step })),
			graph: loadAppMapGraph(appSlug(app)),
			// Discarded: a standalone replay has no run log to fold step records into.
			steps: [],
			budget: envNum("CLEANUP_STEPS", DEFAULT_BUDGET),
			mode: "cli",
			vision,
			usage,
		});
		summary = { attempted: Number(report.attempted ?? 0), failed: Number(report.failed ?? 0) };
	} finally {
		overlay.setDriving(false);
		await driver?.close();
		// Disconnects only — the browser stays up holding the signed-in profile (src/backends/cdp.ts).
		await cdp?.close();
		overlay.stop();
		console.log(
			`cleanup finished: ${summary.attempted - summary.failed}/${summary.attempted} restored, ` +
				`${usage.modelCalls} model calls`,
		);
	}

	process.exit(exitCodeFor(summary));
}

// Guarded so the pure helpers above can be imported by tests without starting a driver.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((err) => {
		console.error("cleanup failed:", err);
		process.exit(1);
	});
