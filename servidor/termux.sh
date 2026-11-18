#!/data/data/com.termux/files/usr/bin/bash
# REVELA no Android (Termux). Rode UMA vez:
#   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/termux.sh | bash
# Depois, para ligar:  revela-ligar     (e para ver o endereço: revela-endereco)
set -euo pipefail

REPO="https://github.com/danandxxy-ship-it/revela"
DIR="$HOME/revela"
DADOS="$HOME/revela-dados"
PREFIXO="${PREFIX:-/data/data/com.termux/files/usr}"

say() { printf '\n==> %s\n' "$*"; }

[ -d "$PREFIXO" ] || { echo "Isto precisa rodar dentro do app Termux (Android)."; exit 1; }

say "Atualizando pacotes"
yes | pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts git ffmpeg python cloudflared termux-api >/dev/null 2>&1 \
  || pkg install -y nodejs git ffmpeg python cloudflared termux-api

say "Baixando o REVELA"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
( cd "$DIR" && npm install --omit=dev --no-audit --no-fund )

say "Instalando yt-dlp (para converter links)"
python -m pip install -q --upgrade "yt-dlp[default]" || python -m pip install -q --upgrade yt-dlp

mkdir -p "$DADOS" "$HOME/.termux/boot" "$PREFIXO/bin"

say "Criando comandos"
cat > "$PREFIXO/bin/revela-ligar" <<EOF
#!$PREFIXO/bin/bash
# Liga o servidor e o túnel; mantém o celular acordado.
command -v termux-wake-lock >/dev/null && termux-wake-lock
mkdir -p "$DADOS"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
cd "$DIR"
export PORT=8080 HOST=127.0.0.1 DATA_DIR="$DADOS"
nohup node server.js >> "$DADOS/servidor.log" 2>&1 &
sleep 2
rm -f "$DADOS/tunel.log"
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080 >> "$DADOS/tunel.log" 2>&1 &
for i in \$(seq 1 30); do
  u=\$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$DADOS/tunel.log" 2>/dev/null | head -1)
  [ -n "\$u" ] && break
  sleep 1
done
if [ -n "\${u:-}" ]; then
  echo "\$u" > "$DADOS/endereco.txt"
  echo "REVELA no ar: \$u"
else
  echo "Servidor ligado, mas o endereço público ainda não apareceu. Rode: revela-endereco"
fi
EOF

cat > "$PREFIXO/bin/revela-endereco" <<EOF
#!$PREFIXO/bin/bash
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$DADOS/tunel.log" 2>/dev/null | tail -1 || echo "Sem endereço. Rode: revela-ligar"
EOF

cat > "$PREFIXO/bin/revela-atualizar" <<EOF
#!$PREFIXO/bin/bash
git -C "$DIR" pull --ff-only && (cd "$DIR" && npm install --omit=dev --no-audit --no-fund)
python -m pip install -q --upgrade "yt-dlp[default]"
revela-ligar
EOF
chmod +x "$PREFIXO/bin/revela-ligar" "$PREFIXO/bin/revela-endereco" "$PREFIXO/bin/revela-atualizar"

# Liga sozinho quando o celular reinicia (precisa do app Termux:Boot aberto uma vez)
cat > "$HOME/.termux/boot/revela" <<EOF
#!$PREFIXO/bin/sh
termux-wake-lock
sleep 20
revela-ligar
EOF
chmod +x "$HOME/.termux/boot/revela"

say "Pronto!"
cat <<'MSG'

Para ligar agora:   revela-ligar
Ver o endereço:     revela-endereco
Atualizar:          revela-atualizar

IMPORTANTE no Android (senão ele mata o servidor):
 1) Ajustes > Apps > Termux > Bateria > "Sem restrições".
 2) Deixe o celular carregando e no Wi-Fi.
 3) Puxe a notificação do Termux e toque em "Acquire wakelock".
MSG
