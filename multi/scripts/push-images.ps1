# Pull the private Bold BI dev images from Docker Hub and push them to Cloudflare's registry.
# Prereqs: Docker Desktop running; `docker login` done; `npx wrangler login` done.
param(
  [string]$Tag = "17.1.50_11052026_080254_dev"
)
$ErrorActionPreference = "Stop"
$images = @(
  "dev-bold-identity", "dev-bold-identity-api", "dev-bold-ums", "dev-boldbi-server",
  "dev-boldbi-server-api", "dev-boldbi-server-jobs", "dev-boldbi-designer",
  "dev-bold-etl", "dev-bold-ai", "dev-boldbi-mcp-server"
)
foreach ($name in $images) {
  Write-Host "=== $name`:$Tag ===" -ForegroundColor Cyan
  docker pull "docker.io/syncfusion/${name}:$Tag"
  if ($LASTEXITCODE) { throw "pull failed: $name" }
  docker tag "docker.io/syncfusion/${name}:$Tag" "${name}:$Tag"
  npx wrangler containers push "${name}:$Tag"
  if ($LASTEXITCODE) { throw "push failed: $name" }
}
Write-Host "Done. Check with: npx wrangler containers images list" -ForegroundColor Green
