#!/bin/bash
set -euo pipefail

# These directories may not be supplied by the Cloudflare microVM runtime.
mkdir -p /dev/shm /var/run/postgresql /var/log/postgresql
chmod 1777 /dev/shm
chown postgres:postgres /var/run/postgresql /var/log/postgresql
chmod 2775 /var/run/postgresql
pg_conftool 15 main set dynamic_shared_memory_type mmap

# The vendor image ships an initialized cluster. Synchronize its role password
# with this eval application's credentials, without changing the independent database.
service postgresql start
if [[ -z "${BOLD_SERVICES_DB_PASSWORD:-}" ]]; then
    echo 'BOLD_SERVICES_DB_PASSWORD is required.' >&2
    exit 1
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 --no-psqlrc <<'SQL'
\getenv eval_password BOLD_SERVICES_DB_PASSWORD
ALTER ROLE postgres WITH PASSWORD :'eval_password';
SQL
export BOLD_SERVICES_DB_TYPE=postgresql
export BOLD_SERVICES_DB_HOST=localhost
export BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB=postgres
export BOLD_SERVICES_DB_USER=postgres
export BOLD_SERVICES_REVERSE_PROXY=true
exec "$@"
