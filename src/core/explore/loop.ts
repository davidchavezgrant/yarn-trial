import type { ModelClient } from "../harness.js";
import Anthropic from "@anthropic-ai/sdk";
import { envNum } from "../../env.js";
import { boundaryDescription, classifyBoundary } from "../boundary.js";
import type { CdpBackend } from "../../backends/cdp.js";
import type { Driver } from "../driver.js";
import {
	actionTarget,
	declaredCredit,
	declaredDismiss,
	declaredIngest,
	declaredMatches,
	declaredRemaining,
	declaredSummary,
	checkDismissal,
	type DismissReason,
	type InteractiveElement,
	externalityTarget,
	sessionEndingChord,
	frontierCredit,
	frontierDismiss,
	frontierIngest,
	frontierMatches,
	frontierRemaining,
	frontierSummary,
	gatedId,
	isVagueSurface,
	observationBlocks,
	type ObservationBundle,
	recoverLeakedGraph,
	reversibleTarget,
	runEvent,
	settleMsFor,
	TargetNotObservableError,
	toActionRequest,
	type WindowRef,
} from "../harness.js";
import { appendMutation, detectMutation } from "../journal.js";
import type { Overlay } from "../overlay.js";
import type { AppMapEdge, AppMapNode } from "../../types.js";
import { checkpoint, hm, writeArtifacts } from "./artifacts.js";
import { CHAPTER_OBSERVATIONS, DESCENT_ON, DISMISS_CAP, GUARD_ON, MAX_ACTIONS, SETTLE_MS } from "./config.js";
import { requestFinish, streamCall } from "./model.js";
import { accumulatedGraph, type FinishInput, merge, type Pass } from "./state.js";

/**
 * Resolve a query-addressed action to the handle it operated, in the observation the model
 * saw. CdpBackend.resolveRef resolves `query` internally with this same case-insensitive
 * containment test and refuses ambiguity, so an act that succeeded matched exactly one
 * candidate there; demanding uniqueness HERE means a miss (say, the backend matched a
 * non-interactive row) credits nothing rather than guessing.
 */
const uniqueQueryHandle = (query: string, obs: ObservationBundle): string | number | undefined => {
	const q = query.toLowerCase();
	const hits = obs.interactive.filter((e) => e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));

	return hits.length === 1 ? hits[0].handle : undefined;
};

export type LoopDeps = {
	p: Pass;
	client: ModelClient;
	model: string;
	overlay: Overlay;
	interrupted: () => boolean;
	driver: Driver | undefined;
	cdp: CdpBackend | undefined;
	win: WindowRef | undefined;
	doObserve: (name: string) => Promise<ObservationBundle>;
};

