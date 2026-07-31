import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { deriveHome, describeSurfaces } from "../src/core/home.js";
import type { AppMap } from "../src/types.js";

// Backfilling `home` from a graph rather than from a live pass is a weaker input by design, so
// what these pin is the part that keeps it honest: the model only ever sees surfaces and the
// labels the pass actually quoted, and whatever it answers is put through the same validation
// an exploration pass gets. A derived home that the map cannot support is dropped, not written.

const graph: AppMap = {
	app: "Yarn",
	capturedAt: "2026-07-30T00:00:00.000Z",
	provenance: "explore",
	nodes: [
		{ id: "root", title: "Main window (left rail)", kind: "surface", scope: "app" },
		{ id: "library", title: "Your Library page", kind: "surface", scope: "workspace" },
		{ id: "editor", title: "Project editor", kind: "surface", scope: "document" },
		{ id: "library/sort", title: "Sort order menu", kind: "control", scope: "workspace" },
	],
	edges: [
		{ from: "root", to: "library", action: 'click "Library" in the left rail' },
		{ from: "root", to: "editor", action: 'click "New project"' },
		{ from: "library", to: "editor", action: "double-click a project card" },
	],
};

test("describeSurfaces__ListsEveryRouteIn__When__SeveralEdgesTargetASurface", () => {
	const lines = describeSurfaces(graph);
	assert.match(lines, /- editor — Project editor \(scope: document\)/);
	assert.match(lines, /from root: click "New project"/);
	assert.match(lines, /from library: double-click a project card/);
});

test("describeSurfaces__MarksTheStartingPoint__When__ARootIsIdentifiable", () => {
	// Without it the model has no way to tell the shell that holds the navigation chrome from
	// the pages hanging off it, and picks whichever surface sounds most important.
	assert.match(describeSurfaces(graph), /- root — .*\[the surface exploration started from\]/);
});

test("describeSurfaces__OmitsControls__When__RenderingTheGraph", () => {
	// Controls are the bulk of a real map (114 of Yarn's 150 nodes) and none of them can be a
	// home; including them buys nothing and crowds out the surfaces.
	assert.equal(describeSurfaces(graph).includes("Sort order menu"), false);
});

test("describeSurfaces__SaysSo__When__ASurfaceHasNoRouteIn", () => {
	assert.match(describeSurfaces(graph), /root —[\s\S]*?\(no recorded route in\)/);
});

/** Answers one pinned tool call with whatever the test wants the model to have said. */
const modelSaying = (input: Record<string, unknown>): Anthropic =>
	({ messages: { create: async () => ({ content: [{ type: "tool_use", name: "home", input }] }) } }) as unknown as Anthropic;

test("deriveHome__StampsItAsBackfill__When__TheModelPicksASupportedSurface", async () => {
	const out = await deriveHome(graph, modelSaying({ surface: "library", control: "Library", description: "Library view", reasoning: "stable overview" }), "m");
	assert.deepEqual(out.home, { surface: "library", control: "Library", description: "Library view", source: "backfill" });
	assert.equal(out.reasoning, "stable overview");
});

test("deriveHome__Drops__When__TheControlWasNeverQuotedByThePass", async () => {
	// The realistic failure: a plausible label the app probably has, that this map cannot show
	// the pass ever operating. Writing it would leave a permanent, invisible "failed" reset.
	const out = await deriveHome(graph, modelSaying({ surface: "library", control: "Home", description: "Library view" }), "m");
	assert.equal(out.home, undefined);
	assert.match(out.problem ?? "", /never recorded operating it/);
});

test("deriveHome__Drops__When__TheSurfaceIsNotInTheMap", async () => {
	const out = await deriveHome(graph, modelSaying({ surface: "dashboard", control: "Library", description: "x" }), "m");
	assert.equal(out.home, undefined);
	assert.match(out.problem ?? "", /not a node in the graph/);
});

test("deriveHome__RefusesToAsk__When__TheMapRecordsNoSurfaces", async () => {
	const controlsOnly: AppMap = { ...graph, nodes: graph.nodes.filter((n) => n.kind === "control") };
	let asked = false;
	const client = { messages: { create: async () => ((asked = true), { content: [] }) } } as unknown as Anthropic;
	const out = await deriveHome(controlsOnly, client, "m");
	assert.match(out.problem ?? "", /no surfaces/);
	assert.equal(asked, false, "a map with nothing to choose from is not worth a model call");
});

test("deriveHome__Reports__When__TheModelAnswersWithoutCallingTheTool", async () => {
	const client = { messages: { create: async () => ({ content: [{ type: "text", text: "I think it is the Library" }] }) } } as unknown as Anthropic;
	assert.match((await deriveHome(graph, client, "m")).problem ?? "", /no tool call/);
});
