# Instalar servidor (VPS): roteiro de teste manual

Spec: `docs/superpowers/specs/2026-10-18-instalador-servidor-vps-design.md`.

## O que os testes automáticos cobrem e o que não

Cobrem (sem rede): validação de domínio/host/usuário, cliente da API v4 da Cloudflare contra um servidor HTTP falso, SSH com servidor falso em loopback (impressão digital, execução, SFTP), todo o fluxo contra um "VPS" simulado (servidor limpo, sujo, distro/arquitetura não suportada, falha no meio e retomada, DNS existente de outra pessoa, sudo com senha, remover, atualizar), ausência de segredos em eventos, erros e disco, e o bloqueio das rotas no Studio remoto e no celular.

**Não** foram testados de verdade: um VPS real (apt, Caddy, ufw, systemd, `ss`), a API real da Cloudflare, o Let's Encrypt, a propagação de DNS e o acesso pelo celular.

## O que você precisa

- Um VPS Debian 12 ou Ubuntu 24.04 **recém-criado**, com IP público e acesso root (senha ou chave). Dica: peça um que você possa destruir depois.
- Um domínio na Cloudflare e um token de API só com **Zone → DNS → Edit** e **Zone → Zone → Read** (escopo: só aquela zona).
- Um Studio construído com `bethstudio-web\build.ps1` (ele embute o `bethstudio-proxy` para Linux). Rode isolado, como manda o `AGENTS.md`, se não quiser tocar no seu Studio do dia a dia.

## Roteiro (cerca de 15 minutos)

1. **Configurações → Celular → Instalar servidor.** Cole o token e clique em *Verificar e listar zonas*. Esperado: a zona aparece. Teste também um token errado (mensagem sem o token) e um token sem a permissão de DNS (mensagem citando *Zone → DNS → Edit* quando for criar o registro).
2. Escolha a zona, o subdomínio (`agentes`) e **Somente DNS**. Em *Servidor*, IP, usuário e senha. Clique em *Conectar e ver a impressão digital*.
3. Compare a impressão digital com a do painel do provedor (ou, no VPS: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Marque a confirmação.
4. Defina a senha do celular e clique em *Ver o que será feito*: confira os comandos. Clique em **Instalar**.
5. Esperado: todos os passos com ✓, QR code e "Ligação PC ↔ servidor: no ar". No celular, abra `https://agentes.seudominio` (cadeado válido) e entre com a senha.
6. No VPS: `systemctl status bethstudio-proxy caddy`, `ufw status` (só 22, 80, 443), `ss -ltnp | grep -E ':(80|443|8787)'`. O `bethstudio-proxy` escuta só em `127.0.0.1:8787`.
7. **Idempotência:** rode o assistente de novo com os mesmos dados. Esperado: "já é esta versão", "já foi instalado por este assistente", registro DNS "igual"; nada duplicado na Cloudflare.
8. **Retomada:** no VPS, `systemctl stop caddy` e `rm /etc/caddy/Caddyfile`, e rode de novo: ele reaplica.
9. **Servidor sujo:** num segundo VPS, instale `nginx` (ou rode algo na porta 80) e rode o assistente. Esperado: para no passo *Verificar o servidor* explicando a porta/serviço, sem criar DNS nem alterar o servidor.
10. **Registro DNS alheio:** crie à mão, na Cloudflare, um registro A para o subdomínio e rode. Esperado: para no passo *DNS* dizendo que não foi criado pelo assistente, e não o altera.
11. **Impressão digital alterada:** reinstale o VPS (ou apague as chaves em `/etc/ssh/ssh_host_*` e reinicie o sshd) e refaça: a tela deve alertar que **mudou** e exigir confirmação específica.
12. **Nuvem laranja (opcional):** refaça com *Com proxy*. Com a zona em *Full (strict)* deve funcionar; em *Flexible* o teste final deve falhar com a dica sobre Full (strict).
13. **Atualizar / Ver estado / Ver logs / Trocar senha do celular:** cada um pede as credenciais de novo (o Studio não guarda), exceto trocar a senha, que é local. *Atualizar* diz "já tem a versão mais nova" se for o mesmo binário.
14. **Remover o servidor** (com o token): esperado: serviço, programa e dados do proxy removidos; Caddyfile do Beth trocado por um vazio; o registro DNS do assistente apagado e os outros intactos; pareamento deste Studio limpo.
15. Confirme que nada secreto foi gravado: `%APPDATA%\bethstudio\vps-server.json` e `vps-hostkeys.json` não têm senha, token nem segredo; procure a senha e o token no `bethstudio-web.log`.

## Se algo falhar

A tela mostra o passo e o erro. O log do servidor está em *Ver logs* (`journalctl -u bethstudio-proxy` e `-u caddy`). Problemas esperados no mundo real: apt travado por `unattended-upgrades` recém-instalado (aguarde e repita), DNS ainda propagando (o teste final espera ~2 minutos), limite do Let's Encrypt se você repetir muitas vezes o mesmo domínio.
