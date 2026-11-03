# Bold BI Multi-Container: Traffic Routing & Workflow Architecture

This document explains end-to-end how requests flow through the Bold BI Cloudflare deployment across regional boundaries, how clients receive responses, and how containers communicate with each other inside Cloudflare's network.

---

## 1. Regional Layout Overview

The deployment coordinates resources across three distinct network zones:

```text
┌────────────────────────┐      ┌──────────────────────────────────────────────────────────────┐      ┌─────────────────────────┐
│     Client Browser     │      │                      Cloudflare Edge                         │      │      External Data      │
│                        │      │                                                              │      │                         │
│ Any location worldwide │ ───► │ 1. Anycast Edge PoP   (nearest to client, e.g. MAA / LHR)    │ ───► │ PostgreSQL Database     │
│                        │      │ 2. Worker / DO / App  (pinned to US East: ENAM / IAD)        │      │ (Azure US East: 6ms RTT)│
│                        │      │    - 10x Durable Objects (DO_LOCATION_HINT=enam)             │      │                         │
│                        │      │    - 10x Microservice Containers (constraints: ["ENAM"])     │ ───► │ AWS S3 Bucket           │
│                        │      │    - Internal RPC Interception (outboundByHost)              │      │ (us-east-1: app_data)   │
└────────────────────────┘      └──────────────────────────────────────────────────────────────┘      └─────────────────────────┘
```

| Component | Geographical Region | Placement Mechanism | Notes |
|---|---|---|---|
| **Anycast Edge (Inbound PoP)** | Nearest global datacenter (e.g., MAA, LHR, FRA, SJC) | BGP Anycast DNS | Terminates client TLS connection at the closest geographical edge point. |
| **Worker Ingress & Durable Objects** | US East (`ENAM` / IAD) | `DO_LOCATION_HINT = "enam"` | Durable Objects (singleton instances) are instantiated in Cloudflare's US East core datacenters. |
| **Microservice Containers (10x)** | US East (`ENAM` / IAD) | `constraints.regions: ["ENAM"]` in `wrangler.jsonc` | Physical Linux container instances are executed strictly in US East nodes co-located with the Durable Objects. |
| **Relational Database** | Azure US East (`postgres287457.postgres.database.azure.com`) | External Cloud Provider | ~6 ms TCP connect time from the containers located in US East. |
| **Shared File Storage** | AWS S3 (`us-east-1`) | External Cloud Provider | Used for shared application data (`BOLD_SERVICES_STORAGETYPE=3`). |

---

## 2. Client-to-Server Request Flow (Public Inbound)

When a client loads a dashboard, logs in, or makes an API call:

```text
[Step 1] Client Browser (e.g., Chennai / MAA)
   │  HTTPS GET https://poc-cloudflare-bi.synctester.com/bi/site/site1/dashboards/...
   ▼
[Step 2] Cloudflare Anycast Edge (PoP: MAA)
   │  - Terminates TLS at local edge point.
   │  - Evaluates static cache eligibility (STATIC_CACHE=true).
   │    * If static asset (/bi/cdn/*) -> Handled via StaticAssets WorkerEntrypoint (Edge Cache HIT/MISS).
   │    * If dynamic request -> Routes through Cloudflare internal fiber backbone directly to US East.
   ▼
[Step 3] Gateway Worker Router (ENAM)
   │  - Sets forwarding headers:
   │      X-Forwarded-Host: poc-cloudflare-bi.synctester.com
   │      X-Forwarded-Proto: https
   │  - Evaluates longest-prefix URL path routing table:
   │      /etlservice/*    ──► bi-etl
   │      /aiservice/*     ──► bold-ai
   │      /mcp/*           ──► bold-mcp
   │      /bi/api/*        ──► bi-api
   │      /bi/jobs/*       ──► bi-jobs
   │      /bi/designer/*   ──► bi-designer
   │      /bi/*            ──► bi-web
   │      /api/*           ──► id-api
   │      /ums/*           ──► id-ums
   │      /* (default)     ──► id-web
   ▼
[Step 4] Target Durable Object Instance (e.g., BiWebContainer in ENAM)
   │  - Resolves DO singleton via: ns.getByName("bi-web", { locationHint: "enam" })
   │  - Checks container lifecycle state. If idle/sleeping, wakes it up.
   │  - Forwards the request into the container's internal port (HTTP port 80 / 8080).
   ▼
[Step 5] Container Execution (.NET / Kestrel)
      - App processes request, queries Azure PostgreSQL (US East) and AWS S3 (us-east-1).
```

---

## 3. Server-to-Client Response Flow (Public Outbound)

Once the container finishes processing the request, the response travels back along the reverse path:

```text
[Step 1] Container App (Kestrel port 80 in ENAM)
   │  Emits HTTP response with payload (e.g., HTML, JSON, or asset).
   ▼
[Step 2] Durable Object Bridge
   │  Injects platform metrics and server timings:
   │  Server-Timing: container-start;dur=0.0, container-app;dur=42.1
   ▼
[Step 3] Worker Edge Gateway
   │  - Sanitizes response headers (secureApplicationResponse).
   │  - Adds total worker execution time header:
   │    Server-Timing: worker-total;dur=45.3
   ▼
[Step 4] Cloudflare Anycast Edge (PoP)
   │  Sends compressed HTTPS response over the edge connection to the client browser.
   ▼
[Step 5] Client Browser
      Receives data, renders dashboard UI, and executes client-side scripts.
```

