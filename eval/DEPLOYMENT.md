# Bold BI Eval (PostgreSQL bundled in one container)

Deploys the vendor image `syncfusion/boldbi:17.1.30-eval` as one Cloudflare
Container behind one Worker (`boldbi-eval`). This folder is self-contained.

## How it works

The image already contains Bold BI and an initialized PostgreSQL 15, which share
`localhost:5432`, so no database tunnel or second container is needed.

The vendor image ships with `/application/entrypoint.sh` designed for standard Linux
Docker hosts. On Cloudflare Containers, a lightweight wrapper (`cloudflare-entrypoint.sh`)
runs first to prepare the Cloudflare microVM environment before launching the vendor script:

```text
Container Starts
   │
   ▼
cloudflare-entrypoint.sh  (Cloudflare microVM setup & password sync)
   │
   ▼
/application/entrypoint.sh (Vendor script: starts 10 .NET services + Nginx)
```

### Why `cloudflare-entrypoint.sh` is required

Cloudflare Containers run inside lightweight microVMs rather than standard Linux hosts.
Without this wrapper, the container fails on boot due to 4 specific environment differences:

1. **Shared memory fix (`dynamic_shared_memory_type mmap`)**: PostgreSQL defaults to POSIX
   shared memory (`posix`), which Cloudflare microVMs restrict. Without switching to `mmap`,
   PostgreSQL crashes immediately with `could not open shared memory segment: Permission denied`.
2. **Missing microVM directories & permissions**: Cloudflare microVMs do not pre-create
   `/var/run/postgresql` or `/var/log/postgresql` with non-root ownership. The wrapper creates them
   and sets `postgres:postgres` permissions so PostgreSQL can create its lock and socket files.
3. **Database password synchronization**: The bundled cluster has a default password. The wrapper
   reads your Worker secret (`BOLD_SERVICES_DB_PASSWORD`) and runs `ALTER ROLE postgres WITH PASSWORD`
   so your configured credentials work in the setup wizard.
4. **Reverse proxy environment**: Sets `BOLD_SERVICES_REVERSE_PROXY=true` so internal Nginx recognizes
   Cloudflare's `X-Forwarded-Proto` HTTPS header and avoids infinite redirect loops.

Once these steps complete, `exec "$@"` hands execution over to Syncfusion's `/application/entrypoint.sh`.

The Worker passes these variables to the container:

| Variable | Value |
| --- | --- |
| `BOLD_SERVICES_DB_HOST` / `_DB_TYPE` | `localhost` / `postgresql` |
| `BOLD_SERVICES_DB_USER` | `postgres` |
| `BOLD_SERVICES_DB_PASSWORD` | secret `EVAL_DB_PASSWORD` |
| `BOLD_SERVICES_USER_EMAIL` | `EVAL_ADMIN_EMAIL`, default `testuser@boldbi.com` |
| `BOLD_SERVICES_USER_PASSWORD` | secret `EVAL_ADMIN_PASSWORD` |
| `BOLD_SERVICES_REVERSE_PROXY` | `true` (TLS ends at Cloudflare) |

The Worker also forwards the public scheme/host, upgrades same-host `http`
redirects and adds `upgrade-insecure-requests` to HTML. Readiness uses an HTTP
check on port 80 (`localhost/health-check`), never on PostgreSQL.

## 1. Prerequisites

- Node.js 22 or later, and a running Docker engine
- A Cloudflare account and an API token that can edit Workers, Containers and the registry

```powershell
$env:CLOUDFLARE_API_TOKEN = '<token>'
Set-Location eval
npm install
```

Edit `wrangler.jsonc`: set `account_id` to your account. Change `name`
(`boldbi-eval`) if you want a different Worker name and URL.

## 2. Set secrets

```powershell
npx wrangler secret put EVAL_DB_PASSWORD
npx wrangler secret put EVAL_ADMIN_PASSWORD
```

Optional: `EVAL_ADMIN_EMAIL` to replace the default administrator email.

## 3. Deploy

```powershell
npm run deploy
npx wrangler containers list
```

Wait until the application shows Ready. The instance starts on demand.
`LIVE INSTANCES` shows 0 until traffic arrives; check a running instance with its ID:

```powershell
npx wrangler containers instances <ContainerID>
```

## 4. Open and sign in

Open the Worker URL printed by the deploy in a new Incognito window and allow a
few minutes for the first start. Complete any trial/license prompt, then sign in:

| Setting | Value |
| --- | --- |
| Administrator email | `testuser@boldbi.com` (or `EVAL_ADMIN_EMAIL`) |
| Administrator password | your `EVAL_ADMIN_PASSWORD` |
| Database form, if shown | `localhost` / `5432`, user `postgres`, password `EVAL_DB_PASSWORD` |

Open a dashboard to confirm it renders.

## 5. Updates and tests

- Code-only update: `npm run deploy:worker` (keeps the current image).
- Image change: `npm run deploy`.
- Checks: `npm run check`, `npm test`.

Container storage is temporary: stopping or replacing the instance discards
application and database files.

## 6. Reset or uninstall

List the applications and note the ID of `boldbi-eval-boldbievalcontainer`
(the name follows your Worker name):

```powershell
npx wrangler containers list
npx wrangler containers delete <id>
```

Redeploy with `npm run deploy` for a clean install. To remove everything,
including secrets: `npx wrangler delete`.

## 7. Uninstall

Removes everything this guide created. This is permanent and discards all data.

1. Delete the container application (ID from `npx wrangler containers list`):

   ```powershell
   npx wrangler containers delete <id>
   ```

2. Delete the Worker, which also removes its secrets and Durable Objects
   (requires delete permission on the Worker):

   ```powershell
   npx wrangler delete
   ```

3. Optional: remove the pushed image with `npx wrangler containers images list`
   and `npx wrangler containers images delete <image>`, and delete local
   `node_modules` if the folder is no longer needed.

References: [Vendor eval deployment](https://help.boldbi.com/deploying-bold-bi/deploying-on-docker/bold-bi-on-docker/bold-bi-eval-on-single-container/),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).
