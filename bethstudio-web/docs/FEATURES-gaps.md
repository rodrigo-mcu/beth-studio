# Gaps de ferramentas (open-source, Windows-first)

Beth Studio / Beth Studio focam em **terminais e ferramentas robustas no
Windows** (depois Linux/macOS), não em SaaS agentic tipo Warp.

## Senhas SSH

Metadados em `%APPDATA%\bethstudio\ssh-hosts.json`. Senha e frase-senha da
chave ficam em `%APPDATA%\bethstudio\secrets.dat` cifrados com **DPAPI** do
Windows (`ssh.pw.<id>` / `ssh.pp.<id>`). A API só expõe
`has_password` / `has_passphrase`.

## SFTP (P0 feito em 2026-09-26)

- Janela OS separada: `bethstudio-web.exe --sftp <hostId>` ou ícone pasta
  no header de um terminal SSH (host salvo) / botão “Janela SFTP”.
- Dual-pane Local | Remoto + filas Upload/Download com progresso.
- Painel embutido na tela SSH/Serial permanece como atalho rápido.

## Menu do terminal (Studio)

Copiar / salvar histórico completo (via bridge `scrollback`) e print
(copiar/salvar imagem do viewport xterm).

## Ainda em backlog (não bloqueiam o P0)

| Área | Notas |
|---|---|
| Port forwarding / túneis | Bitvise, Moba |
| ProxyJump / bastion | OpenSSH, Termius |
| Agent forwarding UI | Bitvise |
| Snippets / macros | Termius, Moba |
| SFTP drive (letra) | Bitvise — depois |
| Sync de pastas / resume SFTP v6 | depois |
| X11 / RDP / VNC embutidos | Fora de escopo |
| Sync de hosts na nuvem | Não (local-first) |
| Linux / macOS builds | Roadmap pós-Windows |
