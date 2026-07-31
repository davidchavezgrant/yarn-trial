import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * The layout contract, enforced instead of described.
 *
 * CLAUDE.md says `src/core/` is the POC and everything else is deletable without breaking it.
 * That was true when written and had quietly stopped being true in two places by the time the
 * 2026-07-31 audit measured it — `src/backends/boundary.ts` was a static value-import into
 * core, and `remote/runner/serve.ts` imported `src/ui/`, which dragged the fleet's ssh
 * machinery onto every colo Mac to answer one query. Both were invisible to review because
 * an import line looks the same whether or not it crosses a boundary that matters.
 *
 * These read the import graph the same way the audit did. They are cheap, they run on every
 * `npm test`, and they fail on the edge rather than on the symptom — which for the ui case was
 * a daemon loading a module it has no business knowing about, with nothing observably broken.
 *
 * Scope, deliberately: STATIC VALUE imports only. `import type` is erased at emit and
 * `await import()` at a selection branch is the sanctioned seam for backends, so counting
 * either would fail the contract as it is actually written.
 */

const SRC = path.join(import.meta.dirname, "..", "src");

/** Every static, non-type import edge in src/, as module paths relative to src/. */
function importGraph(): Map<string, Set<string>> {
	const edges = new Map<string, Set<string>>();
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const from = path.relative(SRC, full).replace(/\.ts$/, "");
			const to = new Set<string>();
			// `import x from "./y.js"` and `export { x } from "./y.js"`, but never `import type`.
			for (const m of fs.readFileSync(full, "utf8").matchAll(/^(?:export|import)\s+(?!type\s)[^;]*?from "(\.[^"]+)\.js"/gm))
				to.add(path.normalize(path.join(path.dirname(from), m[1])));
			edges.set(from, to);
		}
	};
	walk(SRC);

	return edges;
}

/** Everything `start` can reach through static value imports. */
function reachable(edges: Map<string, Set<string>>, start: string): Set<string> {
	const seen = new Set<string>();
	const stack = [start];
	while (stack.length) {
		for (const next of edges.get(stack.pop()!) ?? []) {
			if (seen.has(next)) continue;
			seen.add(next);
			stack.push(next);
		}
	}

	return seen;
}

const PERIPHERALS = ["backends", "cursor", "remote", "ui", "probes", "bench"];

test("core__StaticallyImportsNoPeripheral__When__TheWholeGraphIsWalked", () => {
	// The contract's real test. Core may name a peripheral in an `import type` (erased) or load
	// one with `await import()` at a selection branch (the seam that keeps `--backend cdp`
	// possible without making backends/ mandatory) — but a static value import means a default
	// `ax` run loads the directory, and deleting it breaks core.
	const edges = importGraph();
	const violations: string[] = [];
	for (const [from, tos] of edges) {
		if (!from.startsWith("core/")) continue;
		for (const to of tos) if (PERIPHERALS.some((p) => to.startsWith(`${p}/`))) violations.push(`${from} -> ${to}`);
	}

	assert.deepEqual(violations, [], `core must not statically import a deletable peripheral:\n${violations.join("\n")}`);
});

test("remote__NeverImportsUi__When__TheGraphIsWalked", () => {
	// Direction: ui composes remote, never the reverse. `runner/serve.ts` imported `listApps`
	// from `ui/ui-core.ts` and thereby loaded `control/ssh.ts` — the operator-laptop identity,
	// known_hosts and control sockets — into the per-Mac daemon at boot, to answer one question
	// about its own /Applications. listApps now lives in `core/apps.ts`.
	const edges = importGraph();
	const backwards: string[] = [];
	for (const [from, tos] of edges) {
		if (!from.startsWith("remote/")) continue;
		for (const to of tos) if (to.startsWith("ui/")) backwards.push(`${from} -> ${to}`);
	}

	assert.deepEqual(backwards, [], `remote/ must not import ui/:\n${backwards.join("\n")}`);
});

test("runnerDaemon__DoesNotReachTheFleetsAppmapSync__When__ItStarts", () => {
	// serve.ts runs on a colo Mac. `control/appmaps.ts` is the operator's hub-and-spoke sync and
	// pulls rsync + ssh with it; the daemon reaching it was the concrete cost of the ui edge.
	// (`control/ssh.ts` itself is still reachable for `firstLine`, a pure string helper that
	// happens to live there — a smaller, separate cleanup.)
	const reach = reachable(importGraph(), "remote/runner/serve");
	assert.equal(reach.has("remote/control/appmaps"), false, "the runner daemon must not load the appmap sync");
	assert.equal(reach.has("ui/ui-core"), false, "the runner daemon must not load the Electron shell's logic");
});

test("substrate__ImportsNothingFromSrc__When__ItIsTheBottomLayer", () => {
	// types/paths/env/fsutil are what every layer is allowed to depend on, so they may depend on
	// nothing but node built-ins. One upward import here and the bottom of the stack has a cycle
	// waiting to happen.
	const edges = importGraph();
	for (const m of ["types", "paths", "env", "fsutil"]) {
		const tos = [...(edges.get(m) ?? [])];
		assert.deepEqual(tos, [], `src/${m}.ts must not import from src/: ${tos.join(", ")}`);
	}
});
