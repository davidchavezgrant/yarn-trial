import fs from "node:fs";
import path from "node:path";
import { type ObservationBundle, resolveTarget, routeTo } from "./harness.js";
import type { AppMap, SurfaceScope } from "./types.js";

/**
 * What a run changed, recorded as it happens so teardown can put it back.
 *
 * A run mutates a real workspace — the canonical Yarn task changes a brand-wide Cursor Style
 * that nothing restored, so every measurement after the first started from a workspace the
 * previous one had altered. The journal is the record that makes cleanup possible; without a
 * `before` captured at the moment of the change, the original value is simply gone, because
 * the app offers no undo and the agent's own transcript is not evidence.
 */

export type MutationKind = "setting" | "resource";

export interface Mutation {
	kind: MutationKind;
	/** Element label at mutation time, e.g. "Cursor Style". */
	control: string;
	/** InteractiveElement.surface — the containing panel, e.g. "Screen Clip Settings". */
	surface: string;
	/** From the appmap graph when resolvable. Names the setting independent of where it is edited. */
	settingKey?: string;
	/** From the appmap graph when resolvable. Which store was written. */
	scope?: SurfaceScope;
	/**
	 * The value the control read BEFORE the action. `undefined` means unrestorable — the
	 * observation could not read a prior value — and teardown reports that rather than
	 * guessing. An empty string is a DIFFERENT fact (a field that was genuinely blank) and is
	 * preserved as observed; see restoreOne() in src/teardown.ts, which distinguishes them.
	 */
	before?: string;
	after?: string;
	/** Step index that caused it. */
	step: number;
	/** For kind:"resource" — agent-claimed name. Nothing in a value diff can detect one. */
	resource?: string;
}

/**
 * Titles come from the explore pass typing what it saw in the AX tree, and the same label
 * reaches us through a different observation, so whitespace and case are not reliably equal.
 */
const titleEq = (a: string, b: string): boolean =>
	a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The surface a control node hangs off, as a name comparable to `InteractiveElement.surface`.
 *
 * Node ids are paths, so the parent is the id minus its last segment. That parent is usually
 * itself a node with a human title ("Screen Clip Settings"), which is the string an observation
 * carries — but an explore pass emits control nodes whose parent surface it never recorded, so
 * the raw id segment is the fallback. Both paths are live on the committed Yarn appmap.
 */
function parentSurface(map: AppMap, nodeId: string): string {
	const parentId = nodeId.split("/").slice(0, -1).join("/");
	if (!parentId) return "";

	return map.nodes.find((n) => n.id === parentId)?.title ?? parentId.split("/").pop() ?? "";
}

/**
 * Resolve the graph's name for a control the agent just operated.
 *
 * The label alone is ambiguous by construction: on the committed Yarn appmap ten settings are
 * editable at both brand and document scope (measured 2026-07-30 via `findScopeAmbiguities()`;
 * it is a property of the current map, so re-measure after any exploration pass), and two
 * `cursor-style` nodes can carry the same title. So when candidates disagree on scope, the OBSERVED surface breaks the tie — that is
 * the panel the click actually landed in, which is evidence about the store rather than an
 * inference from the label. Zero or several surface matches leaves scope unset: an
 * inferred-from-nothing scope would send teardown to the wrong control, which is worse than
 * telling it we do not know.
 */
function graphFields(
	map: AppMap | undefined,
	control: string,
	surface: string,
): { settingKey?: string; scope?: SurfaceScope } {
	if (!map) return {};

	const candidates = map.nodes.filter((n) => n.kind === "control" && titleEq(n.title, control));
	if (candidates.length === 0) return {};

	const keys = new Set(candidates.map((n) => n.settingKey).filter((k): k is string => !!k));
	const settingKey = keys.size === 1 ? [...keys][0] : undefined;

	const scopes = new Set(candidates.map((n) => n.scope));
	if (scopes.size === 1) return { settingKey, scope: [...scopes][0] };

	const onSurface = surface
		? candidates.filter((n) => titleEq(parentSurface(map, n.id), surface))
		: [];

	return { settingKey, scope: onSurface.length === 1 ? onSurface[0].scope : undefined };
}

/**
 * Did this action change a control's value?
 *
 * Matching is by `(name, surface)` across the two observations, never by handle: element
 * indices are a walk order that renumbers whenever the tree changes shape, which is precisely
 * what an action causes. The same pair keys `collapseJournal()` in src/teardown.ts, so a run
 * that cycles one control writes entries that collapse back onto it.
 *
 * The false positive worth avoiding is navigation. Most clicks in a run open a panel or a menu
 * and change no value at all, and a teardown that tried to "restore" one of those would fight
 * the app — so a click whose target reads the same value afterwards, or whose target is gone
 * from the next observation (a menu that closed), is not a mutation.
 */
export function detectMutation(
	action: any,
	prevObs: ObservationBundle,
	nextObs: ObservationBundle,
	graph: AppMap | undefined,
	step: number,
): Mutation | undefined {
	const target = resolveTarget(action, prevObs);
	if (!target) return undefined;

	const after = nextObs.interactive.find((e) => e.name === target.name && e.surface === target.surface);
	if (!after || after.value === target.value) return undefined;

	return {
		kind: "setting",
		control: target.name,
		surface: target.surface,
		...graphFields(graph, target.name, target.surface),
		before: target.value,
		after: after.value,
		step,
	};
}

/**
 * Append one mutation, immediately.
 *
 * JSONL and one synchronous append per mutation, mirroring the checkpoint in src/explore.ts:
 * a run is killed often enough that the recoverable state has to be on disk before the next
 * action, and rewriting a whole file would lose everything if the kill landed mid-write.
 */
export function appendMutation(file: string, m: Mutation): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(m)}\n`);
}

/**
 * Read a journal back. A missing file is the ordinary case of a run that changed nothing.
 *
 * Unparseable lines are skipped rather than thrown on: a torn final line is exactly the crash
 * the append-per-mutation format exists to survive, and discarding the good records in front
 * of it would give up the whole point.
 */
export function readJournal(file: string): Mutation[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}

	const out: Mutation[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Mutation);
		} catch {
			continue;
		}
	}

	return out;
}

/**
 * How to navigate back to a control, for teardown.
 *
 * Returns "" when the graph does not name the setting. Teardown treats an empty route as
 * "navigate on your own" and still hands the model the control, surface and scope, so a
 * missing route degrades a restore rather than invalidating it.
 */
export function restoreRoute(graph: AppMap, settingKey: string, scope?: SurfaceScope): string {
	const node =
		graph.nodes.find((n) => n.kind === "control" && n.settingKey === settingKey && (!scope || n.scope === scope))
		?? (scope ? undefined : graph.nodes.find((n) => n.kind === "control" && n.settingKey === settingKey));
	if (!node) return "";

	return routeTo(graph, node.id);
}
