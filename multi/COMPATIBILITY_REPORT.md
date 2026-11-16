# Cloudflare vs Kubernetes (Traefik) / Linux (nginx): compatibility report

Reference files (now read in full): Traefik `bold-ingressroute` (ports 6000-6011, middlewares `gzip-compress`, `body-limit-200m`, `etl-rewrite`, ServersTransport `long-timeouts-transport`) and nginx `default.conf` (ports 6500-6511).
Subject: `worker.ts` + `wrangler.jsonc` (10 Durable Object containers, one instance each).

Status key: **Same** = already equivalent. **Changed** = changed in this revision. **Limit** = Cloudflare platform limit, cannot be configured away. **Open** = needs evidence before any change.

## 1. Findings

| # | Area | Traefik / nginx | Cloudflare Worker | Status |
|---|---|---|---|---|
| 1 | Routes | `/`, `/api`, `/ums`, `/bi`, `/bi/api`, `/bi/jobs`, `/bi/designer`, `/aiservice`, `/mcp`, `/etlservice` | Same ten targets, longest prefix first | Same |
| 2 | Match style | String prefix (`/apixyz` goes to id-api) | Segment boundary (`/apixyz` goes to id-web) | Open. No known Bold path is affected. Left unchanged. |
| 3 | ETL rewrite | `^/etlservice(/\|$)(.*)` replaced by `/$2`. Traefik only: the nginx file has **no** `/etlservice` block, so ETL is routed on K8s only. | Prefix stripped, query kept, `/etlservice` becomes `/` | Same |
| 4 | `/bi/designer/helper` | nginx: separate location with `Connection "upgrade"` (WebSocket). Traefik: covered by `/bi/designer`, WebSocket native | Handled by the `/bi/designer` route, headers forwarded unchanged | Same (not yet verified live, see section 3) |
| 5 | Host | `Host $http_host` (original host) | Public requests keep the public host. Internal calls get the internal name plus `X-Forwarded-Host`. | Same |
| 6 | `X-Forwarded-Proto/Host` | Set | Set (public and internal) | Same |
| 7 | `X-Forwarded-For` | `$proxy_add_x_forwarded_for` | Passed through if Cloudflare supplies it | **Changed**: filled from `CF-Connecting-IP` when absent |
| 8 | Cookies / auth | Passed through; Traefik sticky cookie `bold.k8s.pod.id` (maxAge 600) | Passed through untouched | Same. Sticky cookie not needed: one instance per service. |
| 9 | Body limit | 200 MB, returns 413 | Cloudflare edge limit by plan: 100 MB Free/Pro, 200 MB Business, 500 MB Enterprise | **Limit** plus **Changed**: Worker returns 413 above 200 MB when `Content-Length` is known |
| 10 | Timeouts | nginx 300 s read/send/connect; Traefik 300 s dial and response-header, 300 s idle | Edge waits about 100 s for first response bytes (HTTP 524) versus the 300 s above; raisable only on Enterprise | **Limit** |
| 11 | Gzip | `gzip on` / Traefik `compress` | Cloudflare compresses at the edge (gzip/brotli) for compressible types | Same, nothing to configure |
| 12 | Buffering | nginx `proxy_buffer_size 128k`, `proxy_buffers 4 256k`; Traefik `buffering.maxRequestBodyBytes` 209715200 | Workers stream bodies; no buffer settings exist | **Limit**, no functional loss expected |
| 13 | Request headers | nginx `large_client_header_buffers 4 16k` | Cloudflare enforces its own header size limits | **Limit** |
| 14 | Readiness | Kubernetes probes | TCP connect only (deliberate, see code comment) | **Changed**: optional HTTP readiness probe, off by default |
| 15 | Internal calls | Service DNS names through cluster | `http://<service>` intercepted and sent to the Durable Object; `id-web` calls with other services' paths are now routed by path (earlier fix) | Same. **Changed**: `APP_BASE_URL` fallback (see 3.4). |
| 16 | Lifecycle | Pods restart independently | `sleepAfter = 6h`, cold start up to 180 s, redeploy resets Durable Objects | Documented (section 4) |
| 17 | Environment | K8s sets `BOLD_SERVICES_HOSTING_ENVIRONMENT` and `DEPLOY_MODE` for Kubernetes | We set `docker` and `docker_multi_container` | Open. The ingress files contain no environment variables; the K8s deployment YAML is needed to compare. |

## 2. Evidence from the captured logs (two `wrangler tail` sessions)

