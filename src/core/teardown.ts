import Anthropic from "@anthropic-ai/sdk";
import type { CdpBackend } from "../backends/cdp.js";
import { CDP_ACT_TOOL } from "../backends/cdp.js";
import type { Driver } from "./driver.js";
import { envNum } from "../env.js";
import {
	ACT_TOOL,
	destructiveTarget,
	findWindow,
	observationBlocks,
	observe,
	toActionRequest,
	verify,
} from "./harness.js";
import { type Mutation, restoreRoute } from "./journal.js";
import type { ObservationBundle } from "./harness.js";
import type { ActionRequest, AppMap, Expectation, StepRecord } from "../types.js";

/**
 * Putting the app back after a run, entry by entry.
 *
 * The forward loop asks the model both what to do and what should happen; teardown asks only
 * the first. The target value is already known — it is what the control read before the run
 * touched it — so the harness writes the expectation itself rather than accepting one. That
 * removes the failure the forward loop has to guard against with `auditTaskPrompt()` and the
 * discrimination check: a restore cannot talk its way into looking successful, because the
 * string it is checked against was recorded before the model had any say in the matter.
 *
 * Restores are attempted in REVERSE order. A run that opened a panel, changed a setting
 * inside it, and navigated on leaves a trail whose last state is nearest to hand, and later
 * changes can depend on earlier ones (a value only reachable once a mode was switched) while
 * the reverse is not true.
 */

const SETTLE_MS = 900;

/**
 * Does the NAMED control read this value?
 *
 * A haystack grep cannot answer that, and the difference is not academic: opening a combobox
 * renders every option it offers, so the original value appears on screen at the exact moment
 * the control has NOT been set back to it. `verify()` would score that as passing — and score
 * it as discriminating too, since the option text was absent before the menu opened. The
 * restore would report success from a dropdown standing open on an unchanged setting.
 *
 * Scanning `InteractiveElement.value` asks the narrower question the journal already asks on
 * the way in, so detection and restoration are symmetric: the same field that said the value
 * changed is the one that says it changed back.
 */
export function controlReads(obs: ObservationBundle, control: string, surface: string, value: string): boolean {
	const want = value.trim().toLowerCase();
	// Surface leniency applies only when the JOURNAL did not record a surface. When it did, an
	// element whose own surface is blank must NOT match it: `surface: ""` is common (the nearest
	// named ancestor was unlabeled) and letting it wildcard-match reopens the exact brand-vs-
	// document hole the scope machinery exists to close — a document-scope twin rendering under
	// an unlabeled container would satisfy a brand-scope restore.
	const matches = obs.interactive.filter(
		(e) => e.name === control && (!surface || e.surface === surface),
	);
	// Restoring a field to blank is a real target, and substring containment cannot express
	// it — every string contains "". Exact emptiness is the check there.
	if (want === "") return matches.length > 0 && matches.some((e) => e.value.trim() === "");

	// Whole-value equality, not substring containment. Detection (journal.ts) compares values
	// with `===`; restoration must ask the same question or the two stop being symmetric. A
	// substring match reports success on a prefix-overlapping neighbour — restoring "Auto" is
	// satisfied by the control reading "Auto-hide" — and Yarn's own settings carry exactly such
	// pairs. Case is folded (the app may re-render "ARROW-FIRST") but nothing wider.
	return matches.some((e) => e.value.trim().toLowerCase() === want);
}

const SYSTEM = `You are undoing changes a UI automation run made to an app, one at a time, so the app is left as it was found.

You are told the control, the surface it lives on, the value to put back, and usually the navigation route to reach it. Each turn you get an observation of the target window and perform ONE action with the "act" tool.

This is a restoration, not a task: do not improve anything, do not tidy anything you were not asked about, and do not touch controls other than the one named (beyond what navigating to it requires). If the control already reads the target value, say so by calling act with a "wait" — the harness checks the value itself and will end the entry.

The harness supplies the success check, so your "expectation" field is only a note to yourself; it is not what decides the outcome. What it checks is the CONTROL'S OWN VALUE, not whether the text appears somewhere on screen — so leaving a dropdown open on the right option does not count. Select the value, close the picker, and commit it if the surface has a Save/Done/Apply affordance.`;

export interface TeardownEntry {
	control: string;
	surface: string;
	scope?: string;
	wanted?: string;
	leftAt?: string;
	restored: boolean;
	why: string;
}

