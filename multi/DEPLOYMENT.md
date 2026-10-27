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

## Internal service-to-service routing

`IdpApi`, `BiApi` and `BiJob` in `local_service_url.json` point to internal hostnames (`http://id-api/api`, `http://bi-api/bi/api`,
`http://bi-jobs/bi/jobs`). Each container class registers `outboundByHost` handlers (`@cloudflare/containers`), so these calls are
intercepted and delivered straight to the target Durable Object instead of leaving through the public edge and coming back.
The forwarded request carries `X-Forwarded-Host`/`X-Forwarded-Proto` of the public URL. Browser-facing URLs (`Idp`, `Ums`, `Bi`, ...) stay public.

To fall back to the old behaviour (all calls via the public URL): `npx wrangler secret put SERVICE_COMMUNICATION` with value `public_url`,
then restart the containers (`npm run deploy`, or stop them) because the URL file is written at container start.

Timing: every proxied response carries a `Server-Timing` header (`container-start`, `container-app`, `worker-total`).
