# SSH into the containers

Cloudflare runs its own SSH server (Dropbear) inside every container, so the vendor images need no changes. You connect through Wrangler, which authenticates against your Cloudflare account. No port is exposed to the internet.

All 10 containers in `wrangler.jsonc` have SSH enabled and an `authorized_keys` entry:

```jsonc
"ssh": { "enabled": true },
"authorized_keys": [{ "name": "my-key", "public_key": "ssh-ed25519 AAAA... you@host" }]
```

The shell inside is `/bin/sh` and you are `root`.

## One-time setup

1. **Create an ed25519 key.** Other key types are not supported.
   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\cf_containers
   Get-Content $HOME\.ssh\cf_containers.pub
   ```
2. **Add the public key** (the whole `ssh-ed25519 AAAA...` line, never the private key) to the `authorized_keys` list of every container in `wrangler.jsonc`. To allow several people, add one entry each.
3. **Deploy.** Key changes need a full deploy, which restarts all containers:
   ```powershell
   npm run deploy
   ```

## Every time you connect

1. **Wake the container.** SSH never starts a stopped container. Run the warm-up in [DEPLOYMENT.md section 6](DEPLOYMENT.md#6-cold-warm-up--initial-setup), or open the site in a browser.
2. **Find the application ID** of the container, then its **instance ID**:
   ```powershell
   npx wrangler containers list
   npx wrangler containers instances <APP_ID>
   ```
   The instance must show `STATE running`. The instance ID changes every time the container restarts or is redeployed, so look it up again each time.
3. **Connect.**
   ```powershell
   ssh -i $HOME\.ssh\cf_containers -o IdentitiesOnly=yes `
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL `
     -o ProxyCommand="cmd /c npx wrangler containers ssh %h" `
     cloudchamber@<INSTANCE_ID>
   ```
4. **Run a single command** instead of a shell by adding it at the end, for example `ls /application`. Type `exit` to leave an interactive session.

### Why the command looks like this
| Part | Reason |
|---|---|
| `-i ... -o IdentitiesOnly=yes` | Your key is not named `id_ed25519`, so `ssh` would not offer it. Plain `npx wrangler containers ssh <ID>` fails with `ECONNRESET` for the same reason. |
| `cmd /c npx ...` | On Windows, OpenSSH cannot start `npx` directly (`CreateProcessW failed error:2`). `cmd /c` fixes it. |
| `StrictHostKeyChecking=no`, `UserKnownHostsFile=NUL` | Every restart gives the container a new host key, which triggers "REMOTE HOST IDENTIFICATION HAS CHANGED". The connection already goes through your authenticated Wrangler tunnel. Use these two options only with this proxy, never for ordinary servers. |
| `cloudchamber@` | The login name Cloudflare expects. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `INVALID_INSTANCE_ID` | You passed the application ID. Use the instance ID from `wrangler containers instances <APP_ID>`. |
| `Proxy error: read ECONNRESET` | The container is stopped or the wrong key is being offered. Warm it up, check the instance is `running`, and use the `ssh -i` form above. |
| `CreateProcessW failed error:2` / `posix_spawnp: No such file` | Use `cmd /c npx wrangler ...` in `ProxyCommand`. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | Expected after a restart. Run `ssh-keygen -R <INSTANCE_ID>`, or use the `StrictHostKeyChecking`/`UserKnownHostsFile` options above. |
| `Permission denied (publickey)` | The public key in `wrangler.jsonc` does not match your private key, or was not deployed. Compare `ssh-keygen -y -f $HOME\.ssh\cf_containers` with the config, and check `npx wrangler containers info <APP_ID>`. |
| Instance not listed, or `LIVE INSTANCES 0` | The container is asleep (idle for `sleepAfter`, 6 hours). Warm it up again. |
| `Address already in use` when starting your own `sshd` | Port 22 is already served by Cloudflare's Dropbear. Do not install or start another SSH server. |

## Useful commands inside a container
```sh
ps aux                                   # running processes (the app is PID 16 or so)
ls /application                          # app files; logs under /application/app_data/logs
tail -n 100 /application/app_data/logs/bi.dataservice/errors.txt
cat /application/app_data/configuration/local_service_url.json
cat /proc/net/tcp                        # listening ports; ss and netstat are not installed
```
Tools such as `ss` and `netstat` are missing from the vendor images.

## Without SSH
If SSH is not convenient, `POST /_internal/diag/exec` runs a command in one or all containers over HTTPS. See [DIAGNOSTICS.md](DIAGNOSTICS.md#running-commands-inside-the-containers-no-ssh).

## Security
- Anyone with write access to the Cloudflare account and a listed key can get a root shell in the containers, which hold customer data and secrets in their environment. Keep `authorized_keys` to the people who need it, and remove keys when they leave.
- To turn SSH off, set `"ssh": { "enabled": false }` and run `npm run deploy`.
- Changes made inside a container are lost when it restarts. Use SSH for inspection, not for configuration.