/**
 * Split finished entries into the three outcomes a receipt distinguishes.
 *
 * Pure, and separate from `runTeardown` so it can be tested without a driver — the counts are
 * what `CLEANUP=block` reads to decide a run's verdict, so getting them wrong is not a
 * cosmetic error. The distinction that matters: an entry with no recorded prior value was
 * never ATTEMPTED, so it cannot have failed. Counting it as a failure would fail a run over
 * the harness honestly declining to guess.
 */
export function tallyEntries(entries: TeardownEntry[]): {
	attempted: TeardownEntry[];
	restored: TeardownEntry[];
	dirty: TeardownEntry[];
	unrestorable: TeardownEntry[];
} {
	const unrestorable = entries.filter((e) => e.wanted === undefined);
	const attempted = entries.filter((e) => e.wanted !== undefined);

	return {
		attempted,
		restored: attempted.filter((e) => e.restored),
		dirty: attempted.filter((e) => !e.restored),
		unrestorable,
	};
}

export interface TeardownArgs {
	/** Exactly one of driver/cdp: the AX path restores through the driver against a window,
	 *  the CDP path through the page. Same journal, same checks, same receipt either way. */
	driver?: Driver;
	cdp?: CdpBackend;
	client: Anthropic;
	model: string;
	app: string;
	journal: Mutation[];
	claimed: Array<{ kind: string; name: string; note?: string; step: number }>;
	graph?: AppMap;
	/** Restore steps are appended here; the caller keeps them out of the task's tallies. */
	steps: StepRecord[];
	budget: number;
	/**
	 * What produced this teardown, recorded in the receipt. An in-run pass passes its
	 * `CLEANUP` setting; `src/core/cleanup.ts` passes "cli". Reading it out of the environment
	 * here would label a standalone replay with whatever the shell happened to export.
	 */
	mode: string;
	vision: boolean;
	usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; modelCalls: number };
}

/**
 * Collapse a journal to one entry per control, keeping the EARLIEST `before` and the LATEST
 * `after`.
 *
 * A run that cycles a combobox through three values writes three journal entries for one
 * control, and replaying them all would restore it to the second value before restoring it
 * to the first — extra actions to reach the same place, each one able to fail. What the app
 * needs back is the value it held before the run started, which is the first entry's
 * `before`.
 */
export function collapseJournal(journal: Mutation[]): Mutation[] {
	const byControl = new Map<string, Mutation>();
	for (const m of journal) {
		if (m.kind !== "setting") continue;
		// JSON, not `${surface} ${control}`: a space join makes surface "Screen Clip" + control
		// "Style" collide with surface "Screen" + control "Clip Style", silently merging two
		// different controls' mutations — and space-containing names are the norm here.
		const key = JSON.stringify([m.surface, m.control]);
		const seen = byControl.get(key);
		if (seen) byControl.set(key, { ...seen, after: m.after });
		else byControl.set(key, m);
	}

	return [...byControl.values()];
}

/**
 * Restore one control. Returns the entry as it will be reported.
 *
 * The budget is spent on navigation, not on deciding what "done" means: the check runs after
 * every action, so an entry that arrives at the right value on its second step stops there.
 */
