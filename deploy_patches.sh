#!/usr/bin/env bash
#
# Upload parquet patches (backfills / schema data) and have the server apply them.
# Mirrors deploy_diffs.sh but for the M8 patch mechanism
# (localwip/notes/data_enrichment/01_backfill_mechanism.md):
#
#   1. rsync local pqt_patch/ -> server (root)
#   2. fix permissions (root)
#   3. apply pending patches into articles.duckdb (eddyspapers user, via
#      server_apply_patch.R; already-applied patch_ids are skipped via patch_meta)
#   4. refresh the read-only Hono snapshot (atomic swap, eddyspapers user)
#   5. restart the Hono service so it reopens the swapped snapshot as a single instance
#
# Why restart, not POST /admin/reload: the corpus DB + HNSW index is ~13G resident and the
# box has 23G RAM with no swap. A hot reload transiently holds two instances (~26G) which
# evicts the DB from page cache and wedges every corpus query. A restart guarantees one
# instance. Trade-off: a few seconds of downtime + a cold index warm-up on the first search.
#
# Overridable via environment variables:
#   EDDY_HOST, EDDY_ROOT_USER, EDDY_APP_USER,
#   EDDY_LOCAL_PATCH_DIR, EDDY_REMOTE_PATCH_DIR, EDDY_SERVICE, EDDY_DB_DIR
#
# Usage: ./deploy_patches.sh

set -euo pipefail

HOST="${EDDY_HOST:-econpapers.eduard-bruell.de}"
ROOT_USER="${EDDY_ROOT_USER:-root}"
APP_USER="${EDDY_APP_USER:-eddyspapers}"
LOCAL_PATCH_DIR="${EDDY_LOCAL_PATCH_DIR:-$HOME/eddyspapers/pqt_patch}"
REMOTE_PATCH_DIR="${EDDY_REMOTE_PATCH_DIR:-/srv/eddyspapers/data/pqt_patch}"
SERVICE="${EDDY_SERVICE:-eddyspapers-api}"
DB_DIR="${EDDY_DB_DIR:-/srv/eddyspapers/data/db}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY_SCRIPT="$SCRIPT_DIR/server_apply_patch.R"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ ! -f "$APPLY_SCRIPT" ]]; then
  echo "ERROR: server_apply_patch.R not found next to this script ($APPLY_SCRIPT)" >&2
  exit 1
fi
if [[ ! -d "$LOCAL_PATCH_DIR" ]]; then
  echo "ERROR: local patch folder not found: $LOCAL_PATCH_DIR" >&2
  exit 1
fi
if ! ls "$LOCAL_PATCH_DIR"/*.manifest.json >/dev/null 2>&1; then
  echo "ERROR: no patch manifests in $LOCAL_PATCH_DIR" >&2
  exit 1
fi

say "1/5 Uploading patches to ${HOST}"
rsync -av --no-perms --no-owner --no-group \
  "${LOCAL_PATCH_DIR}/" \
  "${ROOT_USER}@${HOST}:${REMOTE_PATCH_DIR}/"

say "2/5 Fixing permissions (root)"
ssh "${ROOT_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
mkdir -p ${REMOTE_PATCH_DIR}
chmod 755 ${REMOTE_PATCH_DIR}
chmod 644 ${REMOTE_PATCH_DIR}/* 2>/dev/null || true
EOF

say "3/5 Applying pending patches on server (as ${APP_USER})"
ssh "${APP_USER}@${HOST}" 'Rscript -' < "$APPLY_SCRIPT"

say "4/5 Refreshing the Hono snapshot (atomic swap, as ${APP_USER})"
ssh "${APP_USER}@${HOST}" bash -s <<EOF
set -euo pipefail
cd "${DB_DIR}"
cp -f articles.duckdb articles_agentic.duckdb.new
mv -f articles_agentic.duckdb.new articles_agentic.duckdb
rm -f articles_agentic.duckdb.wal
EOF

say "5/5 Restarting ${SERVICE} to load the swapped snapshot (root)"
ssh "${ROOT_USER}@${HOST}" "systemctl restart ${SERVICE}"

say "Verifying ${SERVICE} is active"
ssh "${ROOT_USER}@${HOST}" "systemctl is-active ${SERVICE}"

say "Patch deploy complete."
