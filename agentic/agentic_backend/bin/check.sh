#!/usr/bin/env bash
set -euo pipefail
exec Rscript --vanilla "$2" "$1"
