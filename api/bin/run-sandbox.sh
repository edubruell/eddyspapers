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
# eval/library/file-writes), and `Rscript --vanilla` disables Rprofile/Renviron/
# site-library. Resource exhaustion is bounded by the systemd unit's cgroup caps
# (MemoryMax/TasksMax/CPUQuota on agentic-api.service), which the R children
# inherit, plus this timeout(1).
#
# The result comes back on fd 3 (a pipe from the Node parent), so R must run as
# the SAME uid as the backend — a uid drop would break the fd-3 reopen. A full
# OS-isolation slice (separate uid, read-only fs, network isolation) is a tracked
# follow-up: it needs the result channel moved off the inherited fd (to a file)
# so a real `systemd-run --service` slice or bwrap/nsjail can be used, and the
# query embedding moved into Node (Ollama is unreachable from an isolated netns).
exec timeout "$TIMEOUT_SECS" Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB"
