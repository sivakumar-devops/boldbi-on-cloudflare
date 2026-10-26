#!/bin/bash
# The vendor entrypoint writes local_service_url.json with Docker hostnames (http://id-api/api, ...).
# Cloudflare containers share no network, so write it first with the public URLs (the Worker routes
# them). The vendor script leaves the file alone when it already has the Mcp/ReportsAi/ReportsMcp nodes.
set -euo pipefail

base="${APP_BASE_URL%/}"
dir=/application/app_data/configuration
mkdir -p "$dir" && chmod 777 "$dir"

cat > "$dir/local_service_url.json" <<JSON
{
  "Idp": "$base",
  "IdpApi": "$base/api",
  "Ums": "$base/ums",
  "Bi": "$base/bi",
  "BiApi": "$base/bi/api",
  "BiJob": "$base/bi/jobs",
  "BiDesigner": "$base/bi/designer",
  "BiDesignerHelper": "$base/bi/designer/helper",
  "Etl": "$base",
  "EtlBlazor": "$base/framework/blazor.server.js",
  "Ai": "$base/aiservice",
  "Mcp": "$base/mcp",
  "Reports": "$base/reporting",
  "ReportsApi": "$base/reporting/api",
  "ReportsJob": "$base/reporting/jobs",
  "ReportsService": "$base/reporting/reportservice",
  "ReportsViewer": "$base/reporting/viewer",
  "ReportsAi": "$base/reportsai",
  "ReportsMcp": "$base/reportsmcp"
}
JSON
echo "[INFO] Wrote public service URLs to $dir/local_service_url.json"

exec bash entrypoint.sh