export async function runExploreLoop({ p, client, model, overlay, interrupted, driver, cdp, win, doObserve }: LoopDeps): Promise<void> {
	let blindStreak = 0;
	/**
	 * Vision-only fork points, gathered here so the loop body reads the same in both modes.
	 * On a vision-only pass the model's ledger is DECLARED — built from its own survey/target
	 * calls (src/core/harness/declared-frontier.ts) — because the mechanical frontier's summary
	 * lists element names straight off the AX tree, which would leak the element list to a
	 * model meant to see only pixels. The harness's own observations keep flowing to the
	 * safety gates, the mutation journal and the blind-streak stop either way: the arm changes
	 * what the model SEES, never what the run can prove.
	 */
	const vo = p.visionOnly;
	// Constant for the pass: the guard verb sets differ on the web (a bare "Confirm" ships
	// state to a server there and is ordinary navigation in a desktop app), and both the
	// dismissal check and the label gates need the same answer.
	const web = p.target.kind === "web";
	const summary = () => (vo ? declaredSummary(p.declared) : frontierSummary(p.ledger));
	const remaining = () => (vo ? declaredRemaining(p.declared) : frontierRemaining(p.ledger));
	// The mechanical ledger stays EMPTY on a vision-only pass rather than being fed silently:
	// the stamp's tallies must be the declared ones, and two ledgers would be two answers to
	// "what did this pass cover".
	const ingest = (o: ObservationBundle) => {
		if (!vo) frontierIngest(p.ledger, o);
	};
	const obsBlocks = (o: ObservationBundle) => observationBlocks(o, p.vision, !vo);
	// Same handoff as the loop below: the banner starts visible and only a setDriving(false)
	// takes it down, so the opening observation has to be the thing that lowers it — else it
	// sits red through the first (long) model call with the machine idle.
	overlay.setDriving(true);
	let obs: ObservationBundle;
	try {
		obs = await doObserve(`${p.stepsDir}/explore-step-0`);
	} finally {
		overlay.setDriving(false);
	}
	/**
	 * A cold start can land on something that is not the app: a permissions gate, an
	 * onboarding wall, a window that has not painted. Mapping one of those produces a
	 * PLAUSIBLE artifact — on 2026-08-01 a pass mapped Yarn's "Recording Setup" screen and
	 * another mapped the macOS menu bar, both reporting frontier-empty and success, and both
	 * only detectable afterwards by reading the surface names in the stamp.
	 *
	 * So the first observation has to look like an application. The blindStreak check below
	 * catches a collapsed tree mid-run, but only after three consecutive failures — by which
	 * point a short pass may already have "finished". This is the same check applied once, up
	 * front, where the answer is unambiguous and the run has cost nothing yet.
	 */
	if (obs.appContent === 0)
		throw new TargetNotObservableError(p.app, "the first observation has no app content — a cold start that lands on a permissions gate, an onboarding wall, or an unpainted window maps that instead of the app");

	ingest(obs);
	p.messages.push({
		role: "user",
		content: [
			{
				type: "text",
				text:
					`Explore "${p.app}". There is no step budget and no time limit: this run ends when the frontier of un-operated controls is empty. ` +
					"If a surface takes minutes to respond — some apps embed an agent of their own — wait for it rather than moving on.\n\n" +
					`${summary()}\n\nInitial observation follows.`,
			},
			...obsBlocks(obs),
		],
	});

	/**
	 * Consecutive finish attempts refused for a non-empty frontier. The refusal is
	 * evidence rather than badgering — it hands back the actual list — so unlike the
	 * one-shot self-audit it replaced it can repeat. But a model that keeps calling
	 * finish and never acts would otherwise spin until the action backstop burning
	 * tokens, so after three the concession is taken and recorded as the stop reason.
	 */
	// Distinct surfaces the model has declared anything on — the coverage number the dry-round
	// sweep argues against, and the one the prompt quotes back to it.
	const surfaceCount = (pass: Pass): number => new Set([...pass.declared.seen.values()].map((v) => v.surface)).size;
	let finishRefusals = 0;
	// Consecutive empty-frontier finishes that added no new declarations before the pass is
	// allowed to concede. Two, not one: the first refusal is the hunt, the second confirms it
	// found nothing. See the block in the finish handler.
	const DRY_ROUNDS = envNum("EXPLORE_DRY_ROUNDS", 2);
	let dryFinishes = 0;
	let lastDeclaredAtFinish = -1;
	let obsThisChapter = 1;

	/**
	 * Chapter boundary: throw the transcript away and start a fresh context.
	 *
	 * Context, not step count, was the real ceiling — each observation is ~7k tokens and
	 * they all accumulate, so a 25-action pass was already ~175k. A sliding window would not
	 * survive a long run either: the assistant turns and tool results keep piling up over
	 * ~2000 actions, and pruning per turn would invalidate the prompt cache every single turn.
	 *
	 * A full reset is bounded no matter how long the pass runs. It is only safe because the
	 * durable memory now lives outside the transcript — findings and the accumulated graph,
	 * both already on disk — so what is discarded is reasoning, not knowledge. The frontier
	 * goes in the seed as well, which means the reset cannot lose track of where the pass
	 * still has to go.
	 *
	 * Both the normal action path and the descent path call this after pushing their one
	 * tool_result, so a descent-heavy stretch is bounded the same way an action-heavy one is.
	 * Returns the next `obsThisChapter` for the caller to store.
	 */
	const maybeChapterReset = (obsCount: number, obs: ObservationBundle): number => {
		if (obsCount + 1 < CHAPTER_OBSERVATIONS) return obsCount + 1;
		p.chapters++;
		checkpoint(p);
		const nodeList = [...p.graphNodes.values()].slice(0, 300).map((n) => `${n.id} (${n.kind})`).join(", ");
		const noteList = p.findings.slice(-120).map((f) => `- ${f}`).join("\n");
		console.log(`  --- chapter ${p.chapters}: context reset (${p.findings.length} findings, ${p.graphNodes.size} nodes carried forward) ---`);
		runEvent(p.stamp, "chapter", { chapter: p.chapters, findings: p.findings.length, nodes: p.graphNodes.size });
		p.messages.length = 0;
		p.messages.push({
			role: "user",
			content: [
				{
					type: "text",
					text:
						`You are exploring "${p.app}" and have been going for ${hm(Date.now() - p.startedAt)} over ${p.actions} actions. ` +
						`This is chapter ${p.chapters}: the earlier transcript has been cleared to bound context. Nothing else has changed — the app is where you left it, and everything below is what you recorded.\n\n` +
						`# Findings so far (${p.findings.length}${p.findings.length > 120 ? ", most recent 120 shown" : ""})\n${noteList}\n\n` +
						`# Graph so far (${p.graphNodes.size} nodes, ${p.graphEdges.size} edges)\n${nodeList || "(none recorded yet — start recording nodes as you go)"}\n\n` +
						// The declared frontier survives the reset the same way the AX one does: in
						// the seed. Without it a vision-only chapter would forget its own coverage.
						`# ${summary()}\n\n` +
						"There is no time limit on this pass — take as long as a surface needs. Current observation follows.",
				},
				...obsBlocks(obs),
			],
		});

		return 1;
	};

	for (;;) {
		// Same shape as the ceiling below: a stopped pass still asks for the map it has,
		// because forty minutes of exploration are worth more written down than discarded.
		if (interrupted()) {
			console.log(`\nstopped after ${p.actions} actions — asking for the map now`);
			runEvent(p.stamp, "finish", { stopped: "interrupted", actions: p.actions });
			await requestFinish(p, client, model, "The run was stopped. Call finish NOW with the map you have.", "interrupted", true);

			return;
		}

		if (p.actions >= MAX_ACTIONS) {
			console.log(`\naction ceiling (${MAX_ACTIONS}) reached — asking for the map now`);
			runEvent(p.stamp, "finish", { stopped: "action-ceiling", actions: p.actions });
			await requestFinish(p, client, model, `The action ceiling of ${MAX_ACTIONS} has been reached. Call finish NOW with the map you have.`, "action-ceiling", false);

			return;
		}

		const response = await streamCall(p, client, model, { cache_control: { type: "ephemeral" } });

		if (response.stop_reason === "refusal") throw new Error("model refused");

		const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		p.messages.push({ role: "assistant", content: response.content });

		if (!toolUse) {
			p.messages.push({ role: "user", content: `Call exactly one tool (act, ${vo ? "survey, " : ""}record, dismiss, or finish).` });
			continue;
		}

		if (toolUse.name === "finish") {
			const rest = remaining();
			/**
			 * A DECLARED frontier empties when the model runs out of ideas, not when the app
			 * runs out of surfaces — so "everything I declared is operated" is not evidence of
			 * coverage the way an exhausted element list is.
			 *
			 * Measured 2026-08-01: a vision-only pass reached 8 surfaces where the ax pass on
			 * the same app reached 31, and its 29 survey calls covered those same 8 places over
			 * and over (9x "Draft editor", 6x "Template editor"). It went deep and never went
			 * looking. finish was accepted on the first ask because rest was empty.
			 *
			 * So: refuse the first empty frontier and send it hunting for regions it has not
			 * opened. Concede only after DRY_ROUNDS consecutive attempts add no new
			 * declarations — the hunt itself is the evidence, not the model's confidence. A
			 * mechanical frontier needs none of this: its `rest` already holds every element
			 * the tree reported, including the ones that lead elsewhere.
			 */
			if (vo && rest.length === 0 && p.declared.seen.size > 0) {
				const grew = p.declared.seen.size > lastDeclaredAtFinish;
				lastDeclaredAtFinish = p.declared.seen.size;
				if (grew) dryFinishes = 0;
				else dryFinishes++;
				if (dryFinishes < DRY_ROUNDS) {
					console.log(`  finish deferred (dry ${dryFinishes}/${DRY_ROUNDS}): ${p.declared.seen.size} declared across ${surfaceCount(p)} surface(s) — sweeping for unopened regions`);
					p.messages.push({
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUse.id,
								content:
									`Before finishing: you have surveyed ${surfaceCount(p)} surface(s). An app almost always has more.\n\n` +
									"Name every navigation affordance you have SEEN but not opened — menu bar items, sidebar entries, tabs, toolbar overflow (\u2026) buttons, right-click menus, settings sections, anything that would change what fills the window. " +
									"Open the ones you have not, and survey what appears. If a sweep genuinely turns up nothing new, call finish again and it will be accepted.",
							},
						],
					});
					continue;
				}
			}
			// A vision-only pass with NOTHING surveyed has an empty frontier by construction —
			// the ledger only holds what the model declared — so an empty ledger is refused the
			// same way a non-empty one is: zero declarations is zero coverage, not full coverage.
			const unfinished = rest.length > 0 || (vo && p.declared.seen.size === 0);
			if (unfinished && ++finishRefusals <= 3) {
				console.log(`  finish refused (${finishRefusals}/3): ${rest.length} control(s) still un-operated${vo && p.declared.seen.size === 0 ? " (nothing surveyed)" : ""}`);
				p.messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							content:
								`Not yet — the frontier is not empty, and there is no time limit on this pass.\n\n${summary()}\n\n` +
								"Operate the ones that could open a surface you have not mapped. Dismiss the ones that are content rather than navigation, or that you must not touch — with a reason. " +
								"Then finish will be accepted.",
						},
					],
				});
				continue;
			}
			runEvent(p.stamp, "finish", {
				stopped: unfinished ? "frontier-conceded" : "frontier-empty",
				actions: p.actions,
				findings: p.findings.length,
				nodes: p.graphNodes.size,
			});
			writeArtifacts(p, toolUse.input as FinishInput, unfinished ? "frontier-conceded" : "frontier-empty");

			return;
		}

		if (toolUse.name === "record") {
			const input = toolUse.input as { finding: string; nodes?: AppMapNode[]; edges?: AppMapEdge[] };
			// The model sometimes writes its nodes/edges INTO the finding string as literal
			// tool-call markup. Recover them before storing, or the graph silently stalls
			// while the prose keeps growing. See recoverLeakedGraph().
			const leaked = recoverLeakedGraph(input.finding);
			p.findings.push(leaked.cleaned);
			const merged =
				merge(p, input) + (leaked.nodes.length || leaked.edges.length ? merge(p, leaked) : 0);
			const salvaged = leaked.nodes.length + leaked.edges.length;
			console.log(
				`  note: ${leaked.cleaned}${merged ? ` (+${merged} graph${salvaged ? `, ${salvaged} recovered` : ""})` : ""}`,
			);
			// Every record, not every Nth: the write is a few KB of local JSON, and batching
			// it only buys the chance to lose the nine findings since the last flush.
			checkpoint(p);
			p.messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: `recorded (${p.findings.length} findings, graph now ${p.graphNodes.size} nodes / ${p.graphEdges.size} edges)`,
					},
				],
			});
			continue;
		}

		// Vision-only only: the model declares what it can SEE on the current screen, which is
		// the sole way entries reach the declared frontier. A turn, not an action — like record.
		if (toolUse.name === "survey") {
			const input = toolUse.input as { surface?: string; controls?: Array<{ name?: string; note?: string }> };
			const added = declaredIngest(p.declared, String(input.surface ?? ""), input.controls ?? []);
			const rest = declaredRemaining(p.declared);
			console.log(`  survey "${input.surface ?? "<top level>"}": +${added} new, ${p.declared.seen.size} declared, ${rest.length} on frontier`);
			p.messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: `surveyed: ${added} new control(s) declared (${p.declared.seen.size} total). ${rest.length} on the frontier.`,
					},
				],
			});
			continue;
		}

		if (toolUse.name === "dismiss") {
			const input = toolUse.input as { names?: string[]; surface?: string; reason: string };
			let text: string;
			try {
				// A sweep this wide is one sentence of justification standing in for a hundred
				// separate decisions, and it is how a pass reaches "frontier-empty" cheaply.
				// Refused only when the surface is vague: a genuinely repetitive named panel
				// (80 identical list rows) is exactly what bulk dismissal is for.
				const matches = vo ? declaredMatches(p.declared, input) : frontierMatches(p.ledger, input);
				if (matches.length > DISMISS_CAP && isVagueSurface(input.surface)) {
					const surfaces = [...new Set(matches.map((e) => e.surface || "<top level>"))].slice(0, 12);
					console.log(`  dismiss REFUSED: ${matches.length} controls across ${surfaces.length} surface(s), no specific surface named`);
					p.messages.push({
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUse.id,
								is_error: true,
								content:
									`Refused: that would dismiss ${matches.length} controls at once (cap ${DISMISS_CAP}) without naming a specific surface. ` +
									"Nothing was dismissed. These are not one decision — dismiss them in groups you can each give a real reason for, " +
									`naming the surface, or open the surface and operate them. Surfaces in that match: ${surfaces.join(", ")}.`,
							},
						],
					});
					continue;
				}
				// VERIFY THE CATEGORY BEFORE RETIRING ANYTHING. A reason the harness cannot
				// corroborate is refused and costs a turn — otherwise the enum is just free
				// text with a shorter vocabulary, and the model learns which word gets past
				// the gate. Skipped on a vision-only pass: there is no element list to check a
				// label against, so the claim is unverifiable by construction.
				if (!vo) {
					const check = checkDismissal(input.reason as DismissReason, matches as InteractiveElement[], obs, {
						web,
						cohortSize: (e) => [...p.ledger.seen.values()].filter((o) => o.role === e.role && o.surface === e.surface).length,
					});
					if (check.refusal) {
						p.refusals++;
						console.log(`  dismiss REFUSED (${input.reason}): ${check.refusal.slice(0, 90)}…`);
						p.messages.push({
							role: "user",
							content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Nothing was dismissed. ${check.refusal}` }],
						});
						continue;
					}
				}

				const gone = vo ? declaredDismiss(p.declared, input) : frontierDismiss(p.ledger, input);
				const rest = remaining();
				// A silent zero match reads as "done" and the model moves on leaving the
				// entries in place; worse, it retries the same call with cosmetic variants.
				// Naming the surfaces that DO exist turns a wasted turn into a correction.
				text = gone.length
					? `dismissed ${gone.length} control(s). ${rest.length} remain.`
					: `matched NOTHING — nothing was dismissed and ${rest.length} still remain. ` +
						`Surfaces currently on the frontier: ${[...new Set(rest.map((e) => (e.surface ? `"${e.surface}"` : "<top level>")))].slice(0, 20).join(", ")}. ` +
						"Copy a name exactly as the frontier listing prints it.";
				console.log(`  dismiss ${gone.length}${input.surface !== undefined ? ` in "${input.surface}"` : ""}: ${input.reason}`);
				finishRefusals = 0;
			} catch (err) {
				text = `dismiss failed: ${err instanceof Error ? err.message : String(err)}`;
			}
			p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: text }] });
			continue;
		}

		if (toolUse.name === "claim") {
			const c = toolUse.input as { name: string; note?: string };
			p.claimed.push({ kind: "created", name: c.name, note: c.note, step: p.actions });
			// Persist as a resource mutation NOW, not at finish: this is the crash-recovery
			// the task agent lacks. A descent that dies after creating scratch but before
			// finishing still leaves a journal entry `npm run cleanup` can report.
			appendMutation(p.journalPath, { kind: "resource", control: c.name, surface: "", resource: c.name, step: p.actions });
			console.log(`    claim: "${c.name}"${c.note ? ` — ${c.note}` : ""}`);
			p.messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						content:
							`Claimed "${c.name}". It is recorded and will be reported at the end of the pass; ` +
							"it is NOT deleted automatically. Use it as the throwaway target for descent, not the user's own content.",
					},
				],
			});
			continue;
		}

		// Read-only page search: costs a turn but not an action, like record.
		if (toolUse.name === "find") {
			const q = (toolUse.input as { query: string }).query;
			let text: string;
			try {
				const hits = await cdp!.find(q);
				text = hits.length
					? `find("${q}") matched ${hits.length}:\n` +
						hits
							.slice(0, 40)
							.map((r) => `[${r.ref}] ${r.role} "${(r.name ?? "").slice(0, 80)}" (${r.actions.join(",") || "no actions"}) ${r.visibility}`)
							.join("\n")
					: `find("${q}") matched nothing. Try a shorter or differently-worded string.`;
			} catch (err) {
				text = `find("${q}") failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
			}
			p.findCalls++;
			console.log(`  find "${q}" -> ${text.split("\n")[0]}`);
			p.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: text }] });
			continue;
		}

		const input = toolUse.input as { reasoning?: string; action: any; target?: { name?: string; surface?: string } };

		if (vo) {
			// This pass never showed the model an element list, so an element_index here is a
			// fabricated number — executing it would actuate whatever element the walk happens
			// to put at that position. Rejected unexecuted, same gate as the task agent's.
			if (input.action?.element_index !== undefined) {
				console.log("  REFUSED: element_index in a vision-only pass");
				p.messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							is_error: true,
							content:
								"ACTION NOT EXECUTED — you passed element_index, but this pass has no element list; any index is a guess. " +
								"Address the target by screenshot pixel (x/y, from_x/from_y/to_x/to_y) and name it in `target`.",
						},
					],
				});
				continue;
			}
			// The declared target is the ONLY way an action reaches the frontier here, so an
			// act that operates a control without naming one would be an action the coverage
			// tallies can never account for. Only OPERATING verbs are held to it: a wait or an
			// escape press operates nothing, and forcing a target there would make the model
			// fabricate one — which the credit below would then count as coverage.
			const operates = ["click", "right_click", "double_click", "drag", "type_text", "set_value"].includes(String(input.action?.name));
			if (operates && !input.target?.name?.trim()) {
				console.log("  REFUSED: act without a declared target in a vision-only pass");
				p.messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							is_error: true,
							content:
								`ACTION NOT EXECUTED — a ${input.action?.name} operates a control, so on this pass it must declare \`target\` ({name, surface}): ` +
								"the control it operates, spelled as you surveyed it. That declaration is how the frontier records your coverage. Re-issue the action with a target.",
						},
					],
				});
				continue;
			}
		}

		// Unattended-safety pre-flight, now two gates with opposite answers (see
		// externalityTarget/reversibleTarget). Opting out is its OWN switch
		// (EXPLORE_GUARD=off): this used to ride on `guidance`, so steering the pass
		// silently disarmed the guard.
		//
		// EXTERNALITY — commits off the machine. Refused always, descent or not: one-way is
		// one-way, and reading the boundary would mean crossing it.
		//
		// Both gates read the HARNESS's AX observation — they are guards, not perception —
		// and their refusal messages name the offending control's label, which is a small,
		// accepted information leak to a vision-only model: safety wins over arm purity.
		// Checked before the label gates: a chord has no control attached, so those cannot see
		// it. Not conditioned on GUARD_ON — that switch exists to let a pass reach risky
		// CONTENT, never to let it end its own session.
		const chord = sessionEndingChord(input.action);
		if (chord) {
			p.refusals++;
			console.log(`  REFUSED: ${chord} — the pass cannot operate an app it has closed`);
			p.messages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Refused: ${chord}. Never quit, hide, or minimise the app you are exploring — you cannot observe it afterwards and the pass ends. Continue with another action.` }],
			});
			continue;
		}

		const external = GUARD_ON ? externalityTarget(input.action, obs, web) : undefined;
		if (external) {
			p.refusals++;
			const node = actionTarget(input.action, obs);
			p.gated.push({ id: gatedId(node, external), tierReached: 0, boundary: "not opened — off-machine", stoppedBecause: "externality:label", scratchUsed: false });
			console.log(`  REFUSED (externality): "${external}" commits off-machine and is never opened`);
			p.messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						is_error: true,
						content:
							`Refused by the harness: "${external}" commits something OFF the machine (send/publish/share/purchase/account) and is one-way. ` +
							"The action did not run and will not, on any setting. Record what the control appears to do and dismiss it.",
					},
				],
			});
			continue;
		}

		// REVERSIBLE — mutates local state that can be put back, or merely opens a local
		// flow behind a scary label. Refused by default; under EXPLORE_DESCENT it is pressed
		// ONCE to read the boundary and then Escaped without committing. Descent is forced
		// OFF on a vision-only pass — boundary reading is an element-identity feature — so
		// the reversible path always takes this refuse branch there.
		const reversible = GUARD_ON ? reversibleTarget(input.action, obs, web) : undefined;
		let descending = false;
		if (reversible) {
			if (!DESCENT_ON || vo) {
				p.refusals++;
				const node = actionTarget(input.action, obs);
				p.gated.push({ id: gatedId(node, reversible), tierReached: 0, boundary: "not opened — descent off", stoppedBecause: "descent:off", scratchUsed: false });
				console.log(`  REFUSED (reversible, descent off): "${reversible}"`);
				p.messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: toolUse.id,
							is_error: true,
							content:
								`Refused by the harness: "${reversible}" reads destructive and guarded descent is off for this pass. ` +
								"The action did not run. Record what the control appears to do and dismiss it, or reach the surface another way.",
						},
					],
				});
				continue;
			}
			descending = true;
			console.log(`  DESCENT: "${reversible}" is reversible-labelled — pressing once to read the boundary, then Escaping`);
		}

		p.actions++;
		finishRefusals = 0;
		console.log(`[${p.actions}] ${input.reasoning ?? ""}`);
		console.log(`    ${input.action.name} ${JSON.stringify({ ...input.action, name: undefined })}`);

		// The observation the model was looking at when it chose this action. Credit,
		// mutation detection and boundary classification are all only meaningful against it,
		// and `obs` is reassigned to the post-action snapshot below.
		const preObs = obs;

		let resultText: string;
		let isError = false;
		// The handle a query-addressed action resolved to. frontierCredit reads only
		// element_index/ref/coordinates, so a query-addressed action credits nothing
		// unless the resolution is carried back to it (see the credit below).
		let resolvedRef: string | undefined;
		// Banner up only while the pointer is ours. Exploration is as intrusive as a task
		// run, and just as thinking-dominated, so it gets the same treatment: visible for
		// the act/settle/re-observe window, hidden for the model call between.
		overlay.setDriving(true);
		try {
			try {
				if (cdp) {
					// Acts directly — no driver dispatch. assertSupported inside act() rejects
					// unknown verbs before anything executes, same contract as toActionRequest.
					resultText = (await cdp.act(input.action)).slice(0, 400);
				} else {
					const request = toActionRequest(input.action, win!);
					resultText = request
						? (await driver!.act(request)).text.slice(0, 400)
						: "waited (no driver action)";
				}
			} catch (err) {
				resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
				isError = true;
			}

			const settleMs = settleMsFor(input.action, SETTLE_MS);
			if (settleMs > SETTLE_MS) console.log(`    waiting ${Math.round(settleMs / 1000)}s before re-observing`);
			await new Promise((r) => setTimeout(r, settleMs));
			obs = await doObserve(`${p.stepsDir}/explore-step-${p.actions}`);
		} finally {
			// finally, not a trailing call: a throw from doObserve (a collapsed AX tree is
			// routine here) would otherwise strand the banner up for the rest of the pass.
			overlay.setDriving(false);
		}

		// Credit AFTER the act, against the PRE-act observation. The keys are only
		// meaningful against what the model saw — which needs the `preObs` binding held
		// above, not the ordering — and an action that threw (stale handle, driver
		// refusal) never operated its control: crediting it would retire a frontier entry
		// unvisited, and the stamp's headline `controls: N actuated` would overstate
		// coverage. Failure always arrives here as a throw (Driver.act and CdpBackend.act
		// both throw; the "ACTION FAILED:" string is built from the catch), so !isError is
		// the whole gate. A query-addressed action carries no handle of its own: attach
		// the ref the backend resolved (DOM), or the query's unique match in preObs (the
		// CDP backend resolves internally and returns only prose) — a non-unique match
		// credits nothing, which under-counts rather than guessing.
		let credited: string[] = [];
		if (!isError) {
			if (vo) {
				// The declared target IS the credit: no observation is consulted, so the model
				// cannot be credited for a control it did not name. Acting on a never-surveyed
				// control ingests it at the same moment — operating something is also seeing it.
				// A non-operating action (wait, a bare keystroke) may carry no target and
				// credits nothing, which under-counts rather than fabricates.
				const targetName = input.target?.name?.trim();
				if (targetName) {
					const { key, surveyed } = declaredCredit(p.declared, { name: targetName, surface: input.target?.surface ?? "" });
					credited = [key];
					if (!surveyed) console.log(`    target "${targetName}" was never surveyed — ingested and credited`);
				}
			} else {
				let creditAction = input.action;
				if (creditAction?.query !== undefined && creditAction.ref === undefined && creditAction.element_index === undefined) {
					const ref = resolvedRef ?? uniqueQueryHandle(String(creditAction.query), preObs);
					if (ref !== undefined) creditAction = { ...creditAction, ref };
				}
				credited = frontierCredit(p.ledger, creditAction, preObs);
			}
		}

		/**
		 * Journal what this action CHANGED, on every action — not only under descent.
		 *
		 * The prompt tells the pass "settings you change are put back automatically after the
		 * pass … picking a font or a colour is FREE", which is the single line most
		 * responsible for unblocking exploration. It was a LIE: detectMutation was reached
		 * only from the descent boundary path, descent defaults to off, and every Yarn pass
		 * ran with `descent: off` — so no journal existed and teardown had nothing to restore.
		 * Seven completed passes of 71-163 actions each left zero journals on disk.
		 *
		 * That is worse than not making the promise. The passes ran on different Macs, so each
		 * one left that box's Yarn with whatever brand defaults it last clicked, unrecorded —
		 * and phase 2 then measures "change the cursor type" against an app state a previous
		 * pass silently mutated, possibly including the target setting itself.
		 *
		 * Detection is a value diff across the two observations rather than the model's
		 * account of what it did, for the same reason verification is: a pass that reports its
		 * own side effects can only restore the ones it noticed having.
		 */
		if (!isError) {
			const mutation = detectMutation(input.action, preObs, obs, accumulatedGraph(p), p.actions);
			if (mutation) {
				appendMutation(p.journalPath, mutation);
				console.log(`    journaled: "${mutation.control}"${mutation.surface ? ` in ${mutation.surface}` : ""} ${JSON.stringify(mutation.before ?? "")} -> ${JSON.stringify(mutation.after ?? "")}`);
			}
		}

		if (obs.appContent === 0) {
			// AX tree collapsed (e.g. a modal/other window took over). Acting now means
			// acting blind — stop rather than let the model flail against a menu bar.
			if (++blindStreak >= 3)
				throw new TargetNotObservableError(p.app, "no addressable elements for 3 consecutive observations");
		} else blindStreak = 0;

		// Descent: the model pressed a reversible-labelled control ONLY so the harness could
		// read what it gates. The model never gets to press anything inside the modal — the
		// harness classifies the boundary, sends Escape ITSELF, and confirms it closed. The
		// read-and-Escape invariant is what makes descent safe even when the two-phase
		// assumption is wrong: Escape commits nothing, so the worst case is an inert press.
		if (descending) {
			// `reversible` is non-undefined here — `descending` is only set when it matched —
			// but the compiler can't see across the intervening actuation, so pin it.
			const gateLabel = reversible as string;
			const node = actionTarget(input.action, preObs);
			const boundary = classifyBoundary(preObs, obs);
			const desc = boundaryDescription(boundary);
			overlay.setDriving(true);
			try {
				const escAction = { name: "press_key", key: "escape", delivery_mode: "foreground" };
				if (cdp) {
					await cdp.act(escAction);
				} else {
					const esc = toActionRequest(escAction, win!);
					if (esc) await driver!.act(esc);
				}
				await new Promise((r) => setTimeout(r, SETTLE_MS));
				obs = await doObserve(`${p.stepsDir}/explore-step-${p.actions}-escape`);
			} finally {
				overlay.setDriving(false);
			}

			let stoppedBecause: string;
			let dirty = false;
			if (boundary.kind === "no-modal") {
				// The two-phase assumption was WRONG here: no modal, so the press may have
				// committed. detectMutation reads the truth from the value diff, not the
				// model's account. Graph passed undefined — a boundary read does not need
				// scope attribution, and cleanup restores by (control, surface).
				const mutation = detectMutation(input.action, preObs, obs, undefined, p.actions);
				if (mutation) {
					appendMutation(p.journalPath, mutation);
					dirty = true;
					stoppedBecause = "descent:no-modal-committed";
					console.log(`    descent MISS: no modal, "${mutation.control}" changed ${JSON.stringify(mutation.before)} -> ${JSON.stringify(mutation.after)} — journaled for cleanup`);
				} else {
					stoppedBecause = "descent:no-modal-inert";
					console.log("    descent: no modal appeared and nothing changed — the press was inert");
				}
			} else if (boundary.kind === "oauth-window") {
				stoppedBecause = "externality:oauth-window";
				console.log(`    descent: OAuth surface (${desc}) — read and backed out`);
			} else {
				stoppedBecause = `descent:read-and-escape:${boundary.kind}`;
				console.log(`    descent: ${desc} — read and Escaped`);
			}

			p.gated.push({
				id: gatedId(node, gateLabel),
				tierReached: boundary.kind === "no-modal" ? 0 : 1,
				boundary: desc,
				stoppedBecause,
				scratchUsed: p.claimed.length > 0,
			});
			checkpoint(p);

			frontierIngest(p.ledger, obs);
			const rest = frontierRemaining(p.ledger);
			const guidance =
				boundary.kind === "no-modal"
					? dirty
						? "No confirmation dialog appeared and a value changed — the harness journaled it for cleanup. Do NOT press this control again."
						: "No confirmation dialog appeared and nothing changed. It may commit on a later step or need scratch content to act on — record it and move on."
					: "The harness pressed Escape to close it WITHOUT committing, and the boundary is recorded. Do NOT press the control again — record anything else it revealed and move on.";
			p.messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: [
							{
								type: "text",
								text:
									`Descent on "${reversible}": ${desc}\n${guidance}` +
									(rest.length === 0 ? "\n\nTHE FRONTIER IS EMPTY — call finish." : `\n\n${frontierSummary(p.ledger)}`) +
									"\n\nNew observation follows.",
							},
							...observationBlocks(obs, p.vision),
						],
					},
				],
			});
			// One tool_result pushed, exactly like a normal action, so it counts toward the
			// chapter budget the same way — otherwise a descent-heavy stretch grows context
			// without ever triggering the reset that bounds it.
			obsThisChapter = maybeChapterReset(obsThisChapter, obs);
			continue;
		}

		// Journal what this action CHANGED, from the value diff rather than the model's
		// account — the same detection the task agent runs. Exploration is supposed to be
		// non-mutating, but a toggle it flips while mapping is a real change the pass must
		// be able to hand to teardown; without this, only descent's mutations were tracked
		// and an ordinary setting the pass nudged would be left changed. Only when descent
		// is on: a plain refuse-everything pass never runs teardown, so journaling would be
		// write-only. Graph passed so scope/settingKey attach when resolvable.
		if (DESCENT_ON && !isError) {
			const mutation = detectMutation(input.action, preObs, obs, accumulatedGraph(p), p.actions);
			if (mutation) {
				appendMutation(p.journalPath, mutation);
				console.log(`    journaled: "${mutation.control}"${mutation.surface ? ` in ${mutation.surface}` : ""} ${JSON.stringify(mutation.before ?? "")} -> ${JSON.stringify(mutation.after ?? "")}`);
			}
		}

		const before = vo ? p.declared.seen.size : p.ledger.seen.size;
		ingest(obs);
		const rest = remaining();
		const discovered = (vo ? p.declared.seen.size : p.ledger.seen.size) - before;
		console.log(
			`    -> ${credited.length} credited, ${discovered > 0 ? `+${discovered} new, ` : ""}${rest.length} on frontier, ${hm(Date.now() - p.startedAt)} elapsed`,
		);
		// COARSE by design: an explore pass runs 40-160 actions, so per-action events would
		// swamp the merged feed. Every tenth action is a progress heartbeat, not a step log.
		if (p.actions % 10 === 0)
			runEvent(p.stamp, "progress", {
				actions: p.actions,
				frontier: rest.length,
				seen: vo ? p.declared.seen.size : p.ledger.seen.size,
				elapsed: hm(Date.now() - p.startedAt),
			});

		const frontierNote =
			rest.length === 0
				? vo
					? "\n\nTHE DECLARED FRONTIER IS EMPTY — every control you surveyed has been operated or dismissed. If this screen (or any you saw) still shows controls you never declared, survey them now; otherwise call finish."
					: "\n\nTHE FRONTIER IS EMPTY — every interactive control seen so far has been operated or dismissed. Call finish now, unless you know of a surface you have not opened."
				: `\n\n${summary()}`;
		p.messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUse.id,
					is_error: isError,
					content: [
						{ type: "text", text: `Driver result: ${resultText}${frontierNote}\n\nNew observation follows.` },
						...obsBlocks(obs),
					],
				},
			],
		});

		obsThisChapter = maybeChapterReset(obsThisChapter, obs);
	}
}
