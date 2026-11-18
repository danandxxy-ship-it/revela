#!/usr/bin/env bash
# REVELA — instalador para servidor Linux (Oracle Cloud grátis ou qualquer VPS Ubuntu/Debian).
# Instala Node.js, FFmpeg, yt-dlp e Caddy (HTTPS automático), abre o firewall e deixa tudo
# ligando sozinho com o servidor. Pode rodar de novo a qualquer hora: atualiza sem perder os vídeos.
#
# Uso:  curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/instalar.sh | sudo bash
# Opcional: DOMINIO=videos.seusite.com (senão usa IP.sslip.io, que funciona sem comprar domínio)
set -Eeuo pipefail

REPO="${REPO:-https://github.com/danandxxy-ship-it/revela.git}"
RAMO="${RAMO:-main}"
BASE=/opt/revela
APP=$BASE/app
DADOS=/var/lib/revela
LOG=/var/log/revela-instalacao.log
NODE_MAJOR=22

exec > >(tee -a "$LOG") 2>&1
passo() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m    ok\033[0m %s\n' "$*"; }
falha() { printf '\n\033[1;31mERRO:\033[0m %s\n(log completo em %s)\n' "$*" "$LOG"; exit 1; }
trap 'falha "o passo acima falhou (linha $LINENO)."' ERR

[ "$(id -u)" -eq 0 ] || falha "rode como root (use sudo)."
export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null || falha "este instalador é para Ubuntu/Debian."

case "$(uname -m)" in
  x86_64|amd64) ARQ_NODE=x64;   ARQ_CADDY=amd64 ;;
  aarch64|arm64) ARQ_NODE=arm64; ARQ_CADDY=arm64 ;;
  *) falha "arquitetura $(uname -m) não suportada." ;;
esac

passo "Pacotes do sistema (FFmpeg, Python, git)"
for _ in 1 2 3; do if apt-get update -y; then break; fi; sleep 10; done
apt-get install -y --no-install-recommends ca-certificates curl git ffmpeg python3 python3-venv xz-utils iptables >/dev/null
ok "$(ffmpeg -version | head -1 | cut -d' ' -f1-3)"

# Memória pequena (ex.: VM Micro de 1 GB): cria swap para a conversão não travar
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && ! swapon --show | grep -q .; then
  passo "Criando 2 GB de swap (máquina com ${MEM_MB} MB de RAM)"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap ativo"
fi

passo "Node.js $NODE_MAJOR"
mkdir -p $BASE
NODE_VER=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import sys,json;print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$NODE_MAJOR.')))")
if [ ! -x "$BASE/node/bin/node" ] || [ "$("$BASE/node/bin/node" -v)" != "$NODE_VER" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$ARQ_NODE.tar.xz" -o /tmp/node.tar.xz
  rm -rf $BASE/node && mkdir -p $BASE/node && tar -xJf /tmp/node.tar.xz -C $BASE/node --strip-components=1 && rm -f /tmp/node.tar.xz
fi
ok "Node $("$BASE/node/bin/node" -v)"

passo "yt-dlp (com suporte ao YouTube via Node)"
[ -x $BASE/venv/bin/python ] || python3 -m venv $BASE/venv
$BASE/venv/bin/pip install -q -U pip
$BASE/venv/bin/pip install -q -U "yt-dlp[default]"
ok "yt-dlp $($BASE/venv/bin/yt-dlp --version)"

passo "Caddy (HTTPS automático)"
if [ ! -x /usr/local/bin/caddy ]; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$ARQ_CADDY" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
ok "$(/usr/local/bin/caddy version | cut -d' ' -f1)"

passo "Código do REVELA"
if [ -d $APP/.git ]; then git -C $APP fetch -q origin "$RAMO" && git -C $APP reset -q --hard "origin/$RAMO"
else rm -rf $APP && git clone -q --depth 1 -b "$RAMO" "$REPO" $APP; fi
cd $APP
PATH=$BASE/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund >/dev/null
ok "versão $(git -C $APP log -1 --format='%h de %cd' --date=short)"

passo "Usuário e pastas"
id revela >/dev/null 2>&1 || useradd --system --home $DADOS --shell /usr/sbin/nologin revela
mkdir -p $DADOS && chown -R revela:revela $DADOS
ok "vídeos ficam em $DADOS"

passo "Endereço público"
# reaproveita o domínio e as opções de uma instalação anterior
if [ -f /etc/revela.env ]; then
  ANT=$(sed -n 's#^URL_PUBLICA=https://##p' /etc/revela.env)
  case "$ANT" in *.sslip.io|"") ;; *) DOMINIO="${DOMINIO:-$ANT}" ;; esac
  DIAS_EXPIRAR="${DIAS_EXPIRAR:-$(sed -n 's/^DIAS_EXPIRAR=//p' /etc/revela.env)}"
