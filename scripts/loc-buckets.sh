#!/usr/bin/env bash
# What would port to a production build, counted rather than estimated.
#
# Every module in src/ (plus electron/) lands in exactly one bucket. The buckets are a
# judgement — docs/research/2026-08-03-what-ports-to-production.md carries the reasoning for
# each one — but the LINE COUNTS are not, and that is the point of this script: the write-up
# quotes numbers this produces, so re-running it after any refactor says whether the write-up
# has expired. Same rule as the benchmark (architecture.md §3): figures come from a tool,
# never from a hand-copy.
#
#   ships     the engine — moves to production largely intact
#   redesign  the design survives, the implementation is rewritten against Yarn's infra
#   internal  keep as regression tooling; not shipped product code
#   scaffold  existed to run the trial; production has no use for it
#
# Aggregation is awk, not bash arrays: macOS ships bash 3.2, which has no associative arrays,
# and this needs to run on the colo Macs too.
#
# Usage: scripts/loc-buckets.sh [--files]   (--files also lists every file with its bucket)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Anything tracked, compiled, and ours. Test files are counted separately at the bottom.
sources() { git ls-files 'src/*' 'electron/*' | grep -E '\.(ts|tsx|mts)$'; }

# First match wins, so the scaffold exceptions are named before the broad `ships` patterns
# that would otherwise claim them.
bucket() {
	case $1 in
		src/core/overlay.ts)          echo scaffold ;;  # "being driven" banner; exists for ax pointer seizure
		src/backends/ax.ts)           echo scaffold ;;  # the cua path, dominated by cdp
		src/ui/*|electron/*)          echo scaffold ;;  # the trial's own shell; Yarn's app is the UI
		src/cursor/*)                 echo scaffold ;;  # Yarn already renders cursors in post
		src/probes/*)                 echo scaffold ;;  # one-off research probes, not tooling
		src/remote/chrome-policy.ts)  echo scaffold ;;
		src/remote/runner/spawn.ts|src/remote/runner/ctl.ts|src/remote/runner/uninstall.ts)
		                              echo scaffold ;;  # LaunchAgent lifecycle on a colo Mac
		src/bench/dash.ts|src/bench/graphs.ts|src/bench/snapshot.ts|src/bench/rebalance.ts)
		                              echo scaffold ;;  # the published board, a research artifact

		src/bench/*)                  echo internal ;;  # the eval harness, worth keeping

		src/remote/liveview*)         echo redesign ;;
		src/remote/runner/lease.ts|src/remote/runner/jobs.ts|src/remote/runner/profiles.ts|src/remote/runner/browser-reset.ts|src/remote/runner/serve.ts)
		                              echo redesign ;;  # lease, queue, per-operator isolation
		src/remote/control/session-wipe.ts|src/remote/control/browser-wipe.ts)
		                              echo redesign ;;
		*-cli.ts|src/core/*/cli.ts)   echo redesign ;;  # argv parsing becomes an API surface

		src/remote/*)                 echo scaffold ;;  # SSH, provisioning, enrollment, dispatch

		src/core/*|src/backends/*|src/*.ts)
		                              echo ships ;;
		*)                            echo unclassified ;;
	esac
}

emit() { while read -r f; do printf '%s\t%s\t%s\n' "$(wc -l <"$f" | tr -d ' ')" "$(bucket "$f")" "$f"; done < <(sources); }

rows=$(emit)

[[ ${1:-} == --files ]] && printf '%s\n' "$rows" | sort -rn

# Stamp the tree. A quoted figure with no commit behind it is a figure nobody can check, and
# these numbers move whenever src/ does — this write-up's first draft was measured across a
# rebase and drifted by 4 lines mid-analysis.
printf '\n%s @ %s%s\n' "$(git rev-parse --short HEAD)" "$(git rev-parse --abbrev-ref HEAD)" \
	"$(git diff --quiet -- src electron || printf ' (src dirty — figures are of the working tree, not the commit)')"

printf '%s\n' "$rows" | awk -F'\t' '
	{ lines[$2] += $1; files[$2]++; grand += $1; n++ }
	END {
		printf "\n%-13s %8s %7s %6s\n", "bucket", "lines", "files", "pct"
		printf "%-13s %8s %7s %6s\n", "-------------", "--------", "-------", "------"
		split("ships redesign internal scaffold unclassified", order, " ")
		for (i = 1; i <= 5; i++) {
			b = order[i]
			if (lines[b] > 0)
				printf "%-13s %8d %7d %5d%%\n", b, lines[b], files[b], lines[b] * 100 / grand
		}
		printf "%-13s %8d %7d\n", "TOTAL", grand, n
	}'

# Tests, attributed to a bucket by the module each one exercises. Approximate by construction:
# a test named after nothing in particular falls to "unmapped" rather than being guessed at.
git ls-files 'tests/*' | grep -E '\.(ts|tsx|mts)$' | while read -r f; do
	printf '%s\t%s\n' "$(wc -l <"$f" | tr -d ' ')" "$(basename "$f")"
done | awk -F'\t' '
	$2 ~ /^(agent|harness|verification|observation|explore|appmap|journal|teardown|cleanup|procedure|replay|recipe|judge|target|axdom|cdp|trajectory|frontier|gates|boundary|home|runner\.|paths|apps|ready|types)/ { engine += $1; next }
	$2 ~ /^(bench|dash|matrix|orchestrate|collect|cost|manifest|snapshot|graphs|report|rebalance|autopilot)/ { bench += $1; next }
	$2 ~ /^(provision|dispatch|install|ssh|enroll|hosts|team|manage|signin|liveview|lease|jobs|profiles|serve|remote|session-wipe|browser|uninstall|fleet|spawn|chrome|ui-|overlay|cursor|track|humanize|probe|window)/ { fleet += $1; next }
	{ other += $1 }
	END {
		printf "\nTests by subject (approximate)\n"
		printf "  engine            %6d\n  fleet / shell / ui  %4d\n  benchmark         %6d\n  unmapped          %6d\n  %-16s  %6d\n", \
			engine, fleet, bench, other, "TOTAL", engine + fleet + bench + other
	}'
