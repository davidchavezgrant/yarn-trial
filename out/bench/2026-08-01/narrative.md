
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

## 2026-08-01T00:59:54.828Z — 4 collected (gpt-5.6-sol)

With one pass per arm, CDP saw 5.4× more controls per action than AX but converted only 2.8% versus 11.0%, while still actuating 35% more per action. CDP mapped 2.3× more surfaces and 42% more graph nodes per action, but incurred 17× more scope ambiguities. CDP also cost 64% more calls, 69% more output tokens, and 47% more time per action than AX. On Notion, CDP used 34% fewer calls and 39% fewer tokens per action than on Yarn, with 89% fewer scope ambiguities per action.

## 2026-08-01T01:01:02.462Z — 4 collected (gpt-5.6-sol)

In one pass per arm, removing screenshots from AX doubled controls seen per action but cut seen-to-actuated conversion from 11.0% to 4.9%, producing 8% fewer actuations per action. Tree-only exploration mapped 21% fewer surfaces and 6% fewer graph nodes per action while using 17% more calls and 26% more output tokens, though it ran 11% faster per action.

## 2026-08-01T01:01:32.582Z — 4 collected (gpt-5.6-sol)

In single passes, CDP saw 5.4× more controls per action than AX but converted only 2.8% versus 11.0%, yielding just 35% more actuations per action. CDP mapped 2.3× more surfaces and 42% more nodes per action, but incurred 17× more scope ambiguities, 64% more calls, 69% more output tokens, and 47% more time per action. On Notion, CDP sustained 0.45 actuations per action versus 0.47 on Yarn while conversion rose 4.9× and scope ambiguities per action fell 89%.

## 2026-08-01T01:02:34.101Z — 5 collected (gpt-5.6-sol)

In single passes, removing vision from AX exposed 2.1× more controls per action but actuated 8% fewer, cutting conversion from 11.0% to 4.9%. No-vision AX produced 6% fewer nodes and 21% fewer surfaces per action while using 17% more calls and 26% more output tokens. Vision-only mapping yielded 82% fewer surfaces and 75% fewer nodes per action than full AX, despite only 25% fewer calls, virtually identical tokens, and 15% less time per action.

## 2026-08-01T01:09:41.362Z — 4 collected (gpt-5.6-sol)

In one pass each, CDP was not leaner than AX, using 1.6× more calls, 1.7× more output tokens, and 1.5× more time per action. CDP saw 5.4× more controls and actuated 35% more per action, but converted only 2.8% versus AX’s 11.0% and incurred 17× more scope ambiguities per action. On Notion versus the smaller CDP target, actuation density held within 3% while calls and tokens per action fell 34% and 39%, and scope ambiguities fell 89%.

## 2026-08-01T01:10:15.597Z — 4 collected (gpt-5.6-sol)

In one pass per arm, removing vision made AX see 2.6× more controls but actuate 8% fewer per action, cutting conversion from 11.0% to 4.9%. No-vision used 17% more calls and 26% more output tokens per action, despite taking 11% less time per action. Surface coverage was nearly unchanged at 0.97×, while no-vision produced 15% more graph nodes but 16% fewer edges.

## 2026-08-01T01:41:04.826Z — 4 collected (gpt-5.6-sol)

In single passes, CDP exposed 4.7× more controls and 2.0× more surfaces than AX, but achieved only 0.25× the seen-to-actuated conversion and had 15× more scope ambiguities. CDP’s actuations per action were 1.35× higher, yet it used 1.64× more calls, 1.69× more output tokens, and 1.47× more time per action. CDP produced 1.26× more nodes but 0.95× as many edges, yielding 0.75× AX’s edges per node. In the target-confounded Notion pass, CDP sustained 0.97× Yarn’s actuations per action with 0.66× the calls, 0.61× the tokens, and 0.11× the ambiguities per action.

## 2026-08-01T01:41:28.082Z — 4 collected (gpt-5.6-sol)

In one AX pass per arm, removing vision exposed 2.56× more controls but actuated only 1.13× more, cutting seen-to-actuated conversion to 0.44×. No-vision used 1.17× more calls and 1.26× more output tokens per action, while taking 0.89× the time per action. It produced 1.15× more graph nodes but 0.84× as many edges, reducing edge density to 0.73×, with essentially unchanged surface coverage and scope ambiguity.

## 2026-08-01T01:41:45.740Z — 4 collected (gpt-5.6-sol)

In one pass per backend, CDP needed 0.89× as many actions but 1.47× the time, 1.64× the calls, and 1.69× the output tokens per action as AX. CDP saw 4.75× more controls and 2.03× more surfaces but actuated only 1.20× more controls, cutting seen-to-actuated conversion to 0.25× AX’s. Its map had 1.26× the nodes but 0.95× the edges, yielding 0.75× AX’s edge density, while scope ambiguities rose 15×.
