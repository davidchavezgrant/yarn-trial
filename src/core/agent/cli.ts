import { auditTaskPrompt, type PromptAudit } from "../harness.js";
import { parseTarget, type Target, targetLabel, targetSlug } from "../target.js";

export interface CliConfig {
	record: boolean;
	vision: boolean;
	noAx: boolean;
	/** off | advisory (default) | block — see the comment at the read site below. */
	judgeMode: string;
	backendKind: string;
	target: Target;
	task: string;
	app: string;
	noReset: boolean;
	allowUnready: boolean;
	audit: PromptAudit;
}

export function parseCli(argv: string[]): CliConfig {
	const record = argv.includes("--record");
	// A/B arm: drop the screenshot from every model message. The observation becomes
	// text-only (title + AX elements with frames); capture for recording/artifacts is
	// unaffected. Measures what the image channel is worth in actions/tokens/correctness.
	const vision = !argv.includes("--no-vision");
	// The complementary A/B arm: drop the ELEMENT LIST from every model message, leaving the
	// screenshot as the model's only perception (vision-only). The harness keeps the full
	// observation — verify(), the journal and teardown are instruments, not perception — so
	// the arm isolates what the model sees without weakening what the run can prove.
	const noAx = argv.includes("--no-ax");
	if (noAx && !vision) {
		console.error("--no-ax and --no-vision together leave the model with a window title and nothing else — refusing.");
		process.exit(1);
	}
	// off | advisory (default) | block. Advisory records the judge's verdict without letting
	// it decide the run: it is a second opinion, and a wrong confident verdict in either
	// direction is worse than no verdict until we have a measured error rate for it.
	const judgeMode = process.env.VISUAL_JUDGE ?? "advisory";
	const backendIdx = argv.indexOf("--backend");
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : "ax";
	const args = argv.filter(
		(a, i) =>
			!["--record", "--hinted", "--no-reset", "--no-vision", "--no-ax", "--allow-unready"].includes(a) &&
			(backendIdx < 0 || (i !== backendIdx && i !== backendIdx + 1)),
	);
	// `--url` is VALUE-bearing, so it is consumed as a pair before the positionals are read —
	// the filter above only strips boolean flags, and a URL left in `args` would be taken as
	// the app name.
	let target: Target;
	let afterUrl: string[];
	try {
		({ target, rest: afterUrl } = parseTarget(args, "Yarn"));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	const task = afterUrl[0];
	// Yarn is the canonical target for all runs (set by David, 2026-07-29); Notion
	// Calendar remains available by passing it explicitly.
	const app = target.kind === "web" ? targetLabel(target) : (afterUrl[1] ?? "Yarn");
	// parseTarget only consumes --url; for an app run it returns the FALLBACK name, never the
	// positional. Everything keyed off `target` below — the grounding slug, scope warnings, the
	// mutation graph, the run log's provenance — would otherwise describe "Yarn" while the run
	// drove the app named on the command line, grounding it with the wrong appmap and recording
	// a run log that lies about which map it used. Rebuild the target from the resolved name.
	if (target.kind === "app") target = { kind: "app", name: app };
	if (!task || !["ax", "dom", "cdp"].includes(backendKind)) {
		console.error('usage: tsx src/core/agent.ts "<task>" ["App Name"] [--record] [--backend ax|dom|cdp] [--no-vision] [--no-ax]');
		console.error("--backend dom drives an Electron/browser target over CDP via cua's browser_* tools; launch it with --remote-debugging-port first.");
		console.error("--backend cdp drives it over CDP directly (playwright-core) with NO cua in the loop; web targets get their own Chrome, Electron targets need --remote-debugging-port.");
		process.exit(1);
	}
	if (noAx && backendKind !== "ax") {
		// The DOM and CDP backends' observations ARE ref lists; suppressing one leaves ref
		// actions addressing handles the model has never seen.
		console.error(`--no-ax only applies to the ax backend — the ${backendKind} backend has no AX list to drop.`);
		process.exit(1);
	}

	// Prompt hygiene gate: a task prompt containing method hints is not a valid autonomy
	// test, and the resulting run log is indistinguishable from a clean one unless we
	// record the fact here. Refuse by default; --hinted opts in and marks the log.
	const noReset = argv.includes("--no-reset");
	const allowUnready = argv.includes("--allow-unready");
	const hintedAck = argv.includes("--hinted");
	const audit = auditTaskPrompt(task);
	if (audit.hinted && !hintedAck) {
		console.error("REFUSING TO RUN — the task prompt contains method hints, not just a goal:");
		for (const r of audit.reasons) console.error(`  · ${r}`);
		console.error(
			"\nA hinted prompt hands the model knowledge it would not have in a real run, so the\n" +
				"result cannot be reported as autonomous. Move method knowledge into\n" +
				`docs/appmaps/${targetSlug(target)}.md (a declared input), and restate the task as the goal only.\n` +
				"If the hint is intentional (e.g. pinning a path for a filming take), re-run with --hinted;\n" +
				"the run log and any published result must then say so.",
		);
		process.exit(2);
	}

	return { record, vision, noAx, judgeMode, backendKind, target, task, app, noReset, allowUnready, audit };
}
