import { electronTarget, parseTarget, type Target, targetLabel } from "../target.js";

/**
 * Why a --no-ax combination is refused, or undefined when it is allowed. Pure, so the
 * refusals are testable without trapping process.exit; parseCli prints and exits on it.
 */
export const noAxRefusal = (noAx: boolean, vision: boolean, backendKind: string): string | undefined => {
	if (!noAx) return undefined;
	if (!vision) return "--no-ax and --no-vision together leave the model with a window title and nothing else — refusing.";
	// Same refusal as the task agent's CLI: a non-ax backend's observations ARE ref lists,
	// so there is no element channel to drop without losing the action addressing too.
	if (backendKind !== "ax") return `--no-ax only applies to the ax backend — the ${backendKind} backend has no AX list to drop.`;

	return undefined;
};

export const parseCli = (
	// Injectable for tests, same shape as the agent CLI's parseCli(argv).
	argv: string[] = process.argv.slice(2),
): { target: Target; app: string; guidance: string | undefined; backendKind: string; vision: boolean; noAx: boolean } => {
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
	// list as the pass's only perception. The complement (--no-ax) cannot reuse the mechanical
	// frontier — its summary lists element names straight off the AX tree, which would leak the
	// whole element list to a model meant to see only pixels — so it runs on the DECLARED
	// frontier instead (src/core/harness/declared-frontier.ts): the model surveys what it can
	// see and names each act's target, and the ledger counts those declarations.
	const vision = !afterUrl.includes("--no-vision");
	const noAx = afterUrl.includes("--no-ax");
	const bi = afterUrl.indexOf("--backend");
	let positional = afterUrl.filter((a, i) => a !== "--no-vision" && a !== "--no-ax" && (bi < 0 || (i !== bi && i !== bi + 1)));
	const app = target.kind === "web" ? targetLabel(target) : (positional[0] ?? "Notion Calendar");
	// parseTarget returns the FALLBACK name for an app run, not the positional, so the slug
	// below would stamp this pass's output to "notion-calendar" no matter which app was named —
	// overwriting another app's committed map. Rebuild the target from the resolved name.
	// electronTarget on the cdp path, matching agent/cli.ts:73. Without cdpAttach the CDP
	// backend never launches the app with a debug port — it only probes 9222 and fails — so
	// an explore worked ONLY while some earlier flagged run had left the app running. Cold
	// start removed that accident and the cdp arms began failing immediately with "no CDP
	// endpoint at http://127.0.0.1:9222".
	if (target.kind === "app") target = { kind: "app", name: app };
	// `buildRunArgs` keeps the label in positional 0 for a web target too, so that guidance
	// stays where every caller already puts it. Drop it here rather than teaching the guidance
	// slot to move — a shifted positional is how a target name becomes a safety instruction.
	if (target.kind === "web" && positional[0] === app) positional = positional.slice(1);
	// Optional per-run guidance: relaxes or tightens the safety rules for this app
	// (e.g. "creating a draft is allowed; use <address> if a form needs an email").
	const guidance = target.kind === "web" ? positional[0] : positional[1];
	// A web target defaults to cdp: it observes the page rather than the window, so the
	// browser's own tab strip, omnibox and menu bar never reach the frontier.
	const backendKind = backendIdx >= 0 ? (argv[backendIdx + 1] ?? "ax") : target.kind === "web" ? "cdp" : "ax";
	// electronTarget on the cdp path, matching agent/cli.ts:73. Without cdpAttach the CDP
	// backend never launches the app with a debug port — it only probes 9222 and fails — so an
	// explore worked ONLY while some earlier flagged run had left the app running with one.
	// Cold start removed that accident and the cdp arms failed instantly with "no CDP endpoint
	// at http://127.0.0.1:9222". Placed after backendKind is resolved, which is why it is not
	// beside the name rebuild above.
	if (target.kind === "app" && backendKind === "cdp") target = electronTarget(app);
	if (!["ax", "cdp"].includes(backendKind)) {
		console.error('usage: tsx src/core/explore.ts ["App Name" | --url <https://…>] ["guidance"] [--backend ax|cdp] [--no-vision] [--no-ax]');
		console.error("--backend cdp explores over CDP directly (playwright-core) with NO cua in the loop; web targets get their own Chrome, Electron targets need --remote-debugging-port.");
		process.exit(1);
	}
	const refusal = noAxRefusal(noAx, vision, backendKind);
	if (refusal) {
		console.error(refusal);
		process.exit(1);
	}

	return { target, app, guidance, backendKind, vision, noAx };
};
