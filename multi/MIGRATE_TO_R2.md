# Runbook: reinstall Bold BI on Cloudflare with R2 storage and private Docker Hub images

Follow the parts in order. Everything runs in PowerShell. Replace every `<...>` with your value.

What changes compared with the S3 setup:
- Storage is Cloudflare R2 (vendor storage type `5`). The Worker sets `BOLD_SERVICES_STORAGETYPE=5` by itself when `BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME` is set. R2 wins over S3 if both are set. The `BOLD_SERVICES_AWS_*` and `BOLD_SERVICES_AMAZON_*` secrets are no longer needed.
- Images come from a private Docker Hub repository. Cloudflare's equivalent of a Kubernetes image pull secret is a registry credential registered once per account (Part 4).

Time: about 30 minutes plus the first image pull (several minutes).

---

## Part 1. Set up the PC

1. Install the tools, then close and reopen PowerShell:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
2. Check them. Node must be 22 or newer:
   ```powershell
   node -v
   npm -v
   git --version
   ssh -V
   ```
   (`ssh` is built into Windows 10/11 and is only needed for [SSH.md](SSH.md).)

## Part 2. Get the code and log in to Cloudflare

1. Clone and install:
   ```powershell
   git clone https://github.com/sivakumar-devops/boldbi-on-cloudflare.git
   cd boldbi-on-cloudflare\multi
   git checkout bc/3f809b9b-know-about-bold
   npm install
   ```
   The R2 support is on that branch until PR #6 is merged. After the merge, skip the `git checkout`.
2. Create a Cloudflare API token: dashboard > My Profile > API Tokens > Create Token > Custom token. Give it these permissions on your account: Workers Scripts Edit, Cloudflare Containers Edit (or "Containers"), Workers R2 Storage Edit, Account Settings Read, and Workers Secrets/Secrets Store Edit if offered. If you do not want to work out the permissions, use the "Edit Cloudflare Workers" template and add R2 Edit and Containers.
3. Set the account ID and token. Find the account ID in the dashboard URL or on the Workers & Pages overview page:
   ```powershell
   $env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
   $env:CLOUDFLARE_API_TOKEN  = "<api-token>"
   npx wrangler whoami
   ```
   `whoami` must show your account. These variables last only for this window, so set them again in every new window, or make them permanent with `setx CLOUDFLARE_ACCOUNT_ID "<account-id>"` and `setx CLOUDFLARE_API_TOKEN "<api-token>"` and reopen PowerShell. Never commit them.
4. Put the account ID in `wrangler.jsonc`. The file has a placeholder `"account_id": "<YOUR_CLOUDFLARE_ACCOUNT_ID>"` on line 4. Replace it with your real ID, and leave it uncommitted:
   ```powershell
   (Get-Content wrangler.jsonc) -replace '<YOUR_CLOUDFLARE_ACCOUNT_ID>', $env:CLOUDFLARE_ACCOUNT_ID | Set-Content wrangler.jsonc
   ```

## Part 3. Uninstall the old deployment

This deletes the running site. Back up anything you need first. The old `app_data` in S3 and the database are not touched by the commands below. Part 3, step 4 handles them.

1. List the container applications and note every ID:
   ```powershell
   npx wrangler containers list
   ```
2. Delete each one (repeat for all 10 IDs):
   ```powershell
   npx wrangler containers delete <application-id>
   ```
3. Delete the Worker. This also removes its secrets and Durable Objects, and unlinks the custom domain you added in the dashboard:
   ```powershell
   npx wrangler delete
   ```
   Confirm with `y`. Then run `npx wrangler containers list` again. It should be empty.
4. Start from clean data, because a new setup must not find the old configuration:
   - **Old storage:** you are moving to a new R2 bucket, so the old S3 `app_data` can stay as a backup or be deleted.
   - **Database:** drop and recreate the `bold_services` PostgreSQL database, or choose a new database name in the wizard (Part 8).

## Part 4. Create the R2 bucket and keys

1. Create the bucket:
   ```powershell
   npx wrangler r2 bucket create <bucket-name>
   ```
2. Dashboard > R2 > Manage API Tokens > Create API token. Permission: **Object Read & Write**, limited to that bucket. Save the **Access Key ID** and **Secret Access Key** now, because the secret is shown only once.
3. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

You can skip this part for now and use dummy values in Part 6. Come back to it in Part 9.

## Part 5. Private Docker Hub images (the image pull secret)

1. Docker Hub > Account Settings > Personal access tokens > Generate. Permission: **Read-only**. Copy the token.
2. Register it with Cloudflare. Wrangler prompts for the token and stores it, so do not put it in the command:
   ```powershell
   npx wrangler containers registries configure docker.io --dockerhub-username <dockerhub-username>
   ```
   To avoid the prompt: `"<token>" | npx wrangler containers registries configure docker.io --dockerhub-username <dockerhub-username>`
3. Check it:
   ```powershell
   npx wrangler containers registries list
   ```
   (Remove it later with `npx wrangler containers registries delete docker.io`.)
4. Point the 10 `image` lines in `wrangler.jsonc` at your private repositories and development tag, keeping the `docker.io/` prefix, for example:
   ```jsonc
   "image": "docker.io/<org>/<repo>:<dev-tag>",
   ```
   List them with `Select-String '"image"' wrangler.jsonc`.

How it behaves: `wrangler deploy` pulls each image with the saved token and copies it into Cloudflare's own registry. Running containers do not use the token, so revoking it later does not stop them. A wrong token or tag fails the deploy with a pull error.

## Part 6. Deploy once, then set the secrets

Secrets can only be set once the Worker exists, and the Worker was deleted in Part 3.

