#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$1"
DB="$2"
RUN_R="$3"
TIMEOUT_SECS="${4:-90}"

if command -v systemd-run &>/dev/null && id eddysandbox &>/dev/null 2>&1; then
  exec timeout "$TIMEOUT_SECS" systemd-run \
    --scope --uid=eddysandbox \
    --property=MemoryMax=1G \
    --property=CPUQuota=200% \
    --property=TasksMax=32 \
    --property=PrivateNetwork=yes \
    --property=PrivateTmp=yes \
    --property=ProtectSystem=strict \
    --property=ProtectHome=yes \
    --property=ProtectKernelModules=yes \
    --property=ProtectKernelTunables=yes \
    --property=RestrictNamespaces=yes \
    --property=RestrictSUIDSGID=yes \
    --property=NoNewPrivileges=yes \
    --property="ReadOnlyPaths=$DB" \
    --property=ReadWritePaths= \
    Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB"
else
  exec Rscript --vanilla "$RUN_R" "$SCRIPT" "$DB"
fi