async function restoreOne(a: TeardownArgs, m: Mutation, index: number): Promise<TeardownEntry> {
	const base: TeardownEntry = {
		control: m.control,
		surface: m.surface,
		scope: m.scope,
		wanted: m.before,
		leftAt: m.after,
		restored: false,
		why: "",
	};
	// `undefined` and `""` are different facts and the journal preserves them separately.
	// Undefined means no prior value could be read, and guessing is worse than saying so.
	// An empty string means the field was genuinely BLANK before the run typed into it, which
	// is restorable — by clearing it — and treating that as unrestorable would leave the
	// agent's text sitting in a field the user left empty.
	if (m.before === undefined)
		return { ...base, why: "no prior value was recorded, so nothing can be restored" };

	const win = a.cdp ? undefined : await findWindow(a.driver!, a.app);
	const doObserve = (name: string) => (a.cdp ? a.cdp.observe(name) : observe(a.driver!, win!, name));
	const route = a.graph && m.settingKey ? restoreRoute(a.graph, m.settingKey, m.scope) : "";
	// Annotation only — `controlReads` decides the outcome. A blank target has no substring
	// to grep, so the include list is dropped rather than filled with "", which would match
	// every haystack and read as a passing check in the step log.
	const wanted: Expectation = m.before
		? { description: `${m.control} reads "${m.before}" again`, textIncludes: [m.before] }
		: { description: `${m.control} is empty again` };

	let obs = await doObserve(`cleanup-${index}-0`);
	// The run may have ended on the very surface this control lives on, in which case the
	// value is already back within reach and the model never needs to be called at all.
	if (controlReads(obs, m.control, m.surface, m.before))
		return { ...base, restored: true, why: "already read the original value; no action needed" };

	const messages: Anthropic.MessageParam[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text:
						`Put one setting back to how it was before an automation run changed it.\n\n` +
						`Control: "${m.control}"\n` +
						`Surface: ${m.surface || "(not recorded)"}\n` +
						(m.scope ? `Scope: ${m.scope} — restore it at THIS scope, not a similarly-named control elsewhere.\n` : "") +
						`Value to restore: "${m.before}"\n` +
						`Value the run left it at: "${m.after ?? "(unknown)"}"\n` +
						(route ? `Route recorded during grounding: ${route}\n` : "") +
						`\nObservation follows.`,
				},
				...observationBlocks(obs, a.vision),
			],
		},
	];

	for (let step = 1; step <= a.budget; step++) {
		const r = await a.client.messages.create({
			model: a.model,
			max_tokens: 2000,
			system: SYSTEM,
			tools: [a.cdp ? CDP_ACT_TOOL : ACT_TOOL],
			messages,
		});
		a.usage.modelCalls++;
		a.usage.inputTokens += r.usage.input_tokens;
		a.usage.outputTokens += r.usage.output_tokens;
		const toolUse = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		if (!toolUse) return { ...base, why: `the model stopped issuing actions after ${step - 1} step(s)` };

		messages.push({ role: "assistant", content: r.content });
		const input = toolUse.input as { action: any; expectation?: Expectation };
		let resultText = "";
		// What the step record reports as the action. On the CDP path there is no driver
		// request — requestForLog captures the model's own arguments, the same shape agent.ts
		// records for cdp steps.
		let request: ActionRequest | null = null;
		// The same label guard the exploration pass runs, for the same reason and with more
		// force here: this loop runs unattended, after the run it is tidying up has already
		// reported its result, and nobody is watching. Putting a value back never requires a
		// destructive verb, so a proposed "Delete" is a navigation mistake — the model looking
		// for its control on the wrong surface — and refusing costs one step of a ten-step
		// budget. The reverse mistake is not recoverable.
		const destructive = destructiveTarget(input.action, obs);
		if (destructive) {
			resultText = `REFUSED: "${destructive}" reads destructive and a restore never needs one. Find the named control instead.`;
			console.log(`    refused destructive restore action on "${destructive}"`);
		} else {
			try {
				if (a.cdp) {
					request = input.action?.name === "wait" ? null : a.cdp.requestForLog(input.action);
					resultText = (await a.cdp.act(input.action)).slice(0, 300);
				} else {
					request = toActionRequest(input.action, win!);
					resultText = request ? (await a.driver!.act(request)).text.slice(0, 300) : "waited";
				}
			} catch (err) {
				resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		// Read per step rather than at module load: the fake-actuator tests zero it so they do
		// not spend real seconds settling, and a Mac with a slow target can raise it the same way.
		await new Promise((res) => setTimeout(res, envNum("CLEANUP_SETTLE_MS", SETTLE_MS)));
		obs = await doObserve(`cleanup-${index}-${step}`);

		// The harness's check, not the model's — `wanted` came from the journal before this
		// loop began, so nothing the model says can widen it. The value scan is the authority
		// and the haystack grep only annotates the step, because the two disagree in exactly
		// the case that matters: an open dropdown showing the original value as one of its
		// options satisfies the grep while the setting itself is untouched.
		const reads = controlReads(obs, m.control, m.surface, m.before);
		const grep = verify(wanted, obs.haystack);
		a.steps.push({
			// Numbered across the whole teardown, not per entry: three entries at budget 2 would
			// otherwise write indices 1,2,1,2,1,2 and any consumer ordering by index mis-reads
			// the sequence. `a.steps` starts empty (the caller keeps restore steps apart from
			// the task's), so length + 1 is the running counter.
			index: a.steps.length + 1,
			timestamp: new Date().toISOString(),
			action: request ?? { kind: "tool", name: input.action?.name ?? "unknown", args: {} },
			expectation: wanted,
			verified: reads,
			verificationChannel: reads ? "text" : undefined,
			verificationNote: reads
				? `"${m.control}" reads ${JSON.stringify(m.before)}`
				: grep.verified
					? `${JSON.stringify(m.before)} is on screen, but "${m.control}" does not read it — likely an open picker rather than a set value`
					: grep.note,
			modelReasoning: `restore "${m.control}" to "${m.before}"`,
		});
		if (reads) return { ...base, restored: true, why: `restored in ${step} step(s)` };

		// The follow-up MUST lead with a tool_result paired to the assistant's tool_use id —
		// the API rejects an unanswered tool_use with a 400, which killed every restore that
		// needed a second action. Same shape as the forward loop in src/core/agent.ts.
		messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: [
						{
							type: "text",
							text: `Driver result: ${resultText}\nThe control does not yet read "${m.before}". New observation follows.`,
						},
						...observationBlocks(obs, a.vision),
					],
				},
			],
		});
	}

	return { ...base, why: `not restored within ${a.budget} steps` };
}