* Routing bug found and fixed earlier: `http://id-web/bi/jobs/health-check` returned 404 (now 200 in about 65 ms).
* Dashboard failure: the designer logs `Issue in Intermediate Database. Error: Couldn't set <keyword> (Parameter '<keyword>')` on `GetDatasourceRefreshDetailsByIds`. That message is the PostgreSQL driver rejecting a malformed connection string. It is raised inside the application, so it is **not** caused by anything in this report. It needs the intermediate-database (Data Store) setting, which we have not seen.
* `AILogo` 500 and AI actions: `Invalid AI License Key provided`. A licensing matter, not networking.
* No 524, 413, 1101 or WebSocket error appeared in either capture.
* Neither capture contains traffic for WebSockets, uploads, exports, logout, ETL or MCP, so those are **not validated**.

Conclusion: nothing in the gateway configuration explains the two application errors above. The changes below close real differences but should not be expected to fix them.

## 3. Changes made

1. **X-Forwarded-For** is set from `CF-Connecting-IP` only when missing.
2. **413 guard**: requests with `Content-Length` above 200 MB are rejected by the Worker (same as `client_max_body_size 200M` and Traefik `maxRequestBodyBytes`). Chunked uploads without a length cannot be checked here.
3. **HTTP readiness probe** (opt-in). After the TCP port opens, the Worker calls the service's health path and waits until it answers with a status below 500 (a 404 counts as ready, since it proves the app is serving). It never blocks forever: after 90 s it proceeds anyway and logs a warning. Concurrent first requests now share one start-up instead of racing. Enabled per service with the `READINESS_PROBE_SERVICES` variable (comma-separated service names, or `all`). **Default is off**, so deploying this changes nothing until you opt in. Roll out one service first, for example `bi-designer`.
4. **APP_BASE_URL fallback**: if the secret is unset and a container is first started by an internal call, the container previously received `APP_BASE_URL=http://id-api`. It now falls back to the last public origin. With the secret set (as in your runbook) behaviour is unchanged.
5. `wrangler.jsonc` is **unchanged on purpose**. Nothing in it controls the items above.

## 4. Platform limits and alternatives

| Limit | Alternative |
|---|---|
| About 100 s without response bytes gives 524 (Enterprise can raise it) | Make long exports/refreshes asynchronous in the app, or poll. The Worker cannot send keep-alive bytes before the application replies. |
| Request body: 100/200/500 MB by plan | Confirm the plan covers 200 MB. For larger or unreliable uploads, use R2 presigned uploads. |
| No proxy buffer tuning | None needed; bodies stream. |
| Header size limits | Keep cookies small; check for oversized auth cookies if 400/431 appear. |
| WebSockets: container library notes that WebSocket requests made outside the Durable Object are limited (workerd issue 2319) | Our path calls the Durable Object `fetch`, which the library supports. Needs a live test. |
| One instance per service, cold start up to 180 s | Raise `max_instances` only after confirming the application tolerates two instances. Pre-warm after deploy with the warm-up loop. |
| A Worker deploy resets Durable Objects (seen as "reset because its code was updated") | Deploy outside working hours and warm up afterwards. |

## 5. Validation status

Unit tests (run in the sandbox): routing, ETL rewrite, headers, 413 guard, readiness helper, `APP_BASE_URL` fallback.

Live (from the logs): login token 200, tenant lookup 200, dashboard list 200, designer load calls return, internal `id-web` to `/bi/jobs` now 200.

| Scenario | Result |
|---|---|
| Authentication | Token and tenant calls succeed (live) |
| Logout | Not exercised, not validated |
| Dashboard open | Fails: intermediate-database error (application) |
| Designer | Pages and actions load; AI actions fail on licence |
| Datasource refresh | Fails: same intermediate-database error |
| Upload / export | Not exercised, not validated |
| WebSockets (designer helper, AI, MCP) | Not exercised, not validated |
| Internal service calls | Working (live) |

To close the gaps, run these with `npx wrangler tail --format pretty` open: log out and in, upload a file under 100 MB, export a dashboard, open the designer helper, and use the AI panel.


## 5. Differences found when the real files were read

* Traefik sticky cookie `bold.k8s.pod.id` is irrelevant here: `max_instances: 1` per service.
* Traefik `PathPrefix` and nginx `location` are plain prefix matches; the Worker matches on a path-segment boundary. No Bold path is known to differ.
* nginx uses `Connection keep-alive` for most locations and `upgrade` only for helper, aiservice and mcp. The Worker passes the client's own `Upgrade`/`Connection` headers, which is what a WebSocket client needs.
* Compression: Traefik compresses only bodies of 1024 bytes or more; Cloudflare decides on its own.
