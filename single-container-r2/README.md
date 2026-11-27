# Bold BI single container on Cloudflare (R2 storage + external database)

One Bold BI container (private image `syncfusion/dev-boldbi-docker:17.1.51_11062026_072923_193588_patch`) behind a Worker.
Files are stored in Cloudflare R2 (storage type 5). The database is external; none is bundled.
It is the Cloudflare equivalent of the compose file with `BOLD_SERVICES_*` auto-deployment variables.

## Settings

Plain variables (already in `wrangler.jsonc`): `BOLD_SERVICES_DB_TYPE=postgresql`, `OPTIONAL_LIBS`.
The Worker sets `BOLD_SERVICES_REVERSE_PROXY=true` and `BOLD_SERVICES_CONSOLE_LOG_ENABLED=true`.
If R2 is configured, it also sets `BOLD_SERVICES_STORAGETYPE=5`.

Optional test/debug variables (in `wrangler.jsonc` under `vars`):
- `DISABLE_R2: "true"`: forces local container storage (disables R2 variables).
- `INSTANCE_NAME: "boldbi-fresh-1"`: changes the Durable Object instance name. Changing this immediately starts a 100% clean, blank container instance without any residual state or cached disk files from previous runs.

Base secrets (mandatory):

| Secret | Purpose |
| --- | --- |
| `BOLD_SERVICES_UNLOCK_KEY` | Offline unlock key |
| `BOLD_SERVICES_DB_HOST` | Database server name |
| `BOLD_SERVICES_DB_USER` | Database user |
| `BOLD_SERVICES_DB_PASSWORD` | Database password |
| `BOLD_SERVICES_USER_EMAIL` | Admin email |
| `BOLD_SERVICES_USER_PASSWORD` | Admin password (6+ chars, upper, lower, digit, special) |

R2 Storage secrets (optional; when bucket is provided, all 5 become active):

| Secret | Purpose |
| --- | --- |
| `BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME` | R2 bucket |
| `BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID` | R2 access key |
| `BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 secret key |
| `BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL` | `https://<account-id>.r2.cloudflarestorage.com` |
| `BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME` | Unique folder; change it for a clean start |

The Worker answers 503 and lists any missing setting. Optional Bold BI variables
(`BOLD_SERVICES_DB_PORT`, `_DB_NAME`, ...) are not passed; the defaults apply (PostgreSQL port 5432).

## Push the private image first

```powershell
docker login
docker pull syncfusion/dev-boldbi-docker:17.1.51_11062026_072923_193588_patch
docker tag syncfusion/dev-boldbi-docker:17.1.51_11062026_072923_193588_patch dev-boldbi-docker:17.1.51_11062026_072923_193588_patch
npx wrangler containers push dev-boldbi-docker:17.1.51_11062026_072923_193588_patch
npx wrangler containers images list
```

`wrangler.jsonc` references the pushed copy in `registry.cloudflare.com`.

## Deploy

```powershell
cd single-container-r2
npm install
npx wrangler secret list
npx wrangler secret put <NAME>     # only for names that are missing
npm run deploy
```

The container is placed with the `enam` (US East) location hint, near the database.
Open the Worker URL; the first start takes a few minutes.

## Diagnostics (read-only logs)

Set a secret `ADMIN_TOKEN` (`npx wrangler secret put ADMIN_TOKEN`) and redeploy the Worker only
(`npm run deploy:worker`, which leaves the running container alone). Without it every call returns 403.

```powershell
$h = @{ "X-Admin-Token" = "<token>" }
Invoke-RestMethod -Headers $h "https://poc-cloudflare-bi.synctester.com/_internal/diag/logs"                                   # list log files
Invoke-RestMethod -Headers $h "https://poc-cloudflare-bi.synctester.com/_internal/diag/logs?file=/application/<path>.log&lines=300&grep=ERROR"
```
It never starts the container, and only reads `.log`/`.txt` files under `/application`, `/var/log`, `/tmp`.

Download the whole `/application/app_data/logs` folder as one archive:

```powershell
Invoke-WebRequest -Headers $h "https://poc-cloudflare-bi.synctester.com/_internal/diag/logs.tgz" -OutFile boldbi-logs.tgz
tar -xzf boldbi-logs.tgz
```

Download the whole logs folder: `GET /_internal/diag/logs.tgz`.
Empty the logs folder before reproducing an issue: `POST /_internal/diag/logs/clear` (files are truncated, not deleted).
