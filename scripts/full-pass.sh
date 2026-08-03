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
# process, so closing the terminal, dropping the ssh connection or ending an agent session takes
# the pass with it — mid-dispatch, with runs on the fleet and nothing left watching to collect
# them. This adds the four things that make walking away safe:
#
# The one thing it CANNOT fix is that the driver runs on this machine. Sleep pauses the pass and
# it resumes on wake; a shutdown ends it and the Macs drain what is queued. See the caffeinate
# block near the launch, and the closing note the script prints.
#
#   1. DETACHED. nohup plus a subshell that exits, so no SIGHUP reaches it and it is reparented
#      to pid 1. The pass keeps going when the terminal, the ssh session or the agent goes away.
#      (NOT setsid — see the launch line; it does not exist on macOS.)
#   2. LOGGED. Everything to out/bench/full-pass-<date>.log, outside the live store so
#      `runs purge` cannot take the record of what happened with it.
#   3. LOCKED. One pass at a time. A second launch would double-dispatch every arm — the
#      manifest's top-up semantics protect against a re-run AFTER a pass, not against two
#      passes racing the same arm counts.
#   4. AWAKE. An idle-sleep assertion held for exactly the driver's lifetime, because a napping
#      laptop is the likeliest way an unattended pass quietly stops making progress.
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

# NO SPEND CEILING BY DEFAULT — David's call, 2026-08-03. The pass is the point; a ceiling that
# trips at 3am stops it partway and leaves stages unmeasured, which costs more than it saves
# (the 2026-08-01 pass ran ~$302 for 198 runs, so a full 253-run pass is a ~$400 expectation).
# The autopilot only enforces one when told, so this passes nothing and the run is unbounded.
#
# Still available for a pass you DO want bounded: FULL_PASS_MAX_USD=400 ./scripts/full-pass.sh --go
MAX_USD="${FULL_PASS_MAX_USD:-}"


# Pinned at launch and passed explicitly, so a pass that crosses UTC midnight keeps writing to the
# manifest it started, and a relaunch resumes that pass instead of forking a fresh one.
DATE="${FULL_PASS_DATE:-$(date -u +%Y-%m-%d)}"

# Built once, used by both the preview and the launch, so the two can never disagree about what
# the pass is bounded by.
AUTOPILOT_ARGS=(--phases "$PHASES" --date "$DATE")
[[ -n "$MAX_USD" ]] && AUTOPILOT_ARGS+=(--max-usd "$MAX_USD")

LOG="$REPO/out/bench/full-pass-$DATE.log"
LOCK="$REPO/out/bench/full-pass.lock"
mkdir -p "$REPO/out/bench"

if [[ "${1:-}" != "--go" ]]; then
	echo "PLAN ONLY — nothing will be dispatched. Add --go to launch."
	echo
	# The preview exits 2 BY DESIGN — EXIT_NEEDS_GO, "here is the plan, nothing fired" — which
	# `set -e` read as a failure, so this branch died before printing the launch line and handed
	# back exit 2. Only 0 and 2 are acceptable; exit 1 is a real refusal (a hinted task prompt, an
	# adopted archive manifest) and must not be dressed up as a plan.
	set +e
	./run bench autopilot "${AUTOPILOT_ARGS[@]}"
	PREVIEW=$?
	set -e
	if [[ "$PREVIEW" -ne 0 && "$PREVIEW" -ne 2 ]]; then
		echo
		echo "the autopilot REFUSED this plan (exit $PREVIEW) — fix what it named above before launching." >&2
		exit "$PREVIEW"
	fi
	echo
	echo "launch:  ./scripts/full-pass.sh --go"
	echo "  stages come from the matrix's own dependency graph; ${MAX_USD:+spend ceiling \$$MAX_USD; }${MAX_USD:-no spend ceiling; }log -> ${LOG#$REPO/}"
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
( nohup ./run bench autopilot "${AUTOPILOT_ARGS[@]}" --go >>"$LOG" 2>&1 & echo $! >"$LOCK" )
PID="$(cat "$LOCK")"

#
# KEEP THE MACHINE AWAKE FOR AS LONG AS THE PASS LASTS.
#
# The driver runs HERE, not on the fleet, and that is the honest limit of "fire and forget": it
# outlives the terminal, the ssh session and the agent, but not this computer. Idle sleep is the
# likely way a walk-away pass stops — the laptop naps, the driver freezes with it, and hours of
# fleet time go unclaimed.
#
# `-i` prevents idle sleep, `-s` prevents system sleep while on AC power, and `-w` ties the
# assertion to the driver's own lifetime: when the pass ends or is killed, caffeinate exits with
# it. That ordering matters — holding the assertion by wrapping the command instead would make
# `kill $PID` kill the guard and orphan the pass.
#
# WHAT IT CANNOT DO: a closed lid on battery still sleeps, and a shutdown or reboot ends the
# driver. Neither loses work — the Macs keep draining what is already queued, and re-running this
# script resumes from the manifest.
if command -v caffeinate >/dev/null 2>&1; then
	nohup caffeinate -isw "$PID" >/dev/null 2>&1 &
	AWAKE="sleep prevented while it runs (caffeinate)"
else
	AWAKE="WARNING: no caffeinate — this machine may sleep and pause the pass"
fi

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

running as pid $PID, pass date $DATE — $AWAKE
  log:     tail -f ${LOG#$REPO/}
  board:   ./run dash            (pure reader; safe to open and close at will)
  status:  ./run bench autopilot --phases $PHASES --date $DATE      (plan mode = progress report)
  collect: ./run bench collect --date $DATE                        (idempotent, any time)
  stop:    kill $PID    — safe. It holds no leash on runs: the fleet keeps draining and
           re-running this script resumes from the manifest.

Safe to close this terminal, end this session, or drop the ssh connection — none of those reach
the pass. Collecting and judging happen at the end, and again whenever you run collect.

The limit worth knowing: the DRIVER RUNS ON THIS MACHINE. If it sleeps the pass pauses and
resumes on wake (the stall detector counts polls, not minutes, so nothing trips); if it shuts
down the driver dies and the Macs finish what is already queued. Either way no work is lost —
re-run this script and it picks up from the manifest.
EOF
