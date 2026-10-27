# Bold BI Multi-Container Deployment (Cloudflare Containers)

Deploys Bold BI microservices as separate Cloudflare Containers behind a single Worker (`boldbi-multi`).

## Architecture Overview

In this deployment, Bold BI is decomposed into distinct microservices:

```text
                                  ┌───► IdWebContainer (syncfusion/bold-identity:17.1.30)
                                  │     Port 80: / (IDP Web Portal)
                                  │
Browser / API  ──► Cloudflare  ───┼───► IdApiContainer (syncfusion/bold-identity-api:17.1.30)
                  Worker Edge     │     Port 80: /api (IDP REST API)
                  (Routing & TLS) │
                                  └───► IdUmsContainer (syncfusion/bold-ums:17.1.30)
                                        Port 80: /ums (Tenant & User Management)
```

Phase 1 adds the Bold BI core services (images from the vendor's multi-container compose file):
`/bi` -> bi-web (`boldbi-server`), `/bi/api` -> bi-api (`boldbi-server-api`),
`/bi/jobs` -> bi-jobs (`boldbi-server-jobs`), `/bi/designer` (+ `/helper`) -> bi-designer (`boldbi-designer`).
ETL (`/etlservice`, prefix stripped), AI (`/aiservice`, port 8080) and MCP (`/mcp`) each run in their own container, as in the vendor nginx config.

### Path Routing Map

The Worker handles path-based routing matching Syncfusion's Nginx configuration:
- `/`, `/login`, `/health-check` ──► `id-web`
- `/api`, `/api/*` ──► `id-api`
- `/ums`, `/ums/*` ──► `id-ums`

## 1. Prerequisites

- Node.js 22+ (no local Docker build is needed; `wrangler deploy` references the public vendor images on Docker Hub)
- Cloudflare CLI logged in via `npx wrangler login` or `CLOUDFLARE_API_TOKEN`

```powershell
Set-Location multi
npm install
```

Set your `account_id` in `multi/wrangler.jsonc` (run `npx wrangler whoami` to find it).

## 2. Deploy

Deploys the Worker and the Bold BI service containers (vendor images, `syncfusion/*:17.1.30`):

```powershell
npm run deploy
```

Check the status of your containers:

```powershell
npx wrangler containers list
```

To see individual live instance status:
```powershell
npx wrangler containers instances <ContainerID>
```

## 3. Verify Routing

Once deployed, query the health diagnostic:
```powershell
Invoke-RestMethod "https://<your-worker>.<subdomain>.workers.dev/_internal/health"
```
Expect:
```json
{
  "ok": true,
  "mode": "multi-container-spike",
  "services": ["id-web", "id-api", "id-ums", "..."]
}
```

Then open `https://<your-worker>.<subdomain>.workers.dev/ums/startup` in your browser.


## Secrets for Bold BI (phase 1)

Services share no disk on Cloudflare, so the vendor's S3 mode is used (`BOLD_SERVICES_STORAGETYPE=3`,
`BOLD_SERVICES_PV_USED=false`). Set these with `npx wrangler secret put <NAME>` (never commit them):

| Name | Purpose |
|---|---|
| `BOLD_SERVICES_AMAZON_BUCKET_NAME`, `BOLD_SERVICES_AMAZON_ROOTFOLDER_NAME`, `BOLD_SERVICES_AWS_REGION` | S3 location |
| `BOLD_SERVICES_AWS_ACCESS_KEY_ID`, `BOLD_SERVICES_AWS_SECRET_ACCESS_KEY` | S3 credentials |

Database settings are not stored as secrets: enter them manually on the UMS startup page (`/ums/startup`).

How service URLs work: each container is started with an entrypoint override (`SERVICE_ENTRYPOINT` in `worker.ts`) that writes
`local_service_url.json` with the public URLs before running the vendor `entrypoint.sh`. This replaces the former custom Dockerfiles.

## Service-to-service communication (`SERVICE_COMMUNICATION`)

Bold BI services find each other through `local_service_url.json`. The Worker writes it when each container starts
(an entrypoint override, then the vendor `entrypoint.sh`, which keeps an existing file).

| `SERVICE_COMMUNICATION` | Result |
|---|---|
| unset or `internal` (**default**) | **All 19 keys** use internal hosts, e.g. `IdpApi=http://id-api/api`, `BiApi=http://bi-api/bi/api`, `Etl=http://bi-etl`, `Ai=http://bold-ai/aiservice`, `Mcp=http://bold-mcp/mcp` |
| `public_url` | All 19 keys use the public URL, e.g. `IdpApi=https://<worker>/api` |

`INTERNAL_SERVICE_KEYS` (optional, comma separated, e.g. `IdpApi,BiApi`) limits internal mode to the listed keys and keeps the rest
public. It is for troubleshooting only, is empty by default, and is ignored in `public_url` mode.