---

## 4. Container-to-Container Internal Routing (Service-to-Service)

Bold BI microservices frequently need to speak directly to each other. For example, when `id-ums` creates a user, it must call `id-api` and `bi-api`.

Because Cloudflare Containers do **not** run inside a shared Docker bridge network, standard Docker DNS resolution is unavailable. Instead, communication is routed internally via Cloudflare's **`outboundByHost` RPC interception**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Cloudflare ENAM US East Environment                                                   │
│                                                                                        │
│   ┌───────────────────────────┐                        ┌───────────────────────────┐   │
│   │   Source Container        │                        │   Target Container        │   │
│   │   (e.g., id-ums)          │                        │   (e.g., id-api)          │   │
│   │                           │                        │                           │   │
│   │   Calls:                  │                        │   Listens:                │   │
│   │   http://id-api/api/...   │                        │   Kestrel on port 80      │   │
│   └─────────────┬─────────────┘                        └─────────────▲─────────────┘   │
│                 │                                                    │                 │
│                 ▼                                                    │                 │
│       [Local TCP Connect]                                    [Local TCP Delivery]      │
│                 │                                                    │                 │
│                 ▼                                                    │                 │
│   ┌───────────────────────────┐                        ┌─────────────┴─────────────┐   │
│   │ Outbound Interceptor      │                        │ Target Durable Object     │   │
│   │ (outboundByHost hook)     │                        │ (IdApiContainer in ENAM)  │   │
│   └─────────────┬─────────────┘                        └─────────────▲─────────────┘   │
│                 │                                                    │                 │
│                 │               Workers In-Memory DO RPC             │                 │
│                 └────────────────────────────────────────────────────┘                 │
│                          forwardInternal() intercepts request                          │
│                          Skips Public DNS / Edge / TLS / WAN                           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Internal Interception Steps:

1. **URL Configuration (`local_service_url.json`):**
   When each container starts, the Worker's entrypoint script writes `/application/app_data/configuration/local_service_url.json` pointing all 19 internal service keys to internal hostnames:
   - `IdpApi` = `http://id-api/api`
   - `BiApi` = `http://bi-api/bi/api`
   - `Etl` = `http://bi-etl`
   - `Ai` = `http://bold-ai/aiservice`
   - `Mcp` = `http://bold-mcp/mcp`

2. **Outbound Interception (`outboundByHost`):**
   Every container class (`IdUmsContainer`, `BiWebContainer`, etc.) registers an interceptor mapping for all internal hostnames (`OUTBOUND_HOSTS`):
   ```typescript
   cls.outboundByHost = Object.fromEntries(
     OUTBOUND_HOSTS.map((h) => [h, (req, env) => forwardInternal(req, env)])
   );
   ```

3. **In-Memory Forwarding (`forwardInternal`):**
   When `id-ums` issues `http://id-api/api/v1.0/users`, Cloudflare's runtime catches the outbound call and passes it directly to `forwardInternal(req, env)`:
   - Sets `X-Forwarded-Host: <public_base_domain>` so tenant resolution remains consistent.
   - Sets `X-Forwarded-Proto: https`.
   - Locates target service stub: `serviceStub(env, "id-api")`.
   - Directly calls target Durable Object `stub.fetch()`.

4. **Zero-WAN Overhead:**
   - Traffic **never leaves Cloudflare's internal network**.
   - No public DNS lookups.
   - No TLS negotiation overhead between services.
   - Pinned to the same region (`ENAM`), eliminating cross-continental network latency.

---

## 5. Traffic Routing Reference Matrix

| Path Pattern / Host | Router Action | Target Service | Internal Port | External Resources Contacted |
|---|---|---|---|---|
| `/` or `/accounts/*` | Gateway Prefix Match | `id-web` | 80 | S3 (`app_data`) |
| `/api/*` | Gateway Prefix Match | `id-api` | 80 | Azure PostgreSQL, S3 |
| `/ums/*` | Gateway Prefix Match | `id-ums` | 80 | Azure PostgreSQL, S3, `id-api` (internal) |
| `/bi` or `/bi/site/*` | Gateway Prefix Match | `bi-web` | 80 | Azure PostgreSQL, S3, `bi-api` (internal) |
| `/bi/api/*` | Gateway Prefix Match | `bi-api` | 80 | Azure PostgreSQL, S3 |
| `/bi/jobs/*` | Gateway Prefix Match | `bi-jobs` | 80 | Azure PostgreSQL, S3 |
| `/bi/designer/*` | Gateway Prefix Match | `bi-designer` | 80 | Azure PostgreSQL, S3 |
| `/etlservice/*` | Gateway Prefix Match (strips prefix) | `bi-etl` | 80 | S3 |
| `/aiservice/*` | Gateway Prefix Match | `bold-ai` | 8080 | S3 |
| `/mcp/*` | Gateway Prefix Match | `bold-mcp` | 80 | S3 |
| `/bi/cdn/*` | StaticAssets Cache Entrypoint | `bi-web` | 80 | Cloudflare Tiered Cache |
| `http://<service-name>` | `outboundByHost` Interception | Target DO | 80 / 8080 | Handled entirely in Workers memory |
