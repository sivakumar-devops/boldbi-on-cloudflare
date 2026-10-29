# Bold BI Multi-Container on Cloudflare Workers

Runs Bold BI v17.1.30 as **10 separate microservice containers** orchestrated by a single Cloudflare Worker using Durable Objects and Cloudflare Containers (`@cloudflare/containers`). Shared application state is persisted in AWS S3 and an external PostgreSQL database.

## Architecture

| Service Key | Container Class | Public Path / Route | Upstream Port |
|---|---|---|---|
| `id-web` | `IdWebContainer` | `/`, `/accounts/*` (Identity web UI) | 80 |
| `id-api` | `IdApiContainer` | `/api/*` (Identity REST API) | 80 |
| `id-ums` | `IdUmsContainer` | `/ums/*` (User Management Server) | 80 |
| `bi-web` | `BiWebContainer` | `/bi/*` (Dashboard server UI) | 80 |
| `bi-api` | `BiApiContainer` | `/bi/api/*` (Dashboard API) | 80 |
| `bi-jobs` | `BiJobsContainer` | Background worker (data sync, schedules) | 80 |
| `bi-designer` | `BiDesignerContainer` | `/bi/designer/*` (Dashboard designer) | 80 |
| `bi-etl` | `BiEtlContainer` | `/etlservice/*` (ETL engine) | 80 |
| `bold-ai` | `BoldAiContainer` | `/aiservice/*` (AI engine) | 8080 |
| `bold-mcp` | `BoldMcpContainer` | `/mcp/*` (Model Context Protocol) | 80 |

- **Regional Placement:** All 10 containers are pinned to US East (`ENAM`) via `constraints.regions: ["ENAM"]`. Durable Objects use location hint `DO_LOCATION_HINT=enam`.
- **Inter-service routing:** Containers communicate internally through `@cloudflare/containers` `outboundByHost` interception handled by `forwardInternal()`. Traffic never leaves Cloudflare's network.
- **Edge Static Caching:** Optional Cloudflare Workers Caching for `/bi/cdn/*`, `/bi/designer/cultures/*`, and localization JS assets via a dedicated `StaticAssets` WorkerEntrypoint (`STATIC_CACHE=true`).

---

## 1. Prerequisites

1. Cloudflare account with **Workers Paid** and **Containers** enabled.
2. Node.js 22+ and npm on your local workstation.
3. AWS S3 bucket in `us-east-1` (or matching US East region) for persistent `app_data`.
4. PostgreSQL instance located in **US East** (e.g. Azure Database for PostgreSQL in East US / East US 2).
5. (Optional) Custom domain active in the same Cloudflare account (e.g. `synctester.com`).

---

## 2. Configuration (`wrangler.jsonc`)

Review `multi/wrangler.jsonc` before deployment:

1. Verify `account_id` matches your Cloudflare Account ID:
   ```jsonc
   "account_id": "<YOUR_CLOUDFLARE_ACCOUNT_ID>",
   "name": "ticket287457" // or your preferred worker name
   ```
2. Verify all 10 container definitions contain the regional constraint:
   ```jsonc
   "constraints": { "regions": ["ENAM"] }
   ```
3. Verify Workers Caching configuration is present:
   ```jsonc
   "cache": { "enabled": true },
   "exports": {
     "default": { "type": "worker", "cache": { "enabled": false } },
     "StaticAssets": { "type": "worker", "cache": { "enabled": true } },
     ...
   }
   ```

---

## 3. Configure Secrets

Set required secrets using `npx wrangler secret put <NAME>` from the `multi/` folder:

### A. Persistent S3 Storage (Required)
Bold BI containers run stateless. Persistent storage is offloaded to S3 (`storageType: 3`):

```powershell
npx wrangler secret put BOLD_SERVICES_AMAZON_BUCKET_NAME
npx wrangler secret put BOLD_SERVICES_AMAZON_ROOTFOLDER_NAME
npx wrangler secret put BOLD_SERVICES_AWS_REGION              # e.g. us-east-1
npx wrangler secret put BOLD_SERVICES_AWS_ACCESS_KEY_ID
npx wrangler secret put BOLD_SERVICES_AWS_SECRET_ACCESS_KEY
```

### B. Base URL & Admin Token (Required)
```powershell
# Set to your primary ingress URL (no trailing slash)
npx wrangler secret put APP_BASE_URL        # e.g. https://poc-cloudflare-bi.synctester.com or https://<worker>.<subdomain>.workers.dev

# Administrative secret for /_internal/restart and /_internal/diag/* endpoints
npx wrangler secret put ADMIN_TOKEN         # Use a long random string
```

### C. Placement Hints & Performance (Recommended)
```powershell
npx wrangler secret put DO_LOCATION_HINT    # enam
npx wrangler secret put DO_NAME_SUFFIX      # e.g. us1 or use3 (fresh suffix forces DO creation in hint region)
npx wrangler secret put STATIC_CACHE        # true (enables Workers Caching for CDN assets)
```

> **Note on Database Secrets:** Do NOT configure database host or passwords as Wrangler secrets. Database connection details are configured once via the UMS startup UI (`/ums/startup`) and saved into S3 and PostgreSQL directly.

---

## 4. Deployment

### A. Install Dependencies
```powershell
npm install
```

### B. Validate Configuration (Dry Run)
```powershell
npx wrangler deploy --dry-run
```
Ensure all 10 containers and Durable Object bindings are listed without errors.

### C. Full Deployment Rollout
Run full deployment to register containers and the Worker:
```powershell
npm run deploy
```

> **Important:** Always use `npm run deploy` when updating container settings or `wrangler.jsonc`. Use `npm run deploy:worker` (`--containers-rollout=none`) only for Worker code changes that do not modify container definitions.