fi
IP=$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me || true)
[ -n "${DOMINIO:-}" ] || [ -n "$IP" ] || falha "não consegui descobrir o IP público."
DOMINIO="${DOMINIO:-${IP//./-}.sslip.io}"
ok "https://$DOMINIO"

NUCLEOS=$(nproc)
cat > /etc/revela.env <<EOF
PORT=8080
HOST=127.0.0.1
DATA_DIR=$DADOS
URL_PUBLICA=https://$DOMINIO
YTDLP_BIN=$BASE/venv/bin/yt-dlp
CONVERSOES_SIMULTANEAS=$([ "$NUCLEOS" -ge 4 ] && echo 2 || echo 1)
DIAS_EXPIRAR=${DIAS_EXPIRAR:-0}
EOF

cat > /etc/caddy-revela <<EOF
$DOMINIO {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
# quem digitar só o IP no navegador cai no site
:80 {
	redir https://$DOMINIO{uri}
}
EOF

passo "Serviços (ligam sozinhos e religam se cair)"
cat > /etc/systemd/system/revela.service <<EOF
[Unit]
Description=REVELA - laboratorio de video
After=network-online.target
Wants=network-online.target

[Service]
User=revela
EnvironmentFile=/etc/revela.env
WorkingDirectory=$APP
ExecStart=$BASE/node/bin/node $APP/server.js
Restart=always
RestartSec=3
Nice=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/caddy-revela.service <<EOF
[Unit]
Description=Caddy (HTTPS do REVELA)
After=network-online.target revela.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy-revela --adapter caddyfile
Environment=XDG_DATA_HOME=/var/lib/caddy-revela XDG_CONFIG_HOME=/var/lib/caddy-revela
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# atualização diária do yt-dlp (os sites mudam o tempo todo) e do sistema de links
cat > /etc/systemd/system/revela-ytdlp.service <<EOF
[Unit]
Description=Atualiza o yt-dlp do REVELA
[Service]
Type=oneshot
ExecStart=$BASE/venv/bin/pip install -q -U "yt-dlp[default]"
EOF
cat > /etc/systemd/system/revela-ytdlp.timer <<EOF
[Unit]
Description=Atualiza o yt-dlp do REVELA todo dia
[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
[Install]
WantedBy=timers.target
EOF

# comando "revela-atualizar": baixa a versão nova do código e reinicia
cat > /usr/local/bin/revela-atualizar <<'EOF'
#!/bin/sh
curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/instalar.sh | sudo bash
EOF
chmod +x /usr/local/bin/revela-atualizar

systemctl daemon-reload
systemctl enable --now revela.service >/dev/null
systemctl restart revela.service
systemctl enable --now revela-ytdlp.timer >/dev/null

passo "Firewall (portas 80 e 443)"
# As imagens Ubuntu da Oracle vêm com iptables bloqueando tudo menos SSH
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true
elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4; fi
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
ok "portas abertas no servidor"

systemctl enable --now caddy-revela.service >/dev/null
systemctl restart caddy-revela.service

passo "Conferindo"
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/api/status >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/api/status >/dev/null || { journalctl -u revela -n 30 --no-pager; falha "o REVELA não respondeu."; }
ok "REVELA respondendo"

HTTPS_OK=nao
for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 "https://$DOMINIO/api/status" >/dev/null 2>&1; then HTTPS_OK=sim; break; fi
  sleep 2
done

echo "https://$DOMINIO" > $BASE/ENDERECO.txt
printf '\n\033[1;31m==========================================================\033[0m\n'
printf '  \033[1mREVELA instalado\033[0m\n\n'
printf '  Seu site:  \033[1;36mhttps://%s\033[0m\n' "$DOMINIO"
if [ "$HTTPS_OK" = sim ]; then
  printf '  HTTPS:     \033[1;32mfuncionando\033[0m\n'
else
  printf '  HTTPS:     \033[1;33mainda não respondeu de fora.\033[0m\n'
  printf '             Na Oracle, libere as portas 80 e 443 na "Security List" da rede\n'
  printf '             (o guia explica). O certificado sai sozinho logo depois.\n'
fi
printf '\n  Atualizar depois:  revela-atualizar\n'
printf '  Ver o que acontece: journalctl -u revela -f\n'
printf '\033[1;31m==========================================================\033[0m\n'
