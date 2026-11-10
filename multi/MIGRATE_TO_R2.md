# Move the deployment to Cloudflare R2 storage and private Docker Hub images

Use this to remove the current S3-based deployment and reinstall with R2 (vendor storage type `5`) and a private Docker Hub image tag. Run everything from the `multi/` folder in PowerShell.

The Worker picks R2 when `BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME` is set (it wins over S3). The S3 variables are no longer needed.

## 0. Set up a new PC

1. **Node.js 22+** (includes npm): `winget install OpenJS.NodeJS.LTS`, then reopen PowerShell. Check with `node -v`.
2. **Git**: `winget install Git.Git`.
3. **OpenSSH client** (only for [SSH.md](SSH.md)): ships with Windows 10/11. Check with `ssh -V`.
4. **Get the code and dependencies:**
   ```powershell
   git clone https://github.com/sivakumar-devops/boldbi-on-cloudflare.git
   cd boldbi-on-cloudflare\multi
   npm install
   ```
5. **Authenticate Wrangler** with an account ID and API token, set for the current window. Create the token in the Cloudflare dashboard (My Profile > API Tokens) with Workers, Containers, and R2 edit permission on your account:
   ```powershell
   $env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
   $env:CLOUDFLARE_API_TOKEN  = "<api-token>"
   npx wrangler whoami
   ```
   To keep them across windows, run `setx CLOUDFLARE_ACCOUNT_ID "<account-id>"` and `setx CLOUDFLARE_API_TOKEN "<api-token>"`, then reopen PowerShell. Never commit these.
6. **Create an SSH key** if you want container SSH: see [SSH.md](SSH.md).

## 1. Uninstall the current deployment

Your admin token and `$b` (site URL) are needed only if the Worker is still up.

1. Stop the containers:
   ```powershell
   $b = "https://poc-cloudflare-bi.synctester.com"
   $h = @{ "X-Admin-Token" = "<ADMIN_TOKEN>" }
   Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all"
   ```
2. Delete every container application (repeat per ID):
   ```powershell
   npx wrangler containers list
   npx wrangler containers delete <application-id>
   ```
3. Delete the Worker, its secrets and Durable Objects:
   ```powershell
   npx wrangler delete
   ```
4. Start from clean data. Bold BI stores setup in storage and in the database, so a fresh install needs both empty:
   - Delete the `app_data` folder under the old S3 root folder (or keep it as a backup and use a new R2 root folder name).
   - Drop and recreate the `bold_services` PostgreSQL database, or use a new database name.

## 2. Create the R2 bucket and keys

1. Create a bucket:
   ```powershell
   npx wrangler r2 bucket create <bucket-name>
   ```
2. In the dashboard open R2 > Manage API tokens > Create API token. Give it **Object Read & Write** on that bucket. Save the **Access Key ID** and **Secret Access Key** (shown once).
3. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

## 3. Private Docker Hub images (the Kubernetes "image pull secret" equivalent)

Cloudflare Containers keeps registry credentials at account level. You register Docker Hub once, and every `docker.io/...` image in `wrangler.jsonc` is then pulled with it.

1. In Docker Hub create an access token with **Read-only** permission (Account Settings > Personal access tokens).
2. Register it. Wrangler stores the token in Secrets Store and prompts for it; do not type it in the command line:
   ```powershell
   npx wrangler containers registries configure docker.io --dockerhub-username <dockerhub-username>
   ```
   To run without a prompt, pipe it: `"<token>" | npx wrangler containers registries configure docker.io --dockerhub-username <user>`.
3. Check it: `npx wrangler containers registries list`. Remove it later with `npx wrangler containers registries delete docker.io`.
4. Change the image references in `wrangler.jsonc` to your private repositories and tags, for example `docker.io/<org>/<repo>:<dev-tag>`. All 10 containers have an `image` line. Keep the registry prefix `docker.io/`.

Notes:
- Cloudflare copies the image into its own registry at deploy time. The token is used by `wrangler deploy`, not by the running containers, so a token that is revoked later does not stop existing containers.
- The first deploy after changing tags re-pulls all images and can take several minutes.

## 4. Set secrets (dummy values first)

Placeholders let you deploy and test the wiring before the real values exist. Replace them later with the same commands.

```powershell
$dummy = @{
  BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME        = "dummy-bucket"
  BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID      = "dummy-access-key-id"
  BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY  = "dummy-secret-access-key"
  BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL       = "https://dummy-account-id.r2.cloudflarestorage.com"
  BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME   = "dummy-root"
}
foreach ($k in $dummy.Keys) { $dummy[$k] | npx wrangler secret put $k }
```

`BOLD_SERVICES_STORAGETYPE=5` is set automatically by the Worker, so you do not set it yourself.

Then the same secrets as before, with your values:
```powershell
npx wrangler secret put APP_BASE_URL     # https://poc-cloudflare-bi.synctester.com
npx wrangler secret put ADMIN_TOKEN      # long random string
npx wrangler secret put DO_LOCATION_HINT # enam
npx wrangler secret put DO_NAME_SUFFIX   # new suffix, e.g. r2a
npx wrangler secret put STATIC_CACHE     # true
```
Using a new `DO_NAME_SUFFIX` makes sure you get fresh Durable Objects and containers.

> Secrets can only be set after the Worker exists. If `secret put` says the Worker is missing, run `npm run deploy` once first, then set the secrets and deploy again.

## 5. Deploy and warm up

```powershell
npx wrangler deploy --dry-run
npm run deploy
```
Then run the warm-up in [DEPLOYMENT.md section 6](DEPLOYMENT.md#6-cold-warm-up--initial-setup) twice and open `https://<your-host>/ums/startup` to run the setup wizard.

## 6. Replace the dummy values with the real ones

```powershell
npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME
npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID
npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY
npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL
npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME
```
Containers read these only when they start, so restart them afterwards:
```powershell
Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all"
```
Run the startup wizard only after the real values are in. If you already ran it with the dummy values, do the clean reset in [DEPLOYMENT.md section 8](DEPLOYMENT.md#8-clean-reset--reinstallation) first (empty the R2 root folder and the database).

## Verify

Check the variables reached a container with the exec endpoint (see [DIAGNOSTICS.md](DIAGNOSTICS.md)); do not print the secret keys:
```powershell
(Invoke-RestMethod -Method Post -Headers $h -Uri "$b/_internal/diag/exec?from=bi-api" -Body 'env | grep -E "STORAGETYPE|R2_BUCKET|R2_ENDPOINT|R2_ROOT"')."bi-api".output
```
Expect `BOLD_SERVICES_STORAGETYPE=5` and your bucket, endpoint and root folder.