1. Deploy to create it:
   ```powershell
   npx wrangler deploy --dry-run
   npm run deploy
   ```
   The first deploy can take several minutes while the images are pulled.
2. Set the R2 secrets with **dummy values** (you will replace them in Part 9):
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
   `BOLD_SERVICES_STORAGETYPE` is set by the Worker. Do not create it.
3. Set the general secrets with your real values:
   ```powershell
   npx wrangler secret put APP_BASE_URL      # https://poc-cloudflare-bi.synctester.com (no trailing slash)
   npx wrangler secret put ADMIN_TOKEN       # a long random string; keep it, you need it below
   npx wrangler secret put DO_LOCATION_HINT  # enam
   npx wrangler secret put DO_NAME_SUFFIX    # a NEW value, e.g. r2a, so fresh containers are created
   npx wrangler secret put STATIC_CACHE      # true
   ```
4. Check the list:
   ```powershell
   npx wrangler secret list
   ```

## Part 7. Custom domain, deploy again, and warm up

1. If you use the custom domain, add it again: dashboard > Workers & Pages > `boldbi-multi` > Settings > Domains & Routes > Add > Custom domain > `poc-cloudflare-bi.synctester.com`. The zone must be in the same Cloudflare account. Without a custom domain, use the `workers.dev` address and set `APP_BASE_URL` to it.
2. Deploy again so the new secrets and domain take effect on fresh containers:
   ```powershell
   npm run deploy
   ```
3. Warm up the containers. Run it twice; the second pass should print `200`:
   ```powershell
   $b = "https://poc-cloudflare-bi.synctester.com"
   $paths = "/health-check","/api/health-check","/ums/health-check","/bi/health-check","/bi/api/health-check","/bi/jobs/health-check","/bi/designer/health-check","/etlservice/health-check","/aiservice/health-check","/mcp"
   $jobs = $paths | ForEach-Object {
     Start-Job -ArgumentList $b, $_ -ScriptBlock {
       param($b, $p)
       $sw = [Diagnostics.Stopwatch]::StartNew()
       $code = curl.exe -s -o NUL -w "%{http_code}" -m 240 "$b$p"
       "{0,-30} {1}  {2} ms" -f $p, $code, $sw.ElapsedMilliseconds
     }
   }
   $jobs | Receive-Job -Wait -AutoRemoveJob
   ```
4. Check that storage settings reached a container (secret keys are not printed):
   ```powershell
   $h = @{ "X-Admin-Token" = "<ADMIN_TOKEN>" }
   ```
   This needs the exec endpoint, so do this once `EXEC_ENABLED` is set: `"true" | npx wrangler secret put EXEC_ENABLED`. Then:
   ```powershell
   (Invoke-RestMethod -Method Post -Headers $h -Uri "$b/_internal/diag/exec?from=bi-api" -Body 'env | grep -E "STORAGETYPE|R2_BUCKET|R2_ENDPOINT|R2_ROOT"')."bi-api".output
   ```
   Expect `BOLD_SERVICES_STORAGETYPE=5` and the dummy bucket, endpoint and root folder.

## Part 8. Do not run the setup wizard yet

The wizard writes its configuration to storage. With dummy R2 values it cannot, so finish Part 9 first.

## Part 9. Put in the real R2 values

1. Replace the five secrets with the real values from Part 4:
   ```powershell
   npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME
   npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID
   npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY
   npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL    # https://<account-id>.r2.cloudflarestorage.com
   npx wrangler secret put BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME  # any unique name
   ```
2. Containers read these only when they start. Restart them all, then warm them up again (Part 7, step 3):
   ```powershell
   Invoke-RestMethod -Method Post -Headers $h "$b/_internal/restart?host=all"
   ```
3. Repeat the check from Part 7, step 4. It must now show your real bucket and endpoint.

## Part 10. Install Bold BI and open the site

1. Open `https://poc-cloudflare-bi.synctester.com/ums/startup`.
2. Fill in the database form and continue:

   | Field | Value |
   |---|---|
   | Database Type | PostgreSQL |
   | Server Name | your US East PostgreSQL host |
   | Port | `5432` |
   | Maintenance Database | `postgres` |
   | Username / Password | the database admin credentials |
   | Database Name | `bold_services` (a fresh or empty database) |
   | Enable SSL | checked if your provider requires it |
3. Register the license and create the administrator account.
4. Open the site root `https://poc-cloudflare-bi.synctester.com/` and sign in. Dashboards are under `/bi/`.
5. After the wizard, files should appear in your R2 bucket under the root folder (dashboard > R2 > your bucket). If they do, storage works.

## If you ran the wizard before the real values were in

Do the reset in [DEPLOYMENT.md section 8](DEPLOYMENT.md#8-clean-reset--reinstallation): stop containers, empty the R2 root folder, recreate the database, deploy, then run the wizard again.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `wrangler whoami` shows not logged in | `CLOUDFLARE_API_TOKEN` is not set in this window, or lacks permission. |
| Deploy fails with an account error | `account_id` in `wrangler.jsonc` is still the placeholder (Part 2, step 4). |
| Deploy fails pulling an image (unauthorized, not found) | Re-run `registries configure` with a read token that can see the repository, and check the repository name and tag. |
| `secret put` says the Worker does not exist | Run Part 6, step 1 first. |
| Site returns errors right after Part 9 | Containers still hold the dummy values. Restart them. |
| 502 or timeout on first request | Containers are cold. Run the warm-up again. |
| Storage errors in logs | Check the endpoint is `https://<account-id>.r2.cloudflarestorage.com`, the token has Object Read & Write on the bucket, and the bucket name matches. Read logs with the endpoints in [DIAGNOSTICS.md](DIAGNOSTICS.md). |

SSH into a container: [SSH.md](SSH.md).
