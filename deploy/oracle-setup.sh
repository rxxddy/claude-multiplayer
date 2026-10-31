#!/usr/bin/env bash
# Claude Multiplayer — one-shot server setup for a fresh Ubuntu 24.04 VM (Oracle Cloud Always Free, ARM or x86).
#
# Usage (on the VM, next to api.php):
#   sudo bash oracle-setup.sh [domain] ["Server name"] [join-key]
#
#   domain     your domain pointing to this VM; empty = free <ip>.sslip.io hostname (HTTPS works too)
#   name       community name shown in the app (default "Claude Multiplayer")
#   join-key   secret needed to register; empty = anyone with the address can register
#
# What it does: PHP 8.3-FPM + SQLite, Caddy (automatic HTTPS), firewall (22/80/443 only),
# automatic security updates, nightly database backups (14 days), only /api.php is reachable.
# Re-running is safe: it updates api.php and keeps the database.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/api.php" ]] || { echo "Put api.php next to this script first (scp api.php ubuntu@<ip>:~/)."; exit 1; }

DOMAIN="${1:-}"
NAME="${2:-Claude Multiplayer}"
JOIN_KEY="${3:-}"
APP=/var/www/multiplayer          # api.php lives in $APP/public, the database in $APP/private_cyberdeck
STATE=/etc/claude-multiplayer.env

if [[ -z "$DOMAIN" ]]; then
  IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
  DOMAIN="${IP//./-}.sslip.io"
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y php8.3-fpm php8.3-sqlite3 php8.3-mbstring php8.3-curl sqlite3 \
  unattended-upgrades iptables-persistent debian-keyring debian-archive-keyring apt-transport-https curl gnupg

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> firewall (Oracle images ship iptables rules that reject 80/443)"
# insert before the image's catch-all REJECT rule (or append when there is none)
reject_line="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null && continue
  if [[ -n "$reject_line" ]]; then
    iptables -I INPUT "$reject_line" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  else
    iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
netfilter-persistent save

echo "==> app files"
mkdir -p "$APP/public" "$APP/private_cyberdeck"
install -m 0644 "$HERE/api.php" "$APP/public/api.php"
chown -R root:www-data "$APP/public"
chown www-data:www-data "$APP/private_cyberdeck"
chmod 0750 "$APP/private_cyberdeck"

# secrets survive re-runs
if [[ ! -f "$STATE" ]]; then
  echo "DECK_SETUP_TOKEN=$(openssl rand -hex 16)" > "$STATE"
  chmod 0600 "$STATE"
fi
# shellcheck disable=SC1090
source "$STATE"

echo "==> php-fpm"
POOL=/etc/php/8.3/fpm/pool.d/www.conf
sed -i '/^env\[DECK_/d' "$POOL"
{
  echo "env[DECK_SETUP_TOKEN] = $DECK_SETUP_TOKEN"
  echo "env[DECK_SERVER_NAME] = \"$NAME\""
  [[ -n "$JOIN_KEY" ]] && echo "env[DECK_JOIN_KEY] = \"$JOIN_KEY\""
} >> "$POOL"
cat > /etc/php/8.3/fpm/conf.d/99-multiplayer.ini <<'INI'
expose_php = Off
display_errors = Off
log_errors = On
post_max_size = 2M
upload_max_filesize = 1M
max_execution_time = 30
INI
systemctl restart php8.3-fpm

echo "==> caddy (HTTPS is issued automatically)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	root * $APP/public
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	request_body {
		max_size 2MB
	}
	@api path /api.php
	handle @api {
		php_fastcgi unix//run/php/php8.3-fpm.sock
	}
	handle {
		respond "Claude Multiplayer server — add https://$DOMAIN in the app." 200
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> nightly backups (03:30, keep 14)"
mkdir -p /var/backups/multiplayer
cat > /etc/cron.d/multiplayer-backup <<CRON
30 3 * * * root sqlite3 $APP/private_cyberdeck/deck_state_v2.sqlite ".backup /var/backups/multiplayer/deck-\$(date +\%F).sqlite" && cp $APP/private_cyberdeck/deck_secret.key /var/backups/multiplayer/ 2>/dev/null; find /var/backups/multiplayer -name 'deck-*.sqlite' -mtime +14 -delete
CRON

echo
echo "================================================================"
echo " Server address:  https://$DOMAIN"
echo " Name:            $NAME"
echo " Join key:        ${JOIN_KEY:-<none: open registration>}"
echo " Setup token:     $DECK_SETUP_TOKEN"
echo "   (needed only for the FIRST registration = owner. Register yourself"
echo "    right now; stored in $STATE)"
echo "================================================================"
