#!/bin/bash
set -euo pipefail

# In Cloudflare Containers microVM, write local_service_url.json with proper URLs
# before delegating to the vendor's entrypoint.
configuration_path="/application/app_data/configuration"
local_service_json_file="$configuration_path/local_service_url.json"

mkdir -p "$configuration_path"
chmod 777 "$configuration_path"

APP_BASE="${APP_BASE_URL:-http://localhost}"
# Strip trailing slash if present
APP_BASE="${APP_BASE%/}"

echo "[cloudflare-init] Initializing local_service_url.json with APP_BASE_URL=$APP_BASE"

cat <<EOF > "$local_service_json_file"
{
  "Idp": "${APP_BASE}",
  "IdpApi": "${APP_BASE}/api",
  "Ums": "${APP_BASE}/ums",
  "Bi": "${APP_BASE}/bi",
  "BiApi": "${APP_BASE}/bi/api",
  "BiJob": "${APP_BASE}/bi/jobs",
  "BiDesigner": "${APP_BASE}/bi/designer",
  "BiDesignerHelper": "${APP_BASE}/bi/designer/helper",
  "Etl": "${APP_BASE}/etlservice",
  "EtlBlazor": "${APP_BASE}/etlservice/_framework/blazor.server.js",
  "Ai": "${APP_BASE}/aiservice",
  "Mcp": "${APP_BASE}/mcp",
  "Reports": "${APP_BASE}/reporting",
  "ReportsApi": "${APP_BASE}/reporting/api",
  "ReportsJob": "${APP_BASE}/reporting/jobs",
  "ReportsService": "${APP_BASE}/reporting/reportservice",
  "ReportsViewer": "${APP_BASE}/reporting/viewer",
  "ReportsAi": "${APP_BASE}/reportsai",
  "ReportsMcp": "${APP_BASE}/reportsmcp"
}
EOF

chmod 666 "$local_service_json_file"

echo "[cloudflare-init] Launching vendor entrypoint..."
exec bash entrypoint.sh "$@"
