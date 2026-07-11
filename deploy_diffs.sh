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
#   5. POST /admin/reload so the Hono service reopens the swapped snapshot
#
# Emergency escape hatch: set EDDY_STOP_SERVICE=1 to stop the service around the apply (only
# needed if a future change makes the service hold articles.duckdb again).
#
# Overridable via environment variables:
#   EDDY_HOST, EDDY_ROOT_USER, EDDY_APP_USER,
#   EDDY_LOCAL_DIFF_DIR, EDDY_REMOTE_DIFF_DIR, EDDY_SERVICE,
#   EDDY_DB_DIR, EDDY_RELOAD_URL, EDDY_ADMIN_KEY, EDDY_STOP_SERVICE
#
# Usage: EDDY_ADMIN_KEY=esk_… ./deploy_diffs.sh

set -euo pipefail

HOST="${EDDY_HOST:-econpapers.eduard-bruell.de}"
ROOT_USER="${EDDY_ROOT_USER:-root}"
APP_USER="${EDDY_APP_USER:-eddyspapers}"
LOCAL_DIFF_DIR="${EDDY_LOCAL_DIFF_DIR:-$HOME/eddyspapers/pqt_diff}"
REMOTE_DIFF_DIR="${EDDY_REMOTE_DIFF_DIR:-/srv/eddyspapers/data/pqt_diff}"
SERVICE="${EDDY_SERVICE:-eddyspapers-api}"
DB_DIR="${EDDY_DB_DIR:-/srv/eddyspapers/data/db}"
RELOAD_URL="${EDDY_RELOAD_URL:-http://127.0.0.1:8001/admin/reload}"
ADMIN_KEY="${EDDY_ADMIN_KEY:-}"
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
ssh "${APP_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
cd "${DB_DIR}"
cp -f articles.duckdb articles_agentic.duckdb.new
mv -f articles_agentic.duckdb.new articles_agentic.duckdb
rm -f articles_agentic.duckdb.wal
EOF

if [[ "${STOP_SERVICE}" == "1" ]]; then
  say "Restarting ${SERVICE} (root)"
  ssh "${ROOT_USER}@${HOST}" "systemctl start ${SERVICE}"
  api_stopped=0
fi

say "5/5 Reloading the corpus snapshot in ${SERVICE}"
if [[ -z "$ADMIN_KEY" ]]; then
  echo "WARNING: EDDY_ADMIN_KEY unset — skipping POST ${RELOAD_URL}." >&2
  echo "         The service will keep serving the OLD snapshot until it restarts or is reloaded." >&2
else
  ssh "${ROOT_USER}@${HOST}" \
    "curl -fsS -X POST -H 'Authorization: Bearer ${ADMIN_KEY}' '${RELOAD_URL}'" \
    && echo
fi

say "Verifying ${SERVICE} is active"
ssh "${ROOT_USER}@${HOST}" "systemctl is-active ${SERVICE}"

say "Deploy complete."
