#!/usr/bin/env bash
#
# Upload the newest parquet diffs and have the server ingest them (phase-5 / post-Plumber).
#
# Flow:
#   1. rsync local pqt_diff/ -> server (root)
#   2. fix permissions (root) — NO service stop: after Plumber's retirement nothing holds
#      articles.duckdb read-write except this apply step, and the Hono service reads the
#      separate articles_agentic.duckdb snapshot, so diffs apply live.
#   3. apply the newest diff into articles.duckdb (eddyspapers user, via server_apply_diff.R,
#      which disconnects cleanly so the file is checkpointed with no outstanding WAL)
#   4. refresh the read-only Hono snapshot: cp articles.duckdb -> articles_agentic.duckdb.new,
#      then atomic mv into place (eddyspapers user)
#   5. restart the Hono service so it reopens the swapped snapshot as a single instance
#
# Why restart, not POST /admin/reload: the corpus DB + HNSW index is ~13G resident and the
# box has 23G RAM with no swap. A hot reload transiently holds two instances (~26G) which
# evicts the DB from page cache and wedges every corpus query. A restart guarantees one
# instance. Trade-off: a few seconds of downtime + a cold index warm-up on the first search.
#
# Emergency escape hatch: set EDDY_STOP_SERVICE=1 to stop the service around the apply (only
# needed if a future change makes the service hold articles.duckdb again).
#
# Overridable via environment variables:
#   EDDY_HOST, EDDY_ROOT_USER, EDDY_APP_USER,
#   EDDY_LOCAL_DIFF_DIR, EDDY_REMOTE_DIFF_DIR, EDDY_SERVICE,
#   EDDY_DB_DIR, EDDY_STOP_SERVICE
#
# Usage: ./deploy_diffs.sh

set -euo pipefail

HOST="${EDDY_HOST:-econpapers.eduard-bruell.de}"
ROOT_USER="${EDDY_ROOT_USER:-root}"
APP_USER="${EDDY_APP_USER:-eddyspapers}"
LOCAL_DIFF_DIR="${EDDY_LOCAL_DIFF_DIR:-$HOME/eddyspapers/pqt_diff}"
REMOTE_DIFF_DIR="${EDDY_REMOTE_DIFF_DIR:-/srv/eddyspapers/data/pqt_diff}"
SERVICE="${EDDY_SERVICE:-eddyspapers-api}"
DB_DIR="${EDDY_DB_DIR:-/srv/eddyspapers/data/db}"
STOP_SERVICE="${EDDY_STOP_SERVICE:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY_SCRIPT="$SCRIPT_DIR/server_apply_diff.R"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ ! -f "$APPLY_SCRIPT" ]]; then
  echo "ERROR: server_apply_diff.R not found next to this script ($APPLY_SCRIPT)" >&2
  exit 1
fi
if [[ ! -d "$LOCAL_DIFF_DIR" ]]; then
  echo "ERROR: local diff folder not found: $LOCAL_DIFF_DIR" >&2
  exit 1
fi

newest_local="$(ls -1 "$LOCAL_DIFF_DIR"/articles_diff_*.parquet 2>/dev/null | sort | tail -1 || true)"
if [[ -n "$newest_local" ]]; then
  say "Newest local diff: $(basename "$newest_local")"
fi

# Emergency: if the service is stopped for the apply, make sure it comes back on exit.
api_stopped=0
restart_api() {
  if [[ "$api_stopped" -eq 1 ]]; then
    say "Cleanup: starting ${SERVICE} (it was stopped for the apply)"
    ssh "${ROOT_USER}@${HOST}" "systemctl start ${SERVICE}" || true
  fi
}
trap restart_api EXIT

say "1/5 Uploading parquet diffs to ${HOST}"
rsync -av --no-perms --no-owner --no-group \
  "${LOCAL_DIFF_DIR}/" \
  "${ROOT_USER}@${HOST}:${REMOTE_DIFF_DIR}/"

say "2/5 Fixing permissions (root)${STOP_SERVICE:+; STOP_SERVICE=${STOP_SERVICE}}"
ssh "${ROOT_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
chmod 755 ${REMOTE_DIFF_DIR}
chmod 644 ${REMOTE_DIFF_DIR}/*.parquet
if [[ "${STOP_SERVICE}" == "1" ]]; then systemctl stop ${SERVICE}; fi
EOF
[[ "${STOP_SERVICE}" == "1" ]] && api_stopped=1

say "3/5 Applying newest diff on server (as ${APP_USER})"
ssh "${APP_USER}@${HOST}" 'Rscript -' < "$APPLY_SCRIPT"

say "4/5 Refreshing the Hono snapshot (atomic swap, as ${APP_USER})"
# The mv replaces the inode while the running service still holds the OLD snapshot open
# read-only; POSIX unlink-on-open keeps that handle valid until step 5's /admin/reload swaps
# it. A read-only DuckDB open creates no WAL, so the rm -f is a defensive no-op (W3, review).
ssh "${APP_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
cd "${DB_DIR}"
cp -f articles.duckdb articles_agentic.duckdb.new
mv -f articles_agentic.duckdb.new articles_agentic.duckdb
rm -f articles_agentic.duckdb.wal
EOF

say "5/5 Restarting ${SERVICE} to load the swapped snapshot (root)"
ssh "${ROOT_USER}@${HOST}" "systemctl restart ${SERVICE}"
api_stopped=0

say "Verifying ${SERVICE} is active"
ssh "${ROOT_USER}@${HOST}" "systemctl is-active ${SERVICE}"

say "Deploy complete."
