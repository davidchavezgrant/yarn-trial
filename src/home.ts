import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { appSlug, checkHome, loadAppMapGraph, makeClient, providerRouting, retryTransient, rootSurface } from "./harness.js";
import { appmapsDir } from "./paths.js";
import type { AppMap, AppMapHome } from "./types.js";

/**
 * Give an already-explored app a declared home, without re-exploring it.
 *
 * `AppMapHome` was added after the committed maps were written, so every app explored before it
 * falls to `resetToHome`'s weak tier: the run still refuses to start against a sign-in wall, but
 * nothing normalises WHERE it starts, and a run that begins wherever the last one stopped
 * inherits that run's navigation for free. The honest fix is a fresh exploration pass. That
 * costs ~40 minutes and a machine per app, which is a lot to pay for one field.
 *
 * So: derive it from the map that pass already produced. This is a strictly weaker input than a
 * live pass — it sees the graph, not the app — but the evidence it is checked against is
 * identical. `checkHome()` accepts a home only if the surface is a node the walk recorded and
 * the control label is one the walk quoted in an edge action, and those quotes came from live
 * observations either way. What is lost is the chance to notice that the map itself is wrong.
 *
 * Marked `source: "backfill"` for exactly that reason, so a reader can tell the two apart. A
 * later exploration pass overwrites it with `source: "explore"` and this becomes moot.
 *
 * Not a hand-edit of a stamped artifact, and not grounding: home is a test fixture the harness
 * reads to reset the app, never shown to the task agent, so writing it cannot contaminate a
 * grounded-vs-ungrounded comparison. Nothing else in the map is touched.
 */

/** What the model is shown: one line per surface, with every recorded way in. */
export function describeSurfaces(graph: AppMap): string {
	const routes = new Map<string, string[]>();
	for (const e of graph.edges) (routes.get(e.to) ?? routes.set(e.to, []).get(e.to)!).push(`from ${e.from}: ${e.action}`);

	const root = rootSurface(graph);

	return graph.nodes
		.filter((n) => n.kind === "surface")
		.map((n) => {
			const into = routes.get(n.id) ?? [];
			const tag = n.id === root?.id ? " [the surface exploration started from]" : "";

			return `- ${n.id} — ${n.title} (scope: ${n.scope})${tag}\n${into.length ? into.map((r) => `    ${r}`).join("\n") : "    (no recorded route in)"}`;
		})
		.join("\n");
}

const PROMPT = `You are given the surface graph of a desktop application, produced by an automated exploration pass.

Identify the app's HOME: the ordinary landing view a person sees on opening it and returns to between jobs, plus the navigation control that goes there from anywhere.

Rules that matter more than they look:
- Prefer a stable list or overview over a document, editor, or canvas, however much of the app's substance lives inside one. This is used to reset the app before a test run, and a run that starts inside an open document inherits that document's state.
- Never pick a modal, popover, menu, or settings pane. Those are places you pass through.
- The control label must be one that appears IN QUOTES in one of the routes below — that is the set of labels the exploration pass actually observed and operated. Anything else will be rejected.
- Prefer a control in persistent navigation chrome (a sidebar, rail, or tab bar) reachable from anywhere, over one that only exists on one screen.

Surfaces:
`;

const HOME_TOOL: Anthropic.Tool = {
	name: "home",
	description: "Declare the app's home surface and the control that navigates to it.",
	input_schema: {
		type: "object",
		properties: {
			surface: { type: "string", description: "Node id of the landing surface, exactly as listed." },
			control: { type: "string", description: "Label of the navigation control, exactly as it appears in quotes in a route." },
			description: { type: "string", description: 'What is on screen once it is reached, e.g. "left-rail Library view".' },
			reasoning: { type: "string", description: "One sentence: why this surface and not the others." },
		},
		required: ["surface", "control", "description", "reasoning"],
	},
};

export interface BackfillResult {
	home?: AppMapHome;
	reasoning?: string;
	problem?: string;
}

/** One model call, tool_choice pinned, then the same validation an exploration pass gets. */
export async function deriveHome(graph: AppMap, client: Anthropic, model: string): Promise<BackfillResult> {
	if (!graph.nodes.some((n) => n.kind === "surface")) return { problem: "the map records no surfaces" };

	const msg = await retryTransient(() =>
		client.messages.create({
			model,
			max_tokens: 2000,
			tools: [HOME_TOOL],
			tool_choice: { type: "tool", name: "home" },
			messages: [{ role: "user", content: PROMPT + describeSurfaces(graph) }],
			...providerRouting([]),
		}),
	);

	const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
	if (!use) return { problem: "the model returned no tool call" };

	const input = use.input as AppMapHome & { reasoning?: string };
	const { home, problem } = checkHome({ surface: input.surface, control: input.control, description: input.description }, graph.nodes, graph.edges);

	return { home: home && { ...home, source: "backfill" }, reasoning: input.reasoning, problem };
}

const USAGE = `usage: npm run home -- "<App Name>" [--force]

Derive the appmap's "home" field from the graph an exploration pass already wrote, so runs can
be reset to a known start state without re-exploring the app (~40 min). Requires
docs/appmaps/<app>.json; refuses to overwrite an existing home unless --force.`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const app = argv.find((a) => !a.startsWith("--"));
	if (!app) {
		console.error(USAGE);
		process.exit(2);
	}

	const path = `${appmapsDir()}/${appSlug(app)}.json`;
	const graph = loadAppMapGraph(appSlug(app));
	if (!graph) {
		console.error(`no graph at ${path} — this needs a full pass: npm run explore -- "${app}"`);
		process.exit(1);
	}
	if (graph.home && !argv.includes("--force")) {
		console.log(`"${app}" already declares a home (${graph.home.control} → ${graph.home.surface}, source: ${graph.home.source ?? "explore"})`);
		console.log("pass --force to replace it");

		return;
	}

	const { client, model } = makeClient();
	console.log(`deriving home for "${app}" from ${graph.nodes.filter((n) => n.kind === "surface").length} surfaces (${model})…`);
	const { home, reasoning, problem } = await deriveHome(graph, client, model);
	if (!home) {
		console.error(`could not derive a home: ${problem ?? "unknown"}`);
		process.exit(1);
	}

	// Rebuilt rather than mutated so the key order matches what exploration writes, keeping the
	// diff to the one added block. Everything else is copied through untouched.
	const { nodes, edges, ...head } = graph;
	fs.writeFileSync(path, JSON.stringify({ ...head, home, nodes, edges }, null, 2));
	console.log(`home: click "${home.control}" → ${home.surface} (${home.description})`);
	if (reasoning) console.log(`why: ${reasoning}`);
	console.log(`wrote ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`home failed: ${err}`);
		process.exit(1);
	});
