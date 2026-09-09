#!/usr/bin/env bash
# Package the public skills for the /mcp download page. The zips are committed so the
# static frontend build stays self-contained; re-run this after editing a SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../frontends/classic/public/skills"
mkdir -p "$out"
for s in lit-search lit-check; do
  rm -f "$out/$s.zip"
  (cd "$here" && zip -q -r "$out/$s.zip" "$s" -x '.*')
  echo "$out/$s.zip"
done
