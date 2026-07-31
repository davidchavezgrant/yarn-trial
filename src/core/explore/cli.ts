import { parseTarget, type Target, targetLabel } from "../target.js";

export const parseCli = (): { target: Target; app: string; guidance: string | undefined; backendKind: string; vision: boolean } => {
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
	// A/B arm for grounding: drop the screenshot from every model message, leaving the element
	// list as the pass's only perception. The complement (--no-ax) has no explore equivalent by
	// construction — the frontier ledger, dismissal matching, and the stop condition all read
	// element identity, so a vision-only pass would have nothing to count coverage with.
	const vision = !afterUrl.includes("--no-vision");
	const bi = afterUrl.indexOf("--backend");
	let positional = afterUrl.filter((a, i) => a !== "--no-vision" && (bi < 0 || (i !== bi && i !== bi + 1)));
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
	// A web target defaults to a page-snapshot backend: it observes the page rather than the
	// window, so the browser's own tab strip, omnibox and menu bar never reach the frontier.
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : target.kind === "web" ? "dom" : "ax";
	if (!["ax", "dom", "cdp"].includes(backendKind)) {
		console.error('usage: tsx src/core/explore.ts ["App Name" | --url <https://…>] ["guidance"] [--backend ax|dom|cdp] [--no-vision]');
		console.error("--backend cdp explores over CDP directly (playwright-core) with NO cua in the loop; web targets get their own Chrome, Electron targets need --remote-debugging-port.");
		process.exit(1);
	}

	return { target, app, guidance, backendKind, vision };
};
