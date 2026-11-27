# Networking: single container vs multi container

This document explains, in simple terms, how a request travels in both Bold BI deployments on Cloudflare,
and whether the differences can explain the dashboard failure (`loaddashboard`).

Facts below come from the code in this repository (`multi/worker.ts`, `single-container-r2/worker.ts`,
`multi/TRAFFIC_ROUTING.md`) and from the log file list of the running single container.
Anything not verified is marked **Not verified**.

---

## 1. The key point

**In both deployments the browser never talks to the container directly. A Cloudflare Worker is always in front.**

```text
Browser ──HTTPS──► Cloudflare edge ──► Worker ──► Durable Object ──► container
```

So the first hops are identical in both models, and the Cloudflare limits on those hops apply to both.
Nginx inside the single container can only change what happens *after* the request reaches the container.
It cannot add features to the Browser → Cloudflare → Worker part.

This is why the same issue appears in both models. It does not prove the cause is the network, but it fits.

---

## 2. Single container

One container runs all Bold BI services plus **Nginx**. Nginx is the front door inside the container.

```text
Browser
  │ HTTPS
  ▼
Cloudflare edge (TLS ends here)
  ▼
Worker (adds X-Forwarded-Proto / X-Forwarded-Host)
  ▼
Durable Object ──► container port 80
                      │
                      ▼
                    Nginx (port 80)
                      │  routes by URL path (inside the container, localhost)
        ┌─────────────┼──────────────┬───────────────┐
        ▼             ▼              ▼               ▼
   Identity web   BI web / API   Designer / Jobs   ETL / AI / MCP
   (own local ports, all in the same container)
        │
        ├──► External PostgreSQL (East US)
        └──► Cloudflare R2 (files)
```

How it works:
- The Worker sends every request to **port 80** of the one container.
- **Nginx** reads the URL path and passes the request to the right Bold BI service on `localhost`.
- Services call each other over `localhost` through Nginx. No Cloudflare network is involved for these calls.
- Nginx logs exist at `/var/log/nginx/access.log` and `error.log`, which confirms Nginx is running.

**Not verified:** the actual Nginx configuration (timeouts, buffers, header sizes). The diagnostics endpoint only
reads `.log` and `.txt` files, so it could not show `nginx.conf`. See section 6 to read it.

---

## 3. Multi container

Ten containers, one per service, each with its own Durable Object. There is no Nginx between services.
The Worker does the routing that Nginx does in the single container.

```text
Browser
  │ HTTPS
  ▼
Cloudflare edge ──► Gateway Worker
                       │  picks the service by longest URL prefix
                       │  /bi/designer/* → bi-designer, /bi/api/* → bi-api, /bi/* → bi-web, ...
                       ▼
                 Durable Object (one per service) ──► that service's container

Container → container calls (for example bi-web calling id-api):
   container makes http://id-api/...   ──► Cloudflare intercepts the call (outboundByHost)
                                        ──► Worker hands it to the target Durable Object
                                        ──► target container
```

How it works:
- **Public traffic:** the Worker routes by path (see `multi/TRAFFIC_ROUTING.md`).
- **Service-to-service traffic:** a container calls a name such as `http://id-api`. The platform
  intercepts that call and delivers it to the matching Durable Object. It does not use a normal network
  or DNS inside Cloudflare.
- **Port:** each container listens on its own port (80 or 8080).

---

## 4. Side by side

| Topic | Single container | Multi container |
|---|---|---|
| Entry point | Worker → one container | Worker → one of 10 containers |
| Who routes by URL path | **Nginx** inside the container | **Worker code** |
| Service-to-service calls | `localhost` through Nginx | Cloudflare outbound interception |
| Hops per internal call | 1 (local) | 3 or more (container → Worker → Durable Object → container) |
| Proxy tuning (timeouts, buffers) | Nginx config (**not verified**) | Not available. Cloudflare defaults apply |
| Containers to keep running | 1 | 10 |
| Public hop from the browser | Same | Same |

---

## 5. The proxy settings table: who handles what

The table you shared lists Nginx/Traefik settings. In the single container, Nginx can apply them **only on its own
hop** (Nginx → service). The hops outside the container are still Cloudflare's.

| Setting | Single container | Multi container | Could it explain the failure? |
|---|---|---|---|
| `proxy_read_timeout`, `responseHeaderTimeout` | Nginx controls the Nginx → service hop. The Cloudflare → container hop is still Cloudflare's | Cloudflare defaults for every hop | Only if a call is slow. `loaddashboard` took about 41 seconds in the log, so check it |
| `proxy_connect_timeout` | Nginx → service only | Cloudflare | Unlikely. Connections are local or internal |
| `proxy_send_timeout` | Nginx → service only | Cloudflare | Unlikely. Requests are small |
| `idleConnTimeout` | Nginx → service only | Cloudflare | Only for long-lived connections |
| `proxy_buffer_size`, `proxy_buffers`, `proxy_busy_buffers_size` | Nginx can raise these on its hop | Not available | Possible if the response header or cookie is large. **Not verified** |
| `large_client_header_buffers` | Nginx can raise it, but Cloudflare checks the header size first | Cloudflare limit applies | Possible for big cookies. **Not verified** |
| `fastcgi_buffers` | Not used by Bold BI | Not used | No |

Important: raising a limit in Nginx does not help if Cloudflare rejects the request first.

---

## 6. Does this explain the dashboard failure?

What we know from the `wrangler tail` log:
- The page, scripts, access token and `loaddashboard` request all reached the Worker.
- `POST /bi/designer/v1.0/design/loaddashboard/` was sent at 9:07:00.
- The browser loaded the error icon at 9:07:41, about 41 seconds later.
- No Worker exception or "container is not running" appeared.

What this suggests:
- The request **did reach the container**, so a blocked route or broken proxy is less likely.
- A request that fails after about 41 seconds points to a **slow or failing step inside Bold BI** (a database
  call, a data source, an AI service call), or to a timeout. It does not look like a header-size error, because
  those fail at once.

What we cannot say yet:
- Whether the cause is a timeout, a large header or cookie, an application error, or something else.
  The log files from `bi.dataservice` will decide this.

Checks that separate the possibilities:

| Check | What it tells you |
|---|---|
| Status and response of `loaddashboard` in the browser Network tab | Gateway error (502/504/524) means network or proxy. A 500 with a JSON body means the application |
| `/application/app_data/logs/bi.dataservice/errors.txt` | An exception here means an application error |
| `/var/log/nginx/access.log` and `error.log` lines at the failure time | Shows whether Nginx saw the request and what status it returned |
| Time taken (about 41 seconds) | A value near 30, 60 or 100 seconds suggests a timeout. Compare with the failing call's own timeout |
| Request header and cookie size in the Network tab | Rules large headers in or out |

To read the Nginx settings in the running container, run this (it needs a diagnostics route for `nginx -T`;
ask and it can be added):
```text
nginx -T | grep -E "timeout|buffer|header"
```

---

## 7. Summary

- Both models use the same public path: Browser → Cloudflare → Worker → container. Cloudflare's limits apply to both.
- The single container adds Nginx inside, so internal calls stay on `localhost` and can be tuned.
  The multi container sends internal calls through Cloudflare's own interception, which cannot be tuned.
- Nginx cannot fix limits that sit in front of the container.
- The log shows a request that reached the container and failed after about 41 seconds. That points more to
  the application or a timeout than to a header or routing fault, but this is not proven.
- The next step is to read the `bi.dataservice` error log and the Nginx logs for the same minute.
