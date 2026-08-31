#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$1"
DB="$2"
RUN_R="$3"
TIMEOUT_SECS="${4:-150}"

# Run the (AST-allowlisted) R script with a hard wall-clock cap.
#
# Security model: the untrusted, model-written R is constrained at the
# application layer by check.R (the AST allow-list — no system/url/socket/
# eval/library/file-writes, and no blocked functions even in value position), and
# `Rscript --vanilla` disables Rprofile/Renviron/site-library. The Node parent also
# passes a scrubbed environment (see sandbox/env.ts): only PATH/HOME/locale/R-lib/
# Ollama vars reach the child, so service secrets are not present to be read even if
# Sys.getenv were reachable. Resource exhaustion is bounded by the systemd unit's
# cgroup caps (MemoryMax/TasksMax/CPUQuota on agentic-api.service), which the R
# children inherit, plus this timeout(1).
#
# The result comes back on fd 3 (a pipe from the Node parent), so R must run as
# the SAME uid as the backend — a uid drop would break the fd-3 reopen. A full
# OS-isolation slice (separate uid, read-only fs, network isolation) is a tracked
# follow-up: it needs the result channel moved off the inherited fd (to a file)
# so a real `systemd-run --service` slice or bwrap/nsjail can be used, and the
# query embedding moved into Node (Ollama is unreachable from an isolated netns).
# timeout(1) is GNU coreutils: present on the Linux server, absent on a stock macOS dev
# box (where its absence exits 127 and the run silently yields zero papers). Prefer it,
# accept Homebrew's gtimeout, and otherwise emulate the cap with a watchdog so the
# wall-clock bound holds everywhere rather than being quietly skipped.
if command -v timeout >/dev/null 2>&1; then
  exec timeout "$TIMEOUT_SECS" Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB"
elif command -v gtimeout >/dev/null 2>&1; then
  exec gtimeout "$TIMEOUT_SECS" Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB"
fi

Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB" &
child=$!
# The watchdog MUST NOT inherit stdout or fd 3 (the result pipe): a sleeping subshell
# holding the write end keeps the parent blocked on a pipe that never closes, so every
# run appears to last exactly $TIMEOUT_SECS even after R has already exited.
( sleep "$TIMEOUT_SECS"; kill -9 "$child" 2>/dev/null ) >/dev/null 2>&1 3>&- &
watchdog=$!
status=0
wait "$child" || status=$?
kill "$watchdog" 2>/dev/null || true
exit "$status"
