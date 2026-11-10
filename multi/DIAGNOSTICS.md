# Performance diagnostics (multi)

All diagnostics are off by default. `/_internal/diag/*` needs the `ADMIN_TOKEN` secret (`X-Admin-Token` header) and is read-only.
`DIAG_ENABLED=true` (var or secret) makes internal calls log one JSON line each and add `Server-Timing: internal-forward`. Remove it after testing.

## Which stages can be measured

| Stage | Measurable? | How |
|---|---|---|
| Container -> outboundByHost -> ContainerProxy -> Worker handler | **Not separately.** It happens in the platform before our code runs. | Inferred: curl `time_starttransfer` inside the caller minus `totalMs` in the log |
| `forwardInternal` prep (header copy, stub lookup) | Yes | `prepMs` in log |
| Worker -> DO RPC -> container.fetch -> app | Together: `targetFetchMs` | log |
| App processing alone | Yes | `appMs` (the target's `container-app` Server-Timing) |
| DO RPC + container proxy overhead | Derived | `overheadMs = targetFetchMs - appMs` |
| Cold start | Yes | `container-start` in target Server-Timing |
| Caller-side end to end | Yes | `/diag/curl` (dns/connect/ttfb/total from inside the caller) |

## Procedure

Set `DIAG_ENABLED=true`, `ADMIN_TOKEN`, deploy with `npm run deploy:worker` (does not roll containers). Warm all services first.

1. Placement: `GET /_internal/diag/trace?host=all` -> egress `colo`/`loc` per container. This shows where the container reaches the internet from, which approximates but does not prove its location. Compare with the Worker colo and the DB/S3 regions. Also run `npx wrangler containers instances <id>` for what Cloudflare reports.
2. Resources: `GET /_internal/diag/resources?host=all` repeatedly while a slow page loads: `load` against `cpus`, `MemAvailable`, and cgroup `nr_throttled`/`throttled_usec` (rising = CPU saturation).
3. Pairs (run inside the caller, internal URL): `/diag/curl?from=id-web&to=id-api&path=/api/health-check&n=50`, then `id-ums->id-api`, `bi-web->bi-api` (`/bi/api/health-check`), `bi-api->bi-jobs` (`/bi/jobs/health-check`).
4. Database: `/diag/tcp?from=id-ums&host=<db host>&port=5432&n=20` (network RTT). Query time needs DB-side logs (`log_min_duration_statement`) or app logs.
5. S3: `/diag/tcp?from=bi-api&host=<bucket>.s3.<region>.amazonaws.com&port=443` (RTT), then `/diag/curl?from=bi-api&target=<same host>&path=/` (TLS + request; a 403 is fine, we only time it).
6. Internal vs public: run step 3 with `SERVICE_COMMUNICATION=internal`, restart (`POST /_internal/restart?host=all`), warm up, then with `public_url`; compare. For the same pair via the public URL use `/diag/curl?from=bi-web&target=<worker host>&path=/bi/api/health-check`. Use `scripts/bench.mjs` for the client-side view.
7. Collect `wrangler tail` output for the `"diag":"internal"` lines and compute percentiles per host (the `/diag/stats` endpoint is per isolate only).

Health-check endpoints are cheap and bypass most app work, so also benchmark one real authenticated API path of your choice; a health check will understate real latency.

## Caveats

- `nproc`/`/proc` inside a microVM reflect the VM, which is what matters here.
- `/diag/curl` opens a new connection per request (worst case); real apps may reuse connections, so it is an upper bound for connection setup cost.
- The curl and `/dev/tcp` probes need `bash`/`curl` in the vendor images. `curl` presence is not verified here; the code falls back only in the older ping-internal diagnostic.
- Location hints (`locationHint: "apac-ne"`) are best effort and apply only when a Durable Object is first created. Restarting the container does not move the DO. Moving requires a new DO name/ID. Container placement follows the DO but is not guaranteed.

## Reading log files inside a container

`GET /_internal/diag/logs?from=bi-designer` lists `.log`/`.txt` files (newest first) under `/application`, `/var/log` and `/tmp`.
Add `&file=<path>&lines=300` to read the end of one file, and `&grep=ERROR` to keep only lines containing that text.
Only those three folders and `.log`/`.txt` files are allowed. It is read-only and needs the `X-Admin-Token` header.

## Running commands inside the containers (no SSH)

`wrangler containers ssh` does not work here, because the vendor images have no SSH server. Use the exec endpoint instead. It runs `bash -c` inside the running container, like `docker exec`.

It is off by default. To turn it on:

1. Set the Worker variable `EXEC_ENABLED` to `true` (with `ADMIN_TOKEN` already set), then run `npm run deploy:worker`. This does not restart the containers.
2. Wake the containers first by opening the site. The endpoint does not start a stopped container.
3. Turn it off again when you finish by removing `EXEC_ENABLED` and redeploying the Worker.

```powershell
$h = @{ "X-Admin-Token" = $token }
$u = "$base/_internal/diag/exec"

# One container
Invoke-RestMethod -Method Post -Headers $h -Uri "$u`?from=bi-designer" -Body "ls -la /application"

# Several containers, or all ten
Invoke-RestMethod -Method Post -Headers $h -Uri "$u`?from=bi-api,bi-web" -Body "tail -n 50 /var/log/dpkg.log"
Invoke-RestMethod -Method Post -Headers $h -Uri "$u`?from=all" -Body "hostname; df -h /; free -m"
```

The body is the command. Add `&timeout=120` to allow up to 300 seconds (default 60). Each result ends with `[exit=N]`. Output is capped at 200,000 characters per container.

To check which patch version a container runs, try `ls /application` and `cat /application/*/version* 2>/dev/null`, or look at the image tag in `wrangler.jsonc`.

Every call is written to the Worker log (`"diag":"exec"` with the command), so use can be audited. Treat the admin token like a root password: anyone holding it can run commands in the containers while `EXEC_ENABLED` is `true`.

## SSH into a container

See [SSH.md](SSH.md) for the full guide: setup, connect command for Windows, and troubleshooting.
