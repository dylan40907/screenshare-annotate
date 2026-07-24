#!/usr/bin/env bash
# Screenshare Annotate - one-shot server setup for an Oracle (or any Ubuntu) VM.
#
# Installs Node + Caddy, opens the firewall, points a free DuckDNS subdomain at
# this box, gets a real TLS cert automatically, and runs the sync server 24/7.
# End result: a working wss:// URL, $0/forever.
#
# Prereqs on the VM (see DEPLOY.md):
#   - the `server/` folder copied to ~/annotate/server
#   - a free DuckDNS subdomain + token from https://www.duckdns.org
#
# Run:  cd ~/annotate && bash setup-oracle.sh
set -euo pipefail

APP_DIR="$HOME/annotate"
PORT=4321

echo "== Screenshare Annotate server setup =="
read -rp "DuckDNS subdomain (just the name, e.g. 'screenshare-annotate'): " DUCK_SUB
read -rp "DuckDNS token: " DUCK_TOKEN
[ -n "$DUCK_SUB" ] && [ -n "$DUCK_TOKEN" ] || { echo "Both are required."; exit 1; }
HOST="${DUCK_SUB}.duckdns.org"

echo "==> Detecting public IP..."
PUBLIC_IP="$(curl -s https://api.ipify.org || curl -s ifconfig.me)"
[ -n "$PUBLIC_IP" ] || { echo "Could not detect public IP"; exit 1; }
echo "    Public IP: $PUBLIC_IP  ->  $HOST"

echo "==> Pointing DuckDNS at this box..."
RESP="$(curl -s "https://www.duckdns.org/update?domains=${DUCK_SUB}&token=${DUCK_TOKEN}&ip=${PUBLIC_IP}")"
[ "$RESP" = "OK" ] || { echo "DuckDNS update failed (got: $RESP). Check the subdomain/token."; exit 1; }
echo "    DuckDNS: OK"

echo "==> Installing Node.js 20..."
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing Caddy..."
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi

echo "==> Installing server dependency (ws)..."
cd "$APP_DIR"
npm install ws >/dev/null 2>&1

echo "==> Opening the VM firewall (iptables 80/443)..."
# Oracle Ubuntu images ship a restrictive INPUT chain with a REJECT near the end.
# Insert our accepts just above that REJECT rule so they actually take effect.
REJECT_LINE="$(sudo iptables -L INPUT --line-numbers | awk '/reject-with icmp-host-prohibited/{print $1; exit}')"
REJECT_LINE="${REJECT_LINE:-6}"
sudo iptables -I INPUT "$REJECT_LINE" -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT "$REJECT_LINE" -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "==> Creating the sync-server service..."
sudo tee /etc/systemd/system/annotate.service >/dev/null <<EOF
[Unit]
Description=Screenshare Annotate sync server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
# To require a shared secret, uncomment and set it (clients append ?token=...):
# Environment=JOIN_TOKEN=change-me
ExecStart=$(command -v node) $APP_DIR/server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now annotate

echo "==> Configuring Caddy (auto-TLS + wss reverse proxy)..."
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${HOST} {
    reverse_proxy localhost:${PORT}
}
EOF
sudo systemctl restart caddy

echo ""
echo "======================================================================"
echo " Done. Give Caddy ~30s to fetch its certificate, then test:"
echo ""
echo "     curl https://${HOST}/health        # should print: ok"
echo ""
echo " Your sync server URL (put this in src/control/control.js):"
echo ""
echo "     wss://${HOST}"
echo "======================================================================"