Set with `npx wrangler secret put SERVICE_COMMUNICATION` (or `vars` in `wrangler.jsonc`). The file is written at container start,
so restart the containers after changing it:
`Invoke-RestMethod -Method Post -Headers @{ "X-Admin-Token" = "<token>" } "$b/_internal/restart?host=all"` (needs the `ADMIN_TOKEN` secret).

### How internal calls work on Cloudflare

Cloudflare containers have no shared network, so Docker hostnames do not resolve. Each container class sets `outboundByHost` for
`id-web, id-api, id-ums, bi-web, bi-api, bi-jobs, bi-designer, bi-etl, bold-ai, bold-mcp` (`@cloudflare/containers`, and the Worker
exports `ContainerProxy`). When a container calls `http://id-api/...`, the platform hands the request to the Worker, which forwards it
to that service's Durable Object and container (`forwardInternal`). The call never leaves Cloudflare and skips DNS, TLS and the public edge.
`X-Forwarded-Host` and `X-Forwarded-Proto` carry the public values, so the app still resolves the tenant by the public hostname.
The target port is the service's own (80, or 8080 for `bold-ai`).

### Browser-facing URLs

The vendor writes this file for containers only: in its Docker, ECS and Kubernetes modes every key is a cluster-internal address
(`http://id-web-service:6000`, ...), so no key is a browser URL. Browser URLs come from `APP_BASE_URL` (also used for `product.json`) and the
tenant domain, and these stay public in every mode. I confirmed this from the vendor `entrypoint.sh`, not from the compiled application,
so a key that the application hands to the browser would break in internal mode. Use `INTERNAL_SERVICE_KEYS` or `public_url` to isolate it.

### Limitations

- Interception is HTTP only (`http://` URLs). WebSocket/SignalR traffic over an intercepted host (Blazor for ETL, designer) is untested.
- The `Reports*` keys point at hosts with no container in this deployment; they are written for completeness and are unreachable.
- Calls to the database, S3 and other external hosts are unchanged (they leave the container directly).
- Internal hops still pass through the Worker and a Durable Object, so latency is lower than the public path, not Docker-network speed.
- Containers run in a Cloudflare location of Cloudflare's choosing (NRT in the logs), so database/S3 distance is unaffected by this setting.

Timing: every proxied response carries a `Server-Timing` header (`container-start`, `container-app`, `worker-total`).

## Temporary diagnostic: `/_internal/ping-internal`

Runs a request *inside* a running container against the internal hostnames (through the outbound interception) and returns status and time:

```powershell
Invoke-RestMethod "$b/_internal/ping-internal?from=id-ums&to=id-api,bi-api,bi-jobs" | ConvertTo-Json -Depth 5
```

`from` must be a running service (wake it first, e.g. `/ums/health-check`). Remove this route and `pingInternal` once verified.

## Restarting containers

`wrangler deploy` does **not** restart containers when only Worker code or env logic changed ("No changes to be made"). Because
`local_service_url.json` is written when a container starts, restart them explicitly:

```powershell
npx wrangler secret put ADMIN_TOKEN        # once; any long random value
$h = @{ "X-Admin-Token" = "<the token>" }
Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all"            # all services
Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=id-api,id-ums"  # selected services
```
The next request to each service starts a fresh container.

## Placement (US East configuration)

Both layers are configured for US East (ENAM):

1. **Containers (hard constraint):** Every container definition in `wrangler.jsonc` sets:
   ```json
   "constraints": { "regions": ["ENAM"] }
   ```
   This limits the scheduler to eastern North America. Cloudflare will not start the container outside ENAM unless the constraint is changed.
   Applied on `wrangler deploy` (the full deploy, not `deploy:worker`).

2. **Durable Objects (location hint):** `serviceStub` passes `locationHint` on every `getByName`:
   | Variable | Default | Meaning |
   |---|---|---|
   | `DO_LOCATION_HINT` | `enam` | `enam wnam weur eeur apac apac-ne apac-se sam oc afr me` or `none`. |
   | `DO_NAME_SUFFIX` | empty | Appended to every object name (`bi-web` becomes `bi-web-us3`). |

3. **Separate diagnostics:**
   - `GET /_internal/diag/trace?host=all`: where each **container** egresses (`cdn-cgi/trace` from inside the container).
   - `GET /_internal/diag/do-trace?host=all`: where each **Durable Object** egresses (from the isolate).

4. **Limits (Cloudflare platform):**
   - The container constraint requires capacity in ENAM. If a region runs out of capacity for that instance type, startup fails with an error rather than falling back.
   - A Durable Object location hint is advisory, not guaranteed. It applies only at object creation time.
   - Durable Objects and their containers are scheduled independently and are not guaranteed to be co-located.
   - `max_instances: 1` requires that the previous container be stopped before a new suffix is launched, via `POST /_internal/restart?host=all` with the old suffix still active.
