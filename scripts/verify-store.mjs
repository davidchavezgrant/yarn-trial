// Row-level integrity: a row may only claim a node count that came from ITS OWN run artifact.
// Counter-level checks ("22 collected") are what let 10 rows wear another pass's map all day.
import fs from "node:fs";
const date = "2026-08-03";
const mp = `out/bench/live/${date}/manifest.json`;
if (!fs.existsSync(mp)) { console.log("NO MANIFEST at " + mp); process.exit(0); }
const m = JSON.parse(fs.readFileSync(mp, "utf8"));
let bad = 0;
console.log(`${m.entries.length} rows in ${mp}\n`);
for (const e of m.entries) {
  const g = e.metrics?.graphNodes;
  const dirs = [`out/bench/live/${e.jobId}`, `out/bench/archive/${e.jobId}`];
  const dir = dirs.find((d) => fs.existsSync(`${d}/appmap.json`));
  let own = null;
  if (dir) { try { own = (JSON.parse(fs.readFileSync(`${dir}/appmap.json`, "utf8")).nodes ?? []).length; } catch {} }
  const problems = [];
  if (e.state === "stopped") problems.push("CANCELLED-but-present");
  if (e.collected && g !== undefined && own === null) problems.push(`claims ${g} nodes with NO own artifact`);
  if (e.collected && g !== undefined && own !== null && g !== own) problems.push(`claims ${g} but its artifact has ${own}`);
  if (e.collected && g === undefined && e.state === "done") problems.push("done+collected but no node count");
  if (problems.length) bad++;
  console.log(`${String(e.state).padEnd(8)} ${(e.collected?"col":"pend").padEnd(4)} own=${String(own ?? "-").padEnd(5)} claim=${String(g ?? "-").padEnd(5)} ${e.armId.padEnd(30)} ${problems.length?"<< "+problems.join("; "):""}`);
}
console.log(`\n${bad} row(s) with integrity problems`);
