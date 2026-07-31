import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Point the writable data root at a throwaway directory for the lifetime of this test
 * process. Import this FIRST, before anything that pulls in src/ — `OUT` in
 * `src/core/harness/run.ts` snapshots `outDir()` at import time, so the redirect only
 * takes if it runs before that module does.
 *
 * Exists because the suite was writing through `dataRoot()` into the real checkout:
 * fixture job records accumulating in `out/jobs/` (2,600+ within a day of the serve
 * tests landing, several per `npm test`) and probe screenshots dropped into `out/`.
 * Any test file that reaches a dataRoot-derived path — the job registry, observe()
 * screenshots — imports this; a new test file that does either should too.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-test-data-"));
fs.mkdirSync(path.join(root, "out"), { recursive: true });
process.env.YARN_RUNNER_DATA = root;
process.on("exit", () => {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {}
});
