#!/bin/bash
set -euo pipefail

# These directories may not be supplied by the Cloudflare microVM runtime.
mkdir -p /dev/shm
chmod 1777 /dev/shm

# The database is external (BOLD_SERVICES_DB_* are supplied by the Worker).
if [[ -z "${BOLD_SERVICES_DB_HOST:-}" || -z "${BOLD_SERVICES_DB_PASSWORD:-}" ]]; then
    echo 'BOLD_SERVICES_DB_HOST and BOLD_SERVICES_DB_PASSWORD are required.' >&2
    exit 1
fi
export BOLD_SERVICES_REVERSE_PROXY=true
exec "$@"
