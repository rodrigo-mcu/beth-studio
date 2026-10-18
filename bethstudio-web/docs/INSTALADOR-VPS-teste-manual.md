# Instalar servidor (VPS): roteiro de teste manual

Spec: `docs/superpowers/specs/2026-10-18-instalador-servidor-vps-design.md` (com a revisão: sem Caddy).

O servidor recebe **um único programa**, o `bethstudio-proxy`, que atende HTTPS sozinho nas portas 80 e 443 e obtém e renova o certificado Let's Encrypt. Não há Caddy, nginx, repositório apt extra nem chave GPG.

## O que os testes automáticos cobrem e o que não

Cobrem (sem rede): validação de domínio/host/usuário, cliente da API v4 da Cloudflare contra um servidor HTTP falso, SSH com servidor falso em loopback, todo o fluxo contra um "VPS" simulado (servidor limpo, sujo, outro servidor web ou Caddy nas portas, usuário `bethstudio` alheio, distro/arquitetura não suportada, falha no meio e retomada, certificado demorado ou que não sai, reinstalar sem duplicar, DNS existente de outra pessoa, sudo com senha, nuvem laranja recusada, remover, atualizar), ausência de segredos em eventos, erros e disco; e, no proxy, o modo `-tls` com certificado autoassinado (redirecionamento 80→443, HSTS, TLS ≥ 1.2, sem h2, WebSocket do celular e ligação do PC sobre TLS, IP do cliente sem confiar em `X-Forwarded-For`, `HostPolicy` só aceita o domínio, cache em disco 0700, unit systemd com usuário dedicado). Os testes do proxy também foram executados num Linux (WSL Debian).

