
## 2026-08-01T00:02:01.528Z — 3 collected (gpt-5.6-sol)

Only three of 76 planned runs have been collected, with one vision run still running, so every comparison is effectively n=1 per arm. On the comparable explore passes, CDP found much more UI than AX—1,985 versus 418 controls, 63 versus 31 surfaces, and 196 versus 156 graph nodes—but actuated only 55 versus 46 controls. That is a 2.8% actuation-to-seen rate for CDP versus 11% for AX. CDP also recorded 15 scope ambiguities versus one, while producing slightly fewer graph edges, 54 versus 57.

CDP’s broader discovery was not leaner in aggregate here: it took 36 versus 28 minutes, 333 versus 229 model calls, and 52,608 versus 35,004 output tokens—about 1.3× the time, 1.45× the calls, and 1.5× the tokens. It used 118 actions versus AX’s 133, but dismissed 1,933 controls versus 373. These single runs support “broader but noisier” discovery, not yet a backend choice.

The separate CDP exploration of Notion covered 1,238 controls, 119 surfaces, and 471 graph nodes, actuating 167 controls in 369 actions over 74 minutes, with 689 calls and 99,773 output tokens. Because it targets a different, much larger app, it is not a direct AX/CDP comparison. No grounded task runs, recipe replays, completed vision runs, pricing, or judge results are in yet, so the matrix cannot yet say what grounding or vision buys, whether replay is fleet-ready, or whether judges disagree with self-reports; none of the collected runs is marked successful.

## 2026-08-01T00:02:32.289Z — 3 collected (gpt-5.6-sol)

Only 3 of 76 planned runs are collected, with one vision run still running, so every comparison is effectively n=1. In the direct explore comparison, CDP discovered much more UI than AX: 1,985 versus 418 controls seen (4.7×), 63 versus 31 surfaces (2.0×), and 196 versus 156 graph nodes (1.3×). But it actuated only 55 versus 46 controls (1.2×) and recorded 15 versus 1 scope ambiguities. Its graph also had slightly fewer edges, 54 versus 57.

CDP was not leaner on the measured totals in this pair. It used 118 actions versus AX’s 133, but took 36 versus 28 minutes, made 333 versus 229 model calls, and emitted 52,608 versus 35,004 output tokens. It saw 16.8 controls per action versus AX’s 3.1, but most of that extra discovery was dismissed: 1,933 controls versus 373. The current evidence therefore shows broader CDP discovery accompanied by more ambiguity and compute, not yet whether that breadth is useful.

The separate Notion CDP exploration shows the scale of grounding a larger web app: 1,238 controls seen, 167 actuated, 119 surfaces, and 471 graph nodes over 74 minutes, 369 actions, 689 model calls, and 99,773 output tokens. There are no grounded task runs, recipe replays, completed vision results, priced runs, or judge decisions yet, so the matrix cannot yet say what grounding or vision buys, whether replay is fleet-ready, which backend should be built on, or whether judges disagree with self-reports.

## 2026-08-01T00:19:46.730Z — 3 collected (gpt-5.6-sol)

With one pass per arm, on the same app CDP exposed 4.75× as many controls as AX but actuated only 1.20× as many, yielding 2.8% actuation versus 11.0%. Its map spanned 2.03× more surfaces and 1.26× more nodes, yet had 15× the scope ambiguities and 24% fewer edges per node. CDP also took 1.30× longer, used 1.45× more model calls and 1.50× more output tokens, despite 11% fewer actions. On Notion, CDP’s actuation yield was 4.87× its same-backend benchmark yield (13.5% versus 2.8%), with 89% fewer scope ambiguities per action.

## 2026-08-01T00:21:01.700Z — 3 collected (gpt-5.6-sol)

On one pass per backend, CDP saw 4.7× more controls but actuated only 1.2× more, cutting actuation density from 11.0% to 2.8%. CDP also produced 2.0× more surfaces and 1.3× more graph nodes, but 15× more scope ambiguities. That broader discovery cost 1.5× more output tokens, 1.5× more model calls, and 1.3× more time despite 11% fewer actions. On Notion, CDP’s map reached 2.4× Yarn’s nodes and 1.9× its surfaces, while taking 2.1× longer and 1.9× more tokens.

## 2026-08-01T00:30:37.654Z — 3 collected (gpt-5.6-sol)

On single passes, CDP’s scope-ambiguity rate was 12× AX’s per graph node, sharpening the backend risk beyond the raw 15× count. CDP’s graph was also 24% less connected than AX’s by edges per node despite having 1.3× more nodes. Notion CDP achieved 4.9× Yarn CDP’s actuation density, while controls actuated per action were nearly identical at 45% versus 47%.

## 2026-08-01T00:33:17.509Z — 3 collected (gpt-5.6-sol)

On one pass each, Yarn CDP used 1.70× more output tokens and 1.64× more model calls per action than AX. CDP exposed 5.35× more controls and 2.29× more surfaces per action, but actuated only 1.35× more controls per action. Accordingly, CDP actuated just 2.8% of seen controls versus AX’s 11.0%, a 4.0× lower conversion. CDP also took 1.30× longer overall while completing 11% fewer actions.

## 2026-08-01T00:42:26.568Z — 4 collected (gpt-5.6-sol)

Screenshot-only Yarn exploration produced 4.7× fewer surfaces and 3.6× fewer graph nodes per action than AX, despite taking 1.22× more actions and 1.06× longer overall. It used 21% fewer model calls per action, while output tokens per action were essentially flat at 1.02× AX. On Notion, CDP saw 5.0× fewer controls per action than on Yarn yet actuated 0.97× as many, raising conversion from 2.8% to 13.5% (one pass each). Notion CDP also used 39% fewer output tokens, 34% fewer calls, and 9.4× fewer scope ambiguities per action than Yarn CDP.

## 2026-08-01T00:53:50.282Z — 4 collected (gpt-5.6-sol)

On AX, screenshots cut controls seen per action by 52% but raised seen-to-actuated conversion from 4.9% to 11.0%, with one pass each. Vision also produced 27% more surfaces and 6% more graph nodes per action while requiring 14% fewer model calls and 21% fewer output tokens per action. The vision-enabled pass finished 9% faster with 18% fewer actions.

## 2026-08-01T00:54:41.373Z — 4 collected (gpt-5.6-sol)

Against AX, CDP saw 5.4× more controls per action and 2.3× more surfaces, but converted only 2.8% of seen controls into actuations versus 11.0%. Its graph had 42% more nodes per action, while scope ambiguities per action were 17× higher. CDP also used 64% more model calls, 69% more output tokens, and 47% more elapsed time per action; comparisons are one pass per backend. On Notion, CDP converted 13.5% of seen controls, 4.9× its 2.8% conversion on Yarn, while using 34% fewer calls and 39% fewer tokens per action.

## 2026-08-01T00:56:25.285Z — 4 collected (gpt-5.6-sol)

In one pass per arm, removing vision from AX doubled controls seen per action but cut seen-to-actuated conversion from 11.0% to 4.9%, with 8% fewer actuations per action. No-vision AX used 17% more calls and 26% more output tokens per action, despite 11% lower elapsed time per action. It also found 21% fewer surfaces and 6% fewer graph nodes per action, while scope ambiguity remained negligible.
