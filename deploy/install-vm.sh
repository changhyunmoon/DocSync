#!/usr/bin/env bash
# Run once as root from this directory; does not manage any existing web server.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ $(id -u) == 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
if ss -Hltn 'sport = :8088' | grep -q . && ! systemctl is-active --quiet docsync-web; then
  echo 'Port 8088 is already occupied; no changes made' >&2
  exit 1
fi
for account in docsync-web docsync-runner; do
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/$account" --shell /usr/sbin/nologin "$account"
  fi
done
install -d -m 755 /opt/docsync /opt/docsync/bin /opt/docsync/hooks /etc/docsync
install -d -o docsync-runner -g docsync-runner -m 755 /srv/docsync /srv/docsync/releases /srv/docsync/staging
install -d -o docsync-runner -g docsync-runner -m 700 /opt/docsync/runner
install -d -o docsync-web -g docsync-web -m 750 /var/log/docsync
install -m 644 Caddyfile /etc/docsync/Caddyfile
install -m 755 deploy-release.py cleanup.py /opt/docsync/
install -m 755 job-completed.sh /opt/docsync/hooks/job-completed.sh
install -m 644 docsync-web.service docsync-runner.service docsync-cleanup.service docsync-cleanup.timer /etc/systemd/system/
install -d -m 755 /etc/systemd/journald@docsync.conf.d
cat > /etc/systemd/journald@docsync.conf.d/limits.conf <<'JOURNAL'
[Journal]
SystemMaxUse=40M
RuntimeMaxUse=20M
MaxRetentionSec=7day
JOURNAL

temporary=$(mktemp -d /tmp/docsync-install.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
if [[ ! -x /opt/docsync/bin/caddy ]]; then
  curl --fail --location --retry 3 --output "$temporary/caddy.tar.gz" \
    https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz
  printf '%s  %s\n' 5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb "$temporary/caddy.tar.gz" | sha256sum -c -
  tar -xzf "$temporary/caddy.tar.gz" -C "$temporary" caddy
  install -m 755 "$temporary/caddy" /opt/docsync/bin/caddy
fi
if [[ ! -x /opt/docsync/runner/config.sh ]]; then
  curl --fail --location --retry 3 --output "$temporary/runner.tar.gz" \
    https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz
  printf '%s  %s\n' baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 "$temporary/runner.tar.gz" | sha256sum -c -
  tar -xzf "$temporary/runner.tar.gz" -C /opt/docsync/runner
  chown -R docsync-runner:docsync-runner /opt/docsync/runner
fi
install -o docsync-runner -g docsync-runner -m 755 /opt/docsync/runner/bin/runsvc.sh /opt/docsync/runner/runsvc.sh
printf '%s\n' docsync-runner.service > /opt/docsync/runner/.service
chown docsync-runner:docsync-runner /opt/docsync/runner/.service
chown -R docsync-web:docsync-web /var/log/docsync
sudo -H -u docsync-web /opt/docsync/bin/caddy validate --config /etc/docsync/Caddyfile --adapter caddyfile
systemd-analyze verify /etc/systemd/system/docsync-{web,runner,cleanup}.service /etc/systemd/system/docsync-cleanup.timer
systemctl daemon-reload
systemctl enable --now docsync-web.service docsync-cleanup.timer
# Private corporate network only. Existing firewall entries are left intact.
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow from 10.0.0.0/8 to any port 8088 proto tcp comment 'DocSync web'
fi
echo 'VM setup complete. Register the dedicated runner next.'