**Não** foram testados de verdade: a **emissão real** do certificado (Let's Encrypt, produção ou staging), o **bind nas portas 80/443 com `CAP_NET_BIND_SERVICE`** como usuário `bethstudio` num systemd real, um VPS real (apt, ufw, `ss`), a API real da Cloudflare, a propagação de DNS e o acesso pelo celular. É isto que este roteiro cobre.

## O que você precisa

- Um VPS Debian 12 ou Ubuntu 24.04 **recém-criado**, com IP público, acesso root (senha ou chave) e as portas **80 e 443 liberadas no firewall do provedor** (painel do provedor, fora do servidor). Dica: um que você possa destruir depois.
- Um domínio na Cloudflare e um token de API só com **Zone → DNS → Edit** e **Zone → Zone → Read** (escopo: só aquela zona).
- Um Studio construído com `bethstudio-web\build.ps1` (ele embute o `bethstudio-proxy` para Linux). Rode isolado, como manda o `AGENTS.md`, se não quiser tocar no seu Studio do dia a dia.

## Roteiro (cerca de 15 minutos)

1. **Configurações → Celular → Instalar servidor.** Cole o token e clique em *Verificar e listar zonas*. Esperado: a zona aparece. Teste também um token errado (mensagem sem o token) e um token sem a permissão de DNS (mensagem citando *Zone → DNS → Edit* ao criar o registro).
2. Escolha a zona e o subdomínio (`agentes`). A tela explica que o registro é **somente DNS (nuvem cinza)**; não existe a opção de nuvem laranja. Em *Servidor*, IP, usuário e senha. Clique em *Conectar e ver a impressão digital*.
3. Compare a impressão digital com a do painel do provedor (ou, no VPS: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Marque a confirmação.
4. Defina a senha do celular e clique em *Ver o que será feito*: confira os comandos (não deve haver Caddy, `apt-get update`, `curl` nem `gpg`). Clique em **Instalar**.
5. Esperado: passos com ✓ (conectar, verificar, DNS, proxy, firewall, atualizações, **certificado**, parear, teste), QR code e "Ligação PC ↔ servidor: no ar". No celular, abra `https://agentes.seudominio` (cadeado válido) e entre com a senha. O passo do certificado pode levar de segundos a alguns minutos.
6. No VPS (conferir o que só um servidor real mostra):
   - `systemctl status bethstudio-proxy` ativo; `ps -o user,cmd -C bethstudio-proxy` mostra o usuário **`bethstudio`**, não root.
   - `ss -ltnp | grep -E ':(80|443)'`: o `bethstudio-proxy` nas duas portas (prova do `CAP_NET_BIND_SERVICE`). Nada em 8787.
   - `ls -ld /var/lib/bethstudio-proxy /var/lib/bethstudio-proxy/certs` e `ls -l /var/lib/bethstudio-proxy/certs`: pastas `drwx------ bethstudio`, arquivo do domínio `-rw-------`.
   - `ufw status`: só SSH, 80 e 443. `systemctl cat bethstudio-proxy`: `User=bethstudio`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/bethstudio-proxy`.
   - `dpkg -l | grep -i caddy` e `ls /etc/apt/sources.list.d` não mostram nada do Beth.
7. De fora do servidor: `curl -sI http://agentes.seudominio/` deve responder **308** com `Location: https://agentes.seudominio/`; `curl -sI https://agentes.seudominio/` traz `Strict-Transport-Security: max-age=15552000` (sem `includeSubDomains`) e `X-Content-Type-Options: nosniff`; `curl -sI --http2 https://agentes.seudominio/` fica em HTTP/1.1 (h2 desligado de propósito). `openssl s_client -connect agentes.seudominio:443 -tls1_1` deve falhar.
8. **WebSocket:** com o celular ligado, abra um agente e confirme que o terminal responde (usa `/ws` sobre TLS) e que a ligação do PC não cai (Studio mostra "no ar").
9. **Limite de tentativas:** erre a senha do celular mais de 20 vezes em 1 minuto. Esperado: HTTP 429. Depois, de **outro** IP (4G do celular, por exemplo), o login ainda funciona (o limite é por IP da conexão). Tentar forjar o IP com `curl -H 'X-Forwarded-For: 1.2.3.4'` não deve ajudar.
10. **Idempotência:** rode o assistente de novo com os mesmos dados. Esperado: "já é esta versão", registro DNS "igual", certificado já presente; nada duplicado na Cloudflare. As portas 80/443 ocupadas pelo nosso próprio `bethstudio-proxy` não contam como "servidor sujo".
11. **Retomada:** no VPS, `systemctl stop bethstudio-proxy` e rode de novo: ele reaplica o serviço.
12. **Servidor sujo:** num segundo VPS, instale `nginx` (ou `caddy`, ou qualquer coisa na porta 80/443) e rode o assistente. Esperado: para em *Verificar o servidor* explicando a porta/serviço, sem criar DNS nem alterar o servidor.
13. **Registro DNS alheio:** crie à mão, na Cloudflare, um registro A para o subdomínio e rode. Esperado: para em *DNS* dizendo que não foi criado pelo assistente, sem alterá-lo.
14. **Certificado que não sai (opcional):** num VPS com a porta 80 bloqueada no firewall do provedor, rode. Esperado: para em *Certificado HTTPS* com as últimas linhas do log do serviço e a dica de conferir DNS e portas; o serviço continua tentando sozinho (1, 3, 8, 15, 30 min). Libere a porta e rode o assistente de novo.
15. **Ensaio sem gastar limite do Let's Encrypt:** em um servidor de teste, no VPS, edite a unit para acrescentar `-acme-staging` ao `ExecStart` e reinicie; o certificado sai do ambiente de testes (o navegador reclama, e o HSTS **não** é enviado em staging). Volte ao normal depois (reinstale ou remova a opção). O assistente do Studio não expõe essa opção.
16. **Impressão digital alterada:** reinstale o VPS (ou apague `/etc/ssh/ssh_host_*` e reinicie o sshd) e refaça: a tela deve alertar que **mudou** e exigir confirmação específica.
17. **Nuvem laranja:** não há mais essa opção. (Se você marcar a nuvem laranja à mão na Cloudflare depois, o desafio do certificado e a renovação podem falhar; volte para cinza.)
18. **Atualizar / Ver estado / Ver logs / Trocar senha do celular:** cada um pede as credenciais de novo (o Studio não guarda), exceto trocar a senha, que é local. *Atualizar* diz "já tem a versão mais nova" se for o mesmo binário. Os certificados são mantidos na atualização.
19. **Remover o servidor** (com o token): esperado: serviço, programa, dados do proxy (inclui os certificados) e o usuário `bethstudio` removidos (`id bethstudio` falha); o registro DNS do assistente apagado e os outros intactos; pareamento deste Studio limpo. O ufw e as portas abertas continuam.
20. Confirme que nada secreto foi gravado: `%APPDATA%\bethstudio\vps-server.json` e `vps-hostkeys.json` não têm senha, token nem segredo; procure a senha e o token no `bethstudio-web.log`.

## Se algo falhar

A tela mostra o passo e o erro. O log do servidor está em *Ver logs* (`journalctl -u bethstudio-proxy`). Problemas esperados no mundo real: apt travado por `unattended-upgrades` recém-instalado (aguarde e repita); DNS ainda propagando (o teste final espera ~2 minutos; o serviço repete o pedido do certificado sozinho); portas 80/443 bloqueadas no firewall do **provedor** (o `ufw` do servidor não enxerga isso); limite do Let's Encrypt (5 falhas por hora por domínio; use o ensaio em staging do passo 15).