---

## 5. Custom Domain Mapping (Optional)

If mapping a custom domain (e.g. `poc-cloudflare-bi.synctester.com`):

1. **Prerequisite:** The apex domain (e.g. `synctester.com`) must be an active zone in the **same Cloudflare account** as your Worker.
2. Open Cloudflare Dashboard > **Workers & Pages** > your Worker > **Settings** > **Domains & Routes**.
3. Click **Add** > **Custom Domain** and enter `poc-cloudflare-bi.synctester.com`.
4. Cloudflare automatically issues Universal SSL certificates and manages DNS.
5. In Cloudflare Dashboard > **SSL/TLS**:
   - Set encryption mode to **Full (strict)**.
   - Enable **Always Use HTTPS**.
6. Update `APP_BASE_URL` secret to match the domain:
   ```powershell
   npx wrangler secret put APP_BASE_URL # https://poc-cloudflare-bi.synctester.com
   ```
7. Restart all containers so they inherit the new base URL (see Section 7).

---

## 6. Cold Warm-Up & Initial Setup

Because containers initialize lazily on first access, warm them up before initial configuration:

```powershell
$b = "https://poc-cloudflare-bi.synctester.com" # or your workers.dev URL

$paths = "/health-check","/api/health-check","/ums/health-check","/bi/health-check","/bi/api/health-check","/bi/jobs/health-check","/bi/designer/health-check","/etlservice/health-check","/aiservice/health-check","/mcp"

foreach ($p in $paths) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $code = curl.exe -s -o NUL -w "%{http_code}" -m 240 "$b$p"
  "{0,-30} {1}  {2} ms" -f $p, $code, $sw.ElapsedMilliseconds
}
```
*Run this loop twice.* The first pass starts all containers; the second pass should return 200 HTTP codes.

### Completing the Startup Wizard:
1. Open `https://<your-host>/ums/startup` in your browser.
2. Enter your database connection details:
   | Field | Recommended Value |
   |---|---|
   | Database Type | PostgreSQL |
   | Server Name | your US East database hostname (e.g. `*.postgres.database.azure.com`) |
   | Port | `5432` |
   | Maintenance Database | `postgres` |
   | Username / Password | Database admin credentials |
   | Database Name | `bold_services` (or new database name) |
   | Enable SSL | Checked (if required by cloud provider) |
3. Complete license registration and administrator account setup.

---

## 7. Operational Management & Diagnostics

### A. Restarting Containers
Wrangler deployments do not restart running containers if container images have not changed. Use the administrative restart endpoint:

```powershell
$h = @{ "X-Admin-Token" = "<your-ADMIN_TOKEN>" }

# Restart all 10 containers
Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all" | ConvertTo-Json

# Verify instances are terminated (LIVE INSTANCES = 0)
npx wrangler containers list
```

### B. Placement & Region Verification
Inspect where containers and Durable Objects are physically executing:

```powershell
# Egress colocation for all containers (should show IAD or MIA):
Invoke-RestMethod -Headers $h "$b/_internal/diag/trace?host=all" | ConvertTo-Json -Depth 5

# Colocation of Durable Objects:
Invoke-RestMethod -Headers $h "$b/_internal/diag/do-trace?host=all" | ConvertTo-Json -Depth 5
```

### C. Network Latency Diagnostics
Measure raw TCP connection RTT directly from inside running containers:

```powershell
# Check latency from id-ums container to PostgreSQL:
Invoke-RestMethod -Headers $h "$b/_internal/diag/tcp?from=id-ums&host=<db-host>&port=5432&n=20" | ConvertTo-Json -Depth 5

# Check latency from bi-api container to S3:
Invoke-RestMethod -Headers $h "$b/_internal/diag/tcp?from=bi-api&host=<bucket-host>&port=443&n=20" | ConvertTo-Json -Depth 5

# Check container internal loopback performance:
Invoke-RestMethod -Headers $h "$b/_internal/diag/curl?from=id-api&local=1&path=/api/health-check&n=30" | ConvertTo-Json -Depth 5
```

### D. Static Asset Cache Verification
Verify Cloudflare Workers Caching for CDN static assets:

```powershell
$u = "$b/bi/cdn/scripts/custom-ui.min.js?v=gJCUyutTyzx1s9fAcyW-rZN4crXv4bdE9GH2Bf0HAYk"
1..3 | % { curl.exe -s -o NUL -D - $u | Select-String "HTTP/|cf-cache-status|cache-control" ; "---" }
```
Expected: First request returns `CF-Cache-Status: MISS`, subsequent requests return `CF-Cache-Status: HIT`.

---

## 8. Clean Reset & Reinstallation

To reset Bold BI back to an unconfigured state:

1. Stop all containers:
   ```powershell
   Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all"
   npx wrangler containers list # Confirm all show LIVE INSTANCES 0
   ```
2. Clean AWS S3: Delete the `app_data` directory under your configured S3 root folder.
3. Clean Database: Drop and recreate the `bold_services` database in PostgreSQL, or provide a fresh database name.
4. Redeploy & warm up:
   ```powershell
   npm run deploy
   ```
5. Navigate to `https://<your-host>/ums/startup` to rerun setup.

---

## 9. Uninstall

To permanently remove all Cloudflare resources:

1. List all container applications:
   ```powershell
   npx wrangler containers list
   ```
2. Delete each container application:
   ```powershell
   npx wrangler containers delete <container-id>
   ```
3. Delete the Worker, secrets, and Durable Objects:
   ```powershell
   npx wrangler delete
   ```
4. Remove the S3 bucket data and cloud database as desired.
