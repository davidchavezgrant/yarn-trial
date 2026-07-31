import { pathToFileURL } from "node:url";
import { outDir } from "../paths.js";
import { judgeReportPath, judgeRun } from "./judge.js";

/**
 * Re-grade a completed run, adversarially, offline.
 *
 *   npm run judge -- <stamp> [--no-frames]
 *
 * Advisory: any verdict — PASS, FAIL, UNPROVEN — exits 0. Exit 1 is reserved for the judge
 * itself failing (run not found, unparseable reply), because a FAIL verdict is the tool
 * working, not the tool broken.
 */

function usage(): never {
	console.error("usage: npm run judge -- <stamp> [--no-frames]");
	console.error("  stamp identifies a run under out/runs/, e.g. 2026-07-29T18-58-28 (prefix ok)");
	console.error("  --no-frames  grade the trajectory only, sending no screenshots");
	process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const noFrames = argv.includes("--no-frames");
	const stamp = argv.find((a) => !a.startsWith("--"));
	if (!stamp) usage();

	const report = await judgeRun(stamp, { noFrames });

	console.log(`=== judge: ${report.stamp} (${report.app}) ===`);
	console.log(`task:  ${report.task}`);
	if (report.claim) console.log(`claim: ${report.claim}`);
	console.log(`TRAJECTORY: ${report.trajectory}`);
	console.log(`VISUAL:     ${report.visual}`);
	console.log(`SCOPE:      ${report.scope}`);
	for (const c of report.citations) console.log(`  cite${c.step !== undefined ? ` step ${c.step}` : ""}: ${c.note}`);
	console.log(
		`frames: ${report.framesUsed} used${report.framesStale ? " (run's screenshots were STALE shared paths — not trusted)" : ""}`,
	);
	console.log(`wrote: ${judgeReportPath(`${outDir()}/runs/${report.stamp}.json`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((err) => {
		console.error(`judge failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
