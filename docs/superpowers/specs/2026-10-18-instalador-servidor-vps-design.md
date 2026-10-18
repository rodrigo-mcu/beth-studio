# Assistente "Instalar servidor" (VPS limpo + Caddy + Cloudflare)

Data: 2026-10-18. Estado: **proposta implementada** (plano em `docs/superpowers/plans/2026-10-18-instalador-servidor-vps.md`). Roteiro de teste real: `bethstudio-web/docs/INSTALADOR-VPS-teste-manual.md`.

## 1. Problema

Hoje o `bethstudio-proxy` é instalado à mão, "atrás do proxy HTTPS que a pessoa já tem" (nginx etc.). Quem não tem servidor pronto precisa de terminal, DNS, certificado e JSON. O assistente cobre o outro caso: **VPS Linux limpo e dedicado**, com Caddy (HTTPS automático), DNS na Cloudflare e o Studio deste PC já pareado. O modo antigo não muda.

## 2. Decisões

| Tema | Decisão | Por quê |
| --- | --- | --- |
| Proxy HTTPS | **Caddy**, do repositório oficial (apt, Cloudsmith) | Let's Encrypt, redirect HTTP→HTTPS e WebSocket sem configuração extra (doc oficial: caddyserver.com/docs/install). |
| Binário do proxy | **Embutido no Studio** (`go:embed`), linux/amd64 e linux/arm64, com `SHA256SUMS` gerado no build. | Funciona offline e não confia em download. Cada binário é conferido por SHA-256 no servidor depois do envio. Custo: ~2x6 MB no exe. |
| Envio | SFTP (`github.com/pkg/sftp`, já no go.mod) | Sem dependência nova; `golang.org/x/crypto/ssh` também já existe. |
| Host key | TOFU explícito: a tela mostra o SHA256 da chave e a pessoa confirma; o fingerprint confirmado vai no pedido e é **exigido** na conexão. Guardado em `vps-hostkeys.json` (não é segredo). Fingerprint alterado = bloqueio, só segue com confirmação específica. Nunca `InsecureIgnoreHostKey`. | Requisito de segurança. |
| DNS Cloudflare | **Padrão: "somente DNS" (nuvem cinza).** "Proxied" é opção, com aviso. | Com a nuvem cinza o certificado do Caddy (HTTP-01) e o WebSocket não dependem do modo SSL da zona. Com a nuvem laranja a zona precisa estar em **Full (strict)** (doc: developers.cloudflare.com/ssl/origin-configuration/ssl-modes), senão o redirecionamento entra em laço (Flexible); o token mínimo não altera a zona, então o assistente só avisa e o teste final aponta o sintoma. |
| Registro DNS "do assistente" | Criado com `comment = "bethstudio-wizard"`. Só registros com esse comentário são atualizados/removidos. Registro A/AAAA existente **sem** o comentário: para e explica; não toca. | "Nunca outros registros". |
| Segredos | Senha SSH, passphrase, chave privada e token Cloudflare ficam **só em memória** durante o trabalho; o job zera os campos ao terminar; todo texto emitido passa por um redator que troca os segredos por `***`. Não há cofre: **ações posteriores (atualizar, remover, logs) pedem as credenciais de novo.** | Menos superfície; o Credential Manager/DPAPI do projeto guarda chaves de provedor, mas guardar acesso root de um servidor seria um risco sem ganho claro. |
| O que fica em disco | `vps-server.json` (host, porta, usuário, domínio, zona, id dos registros, fingerprint, modo proxied, sha do binário). Sem segredos. | Alimenta atualizar/remover. |
| Código de pareamento | Lido de `/var/lib/bethstudio-proxy/link-secret` por SSH (sudo) e aplicado com a mesma rotina de `POST /api/phone/setup`. Nunca vai para log nem para a resposta. | O PC fica pareado sem copiar e colar. |
| Rotas | `POST /api/vps/*` (mais `GET` do estado/job). Entram em `remoteOnlyOnPC` (Studio remoto bloqueia) e não existem em `servePhoneAuthed` (celular recebe 404). | Só a interface local. |
| Comandos remotos | Fixos, escritos em `vpsinstall/script.go`. Só valores validados (domínio, porta, usuário) entram; arquivos (Caddyfile) vão por SFTP, não por shell. | Sem injeção. |

## 3. Passos (idempotentes e retomáveis)

1. **Conexão e fingerprint** (feita na tela antes de iniciar).
2. **Verificação do servidor**: `/etc/os-release` (Debian 11/12/13, Ubuntu 22.04/24.04/26.04), `uname -m` (x86_64/aarch64), root ou `sudo -n`, portas 80/443 livres (exceto Caddy do próprio assistente, reconhecido pelo marcador `# bethstudio-managed` no Caddyfile), sem nginx/apache2/docker-proxy/Caddy alheio. Qualquer problema: **para e explica; não apaga nada**.
3. **DNS** (A, e AAAA se o host for IPv6) via API v4: `/user/tokens/verify`, `/zones`, `/zones/{id}/dns_records`.
4. **Instalação**: envio do binário + SHA-256; `-service` (unit systemd existente); Caddy; `/etc/caddy/Caddyfile` com HSTS e `nosniff`; ufw (libera a porta SSH **antes** de ativar, depois 80/443); `unattended-upgrades` (opção, ligada por padrão, sem reinício automático).
5. **Pareamento**: lê o código, grava no Studio, define a senha do celular.
6. **Teste de ponta a ponta**: DNS resolve, HTTPS com certificado válido, proxy responde, ligação PC↔servidor "up".
7. Fim: endereço, **QR code**, estado.

Desfazer: para e remove o serviço e o binário, troca o Caddyfile por um inerte e recarrega o Caddy, apaga **só** os registros DNS que o assistente criou. Não desinstala Caddy/ufw/pacotes nem fecha portas (avisa). Ações extras: atualizar binário, ver estado/logs, trocar senha do celular, remover.

## 4. Fora do escopo / riscos conhecidos

- Não foi possível testar contra VPS, Cloudflare nem Let's Encrypt reais (ver roteiro manual).
- A chave GPG do Caddy é baixada por HTTPS do Cloudsmith, como a doc oficial manda; não há fingerprint fixo no assistente.
- O serviço `bethstudio-proxy` continua rodando como root (a unit existente não muda; modo antigo preservado).
