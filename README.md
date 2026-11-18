# REVELA — laboratório de vídeo

Manda qualquer vídeo (de qualquer tamanho) ou cola um link (YouTube, Instagram, TikTok, X, Vimeo, link .mp4/.mkv/.m3u8…) e recebe um **link MP4 direto**, tipo `https://seusite/v/Ab12Cd34Ef.mp4`, que toca no navegador, no VLC, em player de site, em bot, no Highrise etc.

## Como funciona
- **Envio em pedaços de 8 MB** — não tem limite de tamanho, passa por Cloudflare/nginx, e se a internet cair ele continua de onde parou (é só escolher o mesmo arquivo de novo).
- **Conversão inteligente**: se o vídeo já é H.264 + AAC, ele só reorganiza o arquivo (segundos, sem perder qualidade). Se for HEVC, VP9, AV1, MKV, AVI etc., converte para H.264 + AAC (toca em qualquer navegador/celular), até 1080p.
- **`faststart`** em todo arquivo: o vídeo começa a tocar na hora, sem baixar tudo.
- **Range/206**: dá pra pular para qualquer ponto do vídeo.
- **Links** via `yt-dlp` (atualizado sozinho a cada início).
- Histórico dos seus links fica salvo no aparelho.
- Atalho: `https://seusite/?url=LINK` já abre com o link preenchido.

## Opção 1 — Rodar no seu PC Windows (grátis, mais fácil)
1. Extraia o zip numa pasta.
2. Abra `iniciar-windows.bat`.
3. Ele instala Node, FFmpeg, yt-dlp e Cloudflare Tunnel sozinho, liga o servidor e mostra um link `https://xxxx.trycloudflare.com` — esse é o seu site, funciona de qualquer lugar.

Limite: o site e os links só funcionam enquanto o PC estiver ligado, e o endereço `trycloudflare` muda a cada vez que abre. Para endereço fixo, use um túnel nomeado do Cloudflare com seu domínio.

## Opção 2 — Servidor/VPS 24h (Docker)
```bash
docker compose up -d --build
```
Abra `http://IP-DO-SERVIDOR:8080`. Os vídeos ficam em `./data`. Coloque atrás de um domínio (Cloudflare ou Caddy) para ter HTTPS.

Boas opções: Oracle Cloud Free (VPS grátis com 200 GB), Hetzner, Contabo. Plataformas tipo Vercel/Netlify **não servem** (não rodam FFmpeg nem guardam arquivo grande).

## Configuração (variáveis de ambiente)
| Variável | O que faz |
|---|---|
| `DIAS_EXPIRAR` | Apaga vídeos depois de N dias (0 = nunca). |
| `URL_PUBLICA` | Força o domínio usado nos links gerados (ex.: `https://videos.seudominio.com`). |
| `DATA_DIR` | Pasta onde ficam os vídeos. |
| `YTDLP_COOKIES` | Caminho de um `cookies.txt` — resolve quando o YouTube pede "confirme que não é um robô" ou vídeos com restrição de idade. |
| `PORT` | Porta (padrão 8080). |

## Avisos
- O site não tem senha: qualquer pessoa com o endereço pode enviar vídeos. Use `DIAS_EXPIRAR` se quiser evitar que o disco encha.
- YouTube às vezes bloqueia IPs de servidores de nuvem; no PC de casa quase nunca acontece. Se acontecer na VPS, use `YTDLP_COOKIES`.
- Baixar vídeo do YouTube vai contra os termos de uso dele; use com vídeos seus ou que você tem direito de usar.
- Converter um vídeo longo que precisa recodificar usa bastante CPU (um filme de 2h pode levar de 20 a 60 min numa VPS pequena). Vídeos que já são H.264 ficam prontos em segundos.
