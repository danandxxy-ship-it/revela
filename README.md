# REVELA — laboratório de vídeo

Você envia um vídeo do seu aparelho ou cola um link (YouTube, Instagram, TikTok, X, link .mp4/.m3u8…), e o REVELA devolve um **link MP4 direto**, tipo `https://seusite/v/Ab12Cd34Ef.mp4`, que toca em qualquer navegador, player, bot ou tag `<video>`.

## O que ele faz de verdade (tudo testado)
- **Sem limite fixo de tamanho.** O envio vai em pedaços de 8 MB, 3 ao mesmo tempo, cada um conferido com SHA-256. O limite real é o espaço livre do servidor, e o site mostra quanto há. Testado com um arquivo de 3,8 GB: chegou idêntico byte a byte.
- **Não perde o envio.** Se a internet cair, ele espera e continua sozinho. Se fechar a página ou o servidor reiniciar, é só escolher o mesmo arquivo de novo: ele continua de onde parou.
- **Conversão inteligente:**
  - H.264 + AAC: só reorganiza o arquivo, em segundos, sem perder qualidade.
  - H.264 com áudio AC3/Opus/DTS: converte só o áudio e mantém a imagem original.
  - HEVC, VP9, AV1, 10 bits, AVI antigo, WMV…: converte para H.264 + AAC (até 1080p no maior lado, vertical ou horizontal).
  - Vídeo girado do celular continua em pé.
  - Arquivo cortado ou incompleto: recupera o pedaço que dá para assistir e avisa.
  - Arquivo que não é vídeo (ou só tem áudio): recusa com mensagem clara.
- **Todo MP4 sai com `faststart`:** começa a tocar na hora e dá para pular para qualquer ponto (Range/206). Também libera acesso de outros sites (CORS).
- **Links via yt-dlp**, atualizado todo dia, com o Node fazendo os desafios de JavaScript que o YouTube exige desde 2025. Se um vídeo falhar, a mensagem diz o motivo em português (privado, ao vivo, bloqueado, pediu login, 404…).
- **Fila que sobrevive a reinício:** se o servidor cair no meio de uma conversão, ele retoma sozinho.
- **Vários arquivos e vários links de uma vez**, cada um com o próprio progresso.
- **App no celular:** instale pelo navegador e o REVELA aparece no menu *Compartilhar* do YouTube, Instagram e TikTok.
- **Sem senha.** Só o aparelho que criou um link consegue apagar o vídeo.

## Colocar no ar de graça (Oracle Cloud, sem PC)
Dá para fazer tudo pelo navegador do celular.

1. **Crie a conta** em oracle.com/cloud/free. Ela pede cartão só para verificar. Escolha a região **Brazil East (São Paulo)** ou **Brazil Southeast (Vinhedo)**, porque ela não muda depois.
2. **Crie a máquina:** menu ☰ → *Compute* → *Instances* → *Create instance*.
   - **Image:** Canonical **Ubuntu 24.04**
   - **Shape:** *Ampere* → **VM.Standard.A1.Flex**, **2 OCPU e 12 GB**. É o máximo grátis desde 2026. Se der "Out of capacity", tente outro *Availability domain* ou volte mais tarde.
   - **Networking:** deixe criar a rede nova, com **IP público** ligado.
   - **SSH keys:** *Generate a key pair* e baixe a chave. Não é obrigatório usar, mas guarde.
   - **Boot volume:** marque *Specify a custom boot volume size* e coloque **150 GB**. Esse é o espaço para os vídeos.
   - **Show advanced options → Management → cloud-init script:** cole o conteúdo de `servidor/cloud-init.sh`, que são estas linhas:
     ```
     #!/bin/bash
     curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/instalar.sh | bash
     ```
   - Clique em **Create**.
3. **Abra as portas 80 e 443** (sem isso o site não abre de fora): na página da máquina, clique na **Subnet** → *Security Lists* → *Default Security List* → **Add Ingress Rules**:
   - *Source CIDR:* `0.0.0.0/0` · *IP Protocol:* TCP · *Destination Port Range:* `80,443` → **Add**
4. **Espere uns 5 minutos** e abra no navegador `http://IP-DA-MÁQUINA`. Ele leva sozinho para o endereço fixo com HTTPS, que é o IP com traços: `https://129-146-7-88.sslip.io`. Esse é o seu site, e os links dos vídeos usam esse endereço para sempre.

### Depois de instalado
- **Atualizar o REVELA:** no terminal da máquina (*Cloud Shell* ou SSH), rode `revela-atualizar`. Os vídeos não se perdem.
- **Ver o que está acontecendo:** `journalctl -u revela -f`
- **Usar um domínio seu:** aponte o domínio para o IP e rode `DOMINIO=videos.seusite.com revela-atualizar`. O certificado sai sozinho.
- **Apagar vídeos antigos automaticamente:** `DIAS_EXPIRAR=30 revela-atualizar`.

### Bom saber
- A Oracle pode **recuperar máquinas grátis que ficam ociosas** por muito tempo. Se você usar pouco, converter a conta para *Pay As You Go* evita isso e continua sem cobrança enquanto ficar dentro dos limites grátis. Confira as regras atuais da Oracle antes.
- O YouTube às vezes bloqueia IPs de servidores na nuvem ("confirme que não é um robô"). Para resolver, envie um `cookies.txt` em **Ajustes e ajuda** no próprio site.
- Conversão pesada usa CPU: um filme de 2 h que precisa recodificar leva bastante tempo em 2 núcleos. Vídeos que já são H.264 ficam prontos em segundos.
- Use com vídeos seus ou que você tem direito de baixar.

## Rodar em outro servidor Linux
Qualquer VPS Ubuntu/Debian (x64 ou ARM): `curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/instalar.sh | sudo bash`

## Configuração (arquivo `/etc/revela.env`)
| Variável | Padrão | O que faz |
|---|---|---|
| `URL_PUBLICA` | automático | Endereço usado nos links gerados |
| `DIAS_EXPIRAR` | `0` | Apaga vídeos após N dias (0 = nunca) |
| `MAX_LADO` | `1920` | Maior lado ao recodificar (0 = mantém o original) |
| `CRF` / `PRESET` | `21` / `veryfast` | Qualidade e velocidade do H.264 |
| `CONVERSOES_SIMULTANEAS` | `1` | Conversões ao mesmo tempo |
| `DOWNLOADS_SIMULTANEOS` | `2` | Downloads de links ao mesmo tempo |
| `RESERVA_GB` | `1` | Espaço que nunca é usado (protege o sistema) |

Depois de mudar: `sudo systemctl restart revela`.


## Opção celular Android (Termux)

Sem VPS e sem cartão: um Android velho, no Wi-Fi e carregando, vira o servidor.

1. Instale o **Termux pelo F-Droid** (não pela Play Store, que está desatualizada) e, se quiser ligar sozinho após reiniciar, o **Termux:Boot** (também F-Droid).
2. No Termux: `pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/termux.sh | bash`
3. `revela-ligar` mostra o endereço público (`https://….trycloudflare.com`).
4. Ajustes do Android > Apps > Termux > Bateria > Sem restrições.

Limites honestos: o endereço do túnel grátis **muda quando o servidor reinicia** (links já gerados deixam de abrir), o armazenamento é o do celular, e os termos da Cloudflare restringem servir vídeo pela rede deles. Para links permanentes use VPS com domínio próprio.
