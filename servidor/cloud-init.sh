#!/bin/bash
# Cole este texto no campo "cloud-init" ao criar a máquina na Oracle Cloud.
# A máquina instala o REVELA sozinha no primeiro boot (leva uns 5 minutos).
curl -fsSL https://raw.githubusercontent.com/danandxxy-ship-it/revela/main/servidor/instalar.sh | bash
