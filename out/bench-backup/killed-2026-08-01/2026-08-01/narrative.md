
## 2026-08-01T00:02:01.528Z — 3 collected (gpt-5.6-sol)

Only three of 76 planned runs have been collected, with one vision run still running, so every comparison is effectively n=1 per arm. On the comparable explore passes, CDP found much more UI than AX—1,985 versus 418 controls, 63 versus 31 surfaces, and 196 versus 156 graph nodes—but actuated only 55 versus 46 controls. That is a 2.8% actuation-to-seen rate for CDP versus 11% for AX. CDP also recorded 15 scope ambiguities versus one, while producing slightly fewer graph edges, 54 versus 57.

CDP’s broader discovery was not leaner in aggregate here: it took 36 versus 28 minutes, 333 versus 229 model calls, and 52,608 versus 35,004 output tokens—about 1.3× the time, 1.45× the calls, and 1.5× the tokens. It used 118 actions versus AX’s 133, but dismissed 1,933 controls versus 373. These single runs support “broader but noisier” discovery, not yet a backend choice.

The separate CDP exploration of Notion covered 1,238 controls, 119 surfaces, and 471 graph nodes, actuating 167 controls in 369 actions over 74 minutes, with 689 calls and 99,773 output tokens. Because it targets a different, much larger app, it is not a direct AX/CDP comparison. No grounded task runs, recipe replays, completed vision runs, pricing, or judge results are in yet, so the matrix cannot yet say what grounding or vision buys, whether replay is fleet-ready, or whether judges disagree with self-reports; none of the collected runs is marked successful.

## 2026-08-01T00:02:32.289Z — 3 collected (gpt-5.6-sol)

Only 3 of 76 planned runs are collected, with one vision run still running, so every comparison is effectively n=1. In the direct explore comparison, CDP discovered much more UI than AX: 1,985 versus 418 controls seen (4.7×), 63 versus 31 surfaces (2.0×), and 196 versus 156 graph nodes (1.3×). But it actuated only 55 versus 46 controls (1.2×) and recorded 15 versus 1 scope ambiguities. Its graph also had slightly fewer edges, 54 versus 57.

CDP was not leaner on the measured totals in this pair. It used 118 actions versus AX’s 133, but took 36 versus 28 minutes, made 333 versus 229 model calls, and emitted 52,608 versus 35,004 output tokens. It saw 16.8 controls per action versus AX’s 3.1, but most of that extra discovery was dismissed: 1,933 controls versus 373. The current evidence therefore shows broader CDP discovery accompanied by more ambiguity and compute, not yet whether that breadth is useful.

The separate Notion CDP exploration shows the scale of grounding a larger web app: 1,238 controls seen, 167 actuated, 119 surfaces, and 471 graph nodes over 74 minutes, 369 actions, 689 model calls, and 99,773 output tokens. There are no grounded task runs, recipe replays, completed vision results, priced runs, or judge decisions yet, so the matrix cannot yet say what grounding or vision buys, whether replay is fleet-ready, which backend should be built on, or whether judges disagree with self-reports.
