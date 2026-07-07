# Deploying Screenshare Annotate

## Sync server

`server/server.js` is a WebSocket relay. Health check: `GET /health` returns `ok`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4321` | Port to listen on |
| `JOIN_TOKEN` | unset | If set, clients must connect with `?token=<value>` |

A server can run on any Ubuntu VM (for example an Oracle Cloud free-tier instance) set up with
`deploy/setup-oracle.sh`. The app's default server is set in `src/main.js` (`DEFAULT_SERVER`).

### Set up a new server on Oracle Cloud

1. Create an Ubuntu 22.04 instance (shape `VM.Standard.E2.1.Micro` is enough) and note its public
   IP.
2. In the instance's VCN security list, add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
3. Create a subdomain at https://www.duckdns.org and copy its token.
4. Copy the files over and run the setup script. It asks for the DuckDNS subdomain and token, then
   installs Node and Caddy, opens the firewall and sets up the `annotate` service with HTTPS.

   ```bash
   ssh -i <key> ubuntu@<PUBLIC_IP> "mkdir -p ~/annotate"
   scp -i <key> -r server deploy/setup-oracle.sh ubuntu@<PUBLIC_IP>:~/annotate/
   ssh -i <key> ubuntu@<PUBLIC_IP>
   cd ~/annotate && bash setup-oracle.sh
   ```

5. Check it: `curl https://<subdomain>.duckdns.org/health`.

If the script fails with `bad interpreter`, fix the line endings with `sed -i 's/\r$//' setup-oracle.sh`.

Managing it on the VM: `sudo systemctl restart annotate`, `journalctl -u annotate -f`,
`sudo systemctl restart caddy`.

### Other hosting

The repo also has a `Dockerfile` and a `fly.toml` (Fly.io, kept always on). Any host works as
long as it doesn't sleep when idle, since a restart disconnects everyone.

## Desktop app

### Build

```bash
npm install
npm run dist        # dist/Screenshare Annotate Setup <version>.exe
npm run dist:dir    # unpacked build for testing
npm run icon        # regenerate assets/icon.png
```

The installer isn't code-signed, so Windows shows a SmartScreen warning on install.

### Release an update

Installed apps check GitHub releases on `dylan40907/screenshare-annotate` (set in
`package.json` under `build.publish`) and update themselves. Publishing needs a GitHub token with
`repo` scope in `GH_TOKEN`.

```powershell
npm version patch
$env:GH_TOKEN = "<token>"
npm run publish
```

Use `npm run publish`, not `npm run dist -- --publish always`, which fails with
"Unknown target: always".
