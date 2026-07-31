/**
 * Entry point only — the path is load-bearing. `npm run agent`, ./run, the fleet runner
 * (src/fleet/runner/serve.ts) and the UI shell (src/ui/ui-core.ts) all spawn
 * `tsx src/core/agent.ts`, so this file must stay where it is and keep starting a run when
 * executed. The implementation lives in src/core/agent/: run.ts owns the loop; cli.ts,
 * prompt.ts, grounding.ts, recording.ts, video.ts, step.ts and done.ts hold its phases.
 */
import { main } from "./agent/run.js";

main().catch((err) => {
	console.error("agent failed:", err);
	process.exit(1);
});
