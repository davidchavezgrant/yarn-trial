#!/usr/bin/env bash
#
# THE master run script. One command starts a complete benchmark pass and returns the terminal.
#
#   ./scripts/full-pass.sh            print the plan, dispatch nothing
#   ./scripts/full-pass.sh --go       launch it detached, print how to watch it, exit
#
# WHY A WRAPPER AND NOT JUST `bench autopilot`. The autopilot already orders the stages, gates
# each one on its declared prerequisites, retries what technical failures freed, and collects and
# judges at the end. What it cannot do is survive the terminal that started it: it is a foreground
# process, so closing the laptop, dropping the VPN or ending an agent session takes the pass with
# it — mid-dispatch, with runs on the fleet and nothing left watching to collect them. This adds
# exactly the three things that makes it walk-away safe:
#
#   1. DETACHED. setsid + nohup, so no SIGHUP reaches it and it is not in the caller's process
#      group. The pass keeps going when the terminal, the ssh session or the agent goes away.
#   2. LOGGED. Everything to out/bench/full-pass-<date>.log, outside the live store so
#      `runs purge` cannot take the record of what happened with it.
#   3. LOCKED. One pass at a time. A second launch would double-dispatch every arm — the
#      manifest's top-up semantics protect against a re-run AFTER a pass, not against two
#      passes racing the same arm counts.
#
# WHAT IT DOES NOT DO, deliberately: cursor compositing (`npm run humanize -- <stamp>`) stays
# manual, and so does anything that publishes. Collecting late is safe and idempotent — the
# autopilot's final stage collects and judges, and `./run bench collect` picks up stragglers
# whenever you get back to it.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

# Every stage the matrix declares, in the order it declares its own dependencies — "all" rather
# than a list, because the stage numbers have moved once already (eight phases became five stages
# plus diagnostics, and a hardcoded `1,2,3,6` outlived stage 6 by weeks, printed in the help the
# whole time and refused by the validator).
PHASES="${FULL_PASS_PHASES:-all}"

# A hard spend ceiling, checked before every dispatch wave. The 2026-08-01 pass cost ~$302 for 198
# runs; a full pass is 253 planned, so ~$400 is the expectation and this is roughly 1.5x that —
# enough headroom for retries, low enough to stop a runaway while nobody is watching. There is no
# default in the autopilot itself (it warns instead), which is correct for an attended run and
# wrong for this one.
MAX_USD="${FULL_PASS_MAX_USD:-600}"

# Pinned at launch and passed explicitly, so a pass that crosses UTC midnight keeps writing to the
# manifest it started, and a relaunch resumes that pass instead of forking a fresh one.
DATE="${FULL_PASS_DATE:-$(date -u +%Y-%m-%d)}"

LOG="$REPO/out/bench/full-pass-$DATE.log"
LOCK="$REPO/out/bench/full-pass.lock"
mkdir -p "$REPO/out/bench"

if [[ "${1:-}" != "--go" ]]; then
	echo "PLAN ONLY — nothing will be dispatched. Add --go to launch."
	echo
	./run bench autopilot --phases "$PHASES" --date "$DATE" --max-usd "$MAX_USD"
	echo
	echo "launch:  ./scripts/full-pass.sh --go"
	echo "  stages come from the matrix's own dependency graph; spend ceiling \$$MAX_USD; log -> ${LOG#$REPO/}"
	exit 0
fi

# --- the lock. A live PID in it means a pass is already running; a stale one is reclaimed. ---
if [[ -f "$LOCK" ]]; then
	OLD="$(cat "$LOCK" 2>/dev/null || true)"
	if [[ -n "$OLD" ]] && kill -0 "$OLD" 2>/dev/null; then
		echo "REFUSED: a pass is already running (pid $OLD)." >&2
		echo "  watch:  tail -f ${LOG#$REPO/}" >&2
		echo "  stop:   kill $OLD     (safe — it holds no leash on runs; the fleet keeps draining)" >&2
		exit 1
	fi
	echo "note: clearing a stale lock from pid ${OLD:-unknown} (no such process)"
fi

# --- preflight the two things that are cheap here and expensive after 40 minutes of explores ---
# The fleet: a pass that starts with every Mac unreachable produces nothing but dispatch errors.
# Not fatal — one sick Mac is normal and `auto` routes around it — but worth saying out loud.
if ! ./run hosts >/dev/null 2>&1; then
	echo "WARNING: ./run hosts failed — the fleet may be unreachable. Launching anyway; check the log." >&2
fi
# Uncommitted work: each phase rsyncs the checkout to the Macs, so whatever is in the tree right
# now is what runs. That is usually intended and occasionally a surprise.
if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
	echo "NOTE: the working tree has uncommitted changes, and each phase syncs this checkout to the fleet."
	echo "      The pass will run WITH those changes."
fi
# The autopilot's own preflight (hinted-prompt audit, judge-key liveness, archived-manifest guard)
# runs inside the detached process and will refuse there if something is wrong — read the log.

echo "launching the full pass, detached."
#
# DETACHMENT, PORTABLY. Two mechanisms, and both are needed:
#
#   nohup      makes it deaf to SIGHUP, which is what a closing terminal sends.
#   ( … & )    a subshell that exits immediately, so the child is reparented to pid 1 rather
#              than left as a child of this script. Verified: PPID becomes 1.
#
# NOT `setsid`, which is the textbook answer and does not exist on macOS. Written that way first,
# and it would have failed with "setsid: command not found" at the moment of launch — a
# fire-and-forget script that never fires, discovered only on getting back to a fleet that did
# nothing for a day.
( nohup ./run bench autopilot --phases "$PHASES" --date "$DATE" --max-usd "$MAX_USD" --go >>"$LOG" 2>&1 & echo $! >"$LOCK" )
PID="$(cat "$LOCK")"

# Give it a moment to fail fast — a refusal (bad key, hinted prompt, adopted archive manifest)
# happens in the first seconds, and finding out now beats finding out tomorrow.
sleep 8
if ! kill -0 "$PID" 2>/dev/null; then
	rm -f "$LOCK"
	echo
	echo "IT EXITED IMMEDIATELY — the autopilot refused. Last lines:" >&2
	tail -20 "$LOG" >&2
	exit 1
fi

cat <<EOF

running as pid $PID, pass date $DATE
  log:     tail -f ${LOG#$REPO/}
  board:   ./run dash            (pure reader; safe to open and close at will)
  status:  ./run bench autopilot --phases $PHASES --date $DATE      (plan mode = progress report)
  collect: ./run bench collect --date $DATE                        (idempotent, any time)
  stop:    kill $PID    — safe. It holds no leash on runs: the fleet keeps draining and
           re-running this script resumes from the manifest.

Safe to close this terminal and go offline. Nothing further is needed from you; collecting and
judging happen at the end of the pass, and again whenever you run collect.
EOF
