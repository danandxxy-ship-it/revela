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
# Celular: chip de vídeo se funcionar; senão o modo mais rápido do processador, em até 1280 px
export ENCODER="\${ENCODER:-auto}" PRESET="\${PRESET:-ultrafast}" CRF="\${CRF:-23}" MAX_LADO="\${MAX_LADO:-1280}"
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
  # Copia o link e avisa (precisa do app Termux:API; sem ele só mostra na tela)
  command -v termux-clipboard-set >/dev/null && printf '%s' "\$u" | termux-clipboard-set 2>/dev/null
  command -v termux-toast >/dev/null && termux-toast "REVELA ligado - link copiado" 2>/dev/null
  command -v termux-notification >/dev/null && termux-notification --id revela --ongoing \\
    --title "REVELA no ar" --content "\$u" \\
    --button1 "Copiar link" --button1-action "printf %s \$u | termux-clipboard-set; termux-toast Link_copiado" \\
    --button2 "Abrir" --button2-action "termux-open-url \$u" \\
    --button3 "Desligar" --button3-action "revela-desligar" 2>/dev/null
  true
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
cat > "$PREFIXO/bin/revela-desligar" <<EOF
#!$PREFIXO/bin/bash
pkill -f "node server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
command -v termux-notification-remove >/dev/null && termux-notification-remove revela
command -v termux-wake-unlock >/dev/null && termux-wake-unlock
command -v termux-toast >/dev/null && termux-toast "REVELA desligado"
echo "REVELA desligado."
EOF
chmod +x "$PREFIXO/bin/revela-ligar" "$PREFIXO/bin/revela-endereco" "$PREFIXO/bin/revela-atualizar" "$PREFIXO/bin/revela-desligar"

# Botões para a tela inicial (app Termux:Widget)
mkdir -p "$HOME/.shortcuts"
printf '#!%s/bin/bash\nrevela-ligar\nsleep 4\n' "$PREFIXO" > "$HOME/.shortcuts/REVELA ligar"
printf '#!%s/bin/bash\nrevela-desligar\nsleep 2\n' "$PREFIXO" > "$HOME/.shortcuts/REVELA desligar"
chmod +x "$HOME/.shortcuts/REVELA ligar" "$HOME/.shortcuts/REVELA desligar"

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

Botão na tela inicial: instale Termux:Widget e Termux:API (F-Droid),
segure na tela inicial > Widgets > Termux:Widget > "REVELA ligar".

Para ligar agora:   revela-ligar
Desligar:           revela-desligar
Ver o endereço:     revela-endereco
Atualizar:          revela-atualizar

IMPORTANTE no Android (senão ele mata o servidor):
 1) Ajustes > Apps > Termux > Bateria > "Sem restrições".
 2) Deixe o celular carregando e no Wi-Fi.
 3) Puxe a notificação do Termux e toque em "Acquire wakelock".
MSG
