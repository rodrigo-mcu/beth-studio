# Instalar servidor (VPS) — Plano de implementação

> **Revisão (2026-10-18, decisão do dono):** o Caddy foi removido; o `bethstudio-proxy` atende HTTPS sozinho (`-tls`). As tarefas abaixo que citam Caddy/Caddyfile foram substituídas por: usuário de serviço, unit em modo `-tls`, espera do certificado. Veja a nota no spec.

**Spec:** `docs/superpowers/specs/2026-10-18-instalador-servidor-vps-design.md`
**Stack:** Go (`bethstudio-web/vpsinstall`), React/TS (`frontend/src/components/VpsInstallWizard.tsx`), `go test`, `node --test`.

Regras: sem push/tag/release; não instalar em `C:\Users\Public\BethStudio`; não tocar processos do usuário; nada de conexão real (SSH/Cloudflare). Textos de interface em pt-BR.

- [x] Task 1 — `vpsinstall/validate.go`: domínio, host, usuário, porta (TDD).
- [x] Task 2 — `vpsinstall/cloudflare.go`: cliente v4 + interface; httptest (token sem permissão, zona inexistente, registro alheio, atualização do próprio).
- [x] Task 3 — `vpsinstall/sshconn.go`: probe de fingerprint, `Remote` sobre x/crypto/ssh + sftp, known hosts; servidor SSH falso nos testes.
- [x] Task 4 — `vpsinstall/preflight.go` + `script.go`: parsing de os-release/ss/arch, comandos fixos, Caddyfile.
- [x] Task 5 — `vpsinstall/install.go`: orquestração, eventos, redator de segredos, desfazer, atualizar, estado/logs.
- [x] Task 6 — binários embutidos (`vpsinstall/bins`, `build.ps1`, `SHA256SUMS`).
- [x] Task 7 — `vps_api.go` + rotas + bloqueio no Studio remoto; testes de rota.
- [x] Task 8 — frontend: wizard, testes `node --test` da lógica pura.
- [x] Task 9 — docs: wiki, FEATURES, CHANGELOG, roteiro manual.
- [x] Task 10 — `go vet`, `go test` (exceto o que mexe no host), `tsc`, `npm test`.