export async function runTeardown(a: TeardownArgs): Promise<Record<string, unknown>> {
	// Both would make every act ambiguous; neither would make restoreOne dereference undefined
	// ten steps in. Refuse at the boundary, where the mistake is a stack trace with a caller.
	if (!!a.driver === !!a.cdp) throw new Error("runTeardown needs exactly one of driver/cdp");
	const settings = collapseJournal(a.journal).reverse();
	const created = a.claimed.filter((c) => c.kind === "created");
	if (!settings.length && !created.length) return { mode: a.mode, attempted: 0, restored: 0, failed: 0, dirty: [] };

	console.log(`\n=== cleanup: ${settings.length} changed setting(s) ===`);
	const entries: TeardownEntry[] = [];
	for (const [i, m] of settings.entries()) {
		// Per-entry isolation. restoreOne guards `driver.act` but not `findWindow`, `observe`, or
		// the model call, so one transient TargetNotObservableError on entry 1 of 5 would abandon
		// entries 2-5 — and in the CLI it propagates all the way to main().catch, reporting 0/0.
		// A thrown entry is recorded as dirty and the loop continues to the rest.
		let entry: TeardownEntry;
		try {
			entry = await restoreOne(a, m, i);
		} catch (err) {
			entry = {
				control: m.control,
				surface: m.surface,
				scope: m.scope,
				wanted: m.before,
				leftAt: m.after,
				restored: false,
				why: `restore threw: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		entries.push(entry);
		// "–" rather than a tick or a cross for an entry that was never attempted: it neither
		// succeeded nor failed, and either mark would assert something about a restore that
		// did not run.
		const mark = entry.wanted === undefined ? "–" : entry.restored ? "✓" : "✗";
		console.log(`  ${mark} "${entry.control}" -> ${JSON.stringify(entry.wanted ?? "")} — ${entry.why}`);
	}

	const { attempted, dirty, unrestorable } = tallyEntries(entries);
	/**
	 * Claimed resources are REPORTED, not deleted.
	 *
	 * Deletion is the one operation with no second chance, and the ledger is only as good as
	 * the model's discipline in calling `claim` — a name it never claimed looks identical here
	 * to a name that does not exist. Naming what was left behind costs a line of output; the
	 * reverse mistake costs someone's work. Disposal moves behind an explicit flag once the
	 * ledger has been observed to be accurate across real runs.
	 */
	if (created.length) {
		console.log(`  ${created.length} claimed resource(s) left in place (disposal is not automatic):`);
		for (const c of created) console.log(`    · "${c.name}"${c.note ? ` — ${c.note}` : ""}`);
	}
	const note = unrestorable.length ? ` (${unrestorable.length} had no recorded prior value and were not attempted)` : "";
	if (dirty.length)
		console.log(
			`cleanup: ${attempted.length - dirty.length}/${attempted.length} restored${note}. STILL MODIFIED: ` +
				dirty.map((d) => `"${d.control}"${d.scope ? ` [${d.scope}]` : ""} left at ${JSON.stringify(d.leftAt ?? "")}`).join("; "),
		);
	else if (attempted.length) console.log(`cleanup: all ${attempted.length} change(s) restored${note}`);
	else if (unrestorable.length) console.log(`cleanup: nothing restorable${note}`);

	return {
		mode: a.mode,
		attempted: attempted.length,
		restored: attempted.length - dirty.length,
		failed: dirty.length,
		dirty,
		...(unrestorable.length ? { unrestorable } : {}),
		...(created.length ? { resourcesLeft: created.map((c) => c.name) } : {}),
	};
}
