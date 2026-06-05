#!/usr/bin/env bash
#
# Upload the newest parquet diffs and have the server ingest them.
#
# Flow:
#   1. rsync local pqt_diff/ -> server (root)
#   2. stop the API + fix permissions (root)
#   3. apply the newest diff into the DuckDB (eddyspapers user, via server_apply_diff.R)
#   4. start the API again (root)
#
# The API is always brought back up on exit, even if ingestion fails.
#
# Overridable via environment variables:
#   EDDY_HOST, EDDY_ROOT_USER, EDDY_APP_USER,
#   EDDY_LOCAL_DIFF_DIR, EDDY_REMOTE_DIFF_DIR, EDDY_SERVICE
#
# Usage: ./deploy_diffs.sh

set -euo pipefail

HOST="${EDDY_HOST:-econpapers.eduard-bruell.de}"
ROOT_USER="${EDDY_ROOT_USER:-root}"
APP_USER="${EDDY_APP_USER:-eddyspapers}"
LOCAL_DIFF_DIR="${EDDY_LOCAL_DIFF_DIR:-$HOME/eddyspapers/pqt_diff}"
REMOTE_DIFF_DIR="${EDDY_REMOTE_DIFF_DIR:-/srv/eddyspapers/data/pqt_diff}"
SERVICE="${EDDY_SERVICE:-eddyspapers-api}"

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

# Show which stamp pair is newest locally, for confirmation.
newest_local="$(ls -1 "$LOCAL_DIFF_DIR"/articles_diff_*.parquet 2>/dev/null | sort | tail -1 || true)"
if [[ -n "$newest_local" ]]; then
  say "Newest local diff: $(basename "$newest_local")"
fi

# Always bring the API back up on exit unless we already started it cleanly.
api_started=0
restart_api() {
  if [[ "$api_started" -eq 0 ]]; then
    say "Cleanup: starting ${SERVICE} (it may have been left stopped)"
    ssh "${ROOT_USER}@${HOST}" "systemctl start ${SERVICE}" || true
  fi
}
trap restart_api EXIT

say "1/5 Uploading parquet diffs to ${HOST}"
rsync -av --no-perms --no-owner --no-group \
  "${LOCAL_DIFF_DIR}/" \
  "${ROOT_USER}@${HOST}:${REMOTE_DIFF_DIR}/"

say "2/5 Stopping ${SERVICE} and fixing permissions (root)"
ssh "${ROOT_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
systemctl stop ${SERVICE}
chmod 755 ${REMOTE_DIFF_DIR}
chmod 644 ${REMOTE_DIFF_DIR}/*.parquet
EOF

say "3/5 Applying newest diff on server (as ${APP_USER})"
ssh "${APP_USER}@${HOST}" 'Rscript -' < "$APPLY_SCRIPT"

say "4/5 Starting ${SERVICE} (root)"
ssh "${ROOT_USER}@${HOST}" "systemctl start ${SERVICE}"
api_started=1

say "5/5 Verifying ${SERVICE} is active"
ssh "${ROOT_USER}@${HOST}" "systemctl is-active ${SERVICE}"

say "Deploy complete."
