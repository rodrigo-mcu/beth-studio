# Studio como supervisor do host, sem a GUI nativa

Data: 2026-10-03. Estado: desenho aprovado em conversa, aguardando revisão deste spec.
Repositório de trabalho: este (`beth-studio`). O repositório antigo fica intacto como backup.

## Objetivo

Hoje o `bethterm-gui.exe` (pacote `wezterm-gui`) desenha a janela nativa e, além
disso, faz quatro trabalhos que o Beth Studio não faz: sobe e vigia o host, é dono
da bandeja, recupera o host se ele cair e restaura os terminais depois de uma
queda. Como a interface agora é o Studio (Go + React), queremos **retirar a GUI
nativa** e deixar só o host (`bethterm-host.exe`), a bridge (`bethterm.exe cli
bridge`) e o Studio. Para isso o Studio assume os quatro trabalhos.

Critérios de sucesso:

1. Abrir o Studio sem host rodando sobe o host e mostra os terminais; fechar a janela
   do Studio esconde na bandeja e **não** encerra nada.
2. Se o host cair, o Studio o reinicia (no máximo 3 vezes em 10 minutos) e recria os
   terminais nas mesmas abas e posições, cada um na sua pasta.
3. Terminais WSL só são abertos depois que a distro responde, o comando de
   inicialização opcional da distro rodou e a pasta existe; se a pasta não aparecer,
   o terminal abre na home, nunca em `/` nem na pasta do Windows.
4. O Studio nunca para o host sem pedido explícito e confirmado do usuário.
5. A GUI nativa, o `window` e o `wtinator-config` saem do build e do instalador, e
   `UPSTREAM_DIFF.patch` encolhe de acordo.

## Fora do escopo

- Reescrever o host ou o emulador de terminal (ver análise: o host continua sendo o motor).
- Mouse dentro de programas de terminal e imagens no Studio (exigem enviar bytes crus; é outra decisão).
- Iniciar o Studio junto com o Windows.
- Studio remoto e celular: continuam como estão.

## Decisões já tomadas

- Quem supervisiona: **o próprio Studio** (um processo só: interface, bandeja e supervisão).
- Fechar a janela do Studio esconde na bandeja; só **Sair da bandeja** fecha o processo.
- A regra "o Studio nunca inicia o host" muda para "o Studio pode **iniciar** o host; só **para** com **Encerrar tudo** confirmado".

## Fases

Cada fase é entregável sozinha e nenhuma toca o host em uso.

### Fase A — Studio supervisor (Go)

**Subir o host** (`hostctl_windows.go`):
- `hostRunning()`: abre o mutex `Local\BethTermHost`; existe, está rodando.
- `startHost()`: executa `bethterm-host.exe` ao lado do próprio exe, desanexado e sem
  console, com `BETHTERM_ACTIVE=1` e `WTINATOR_ACTIVE=1`; espera até 8 s pelo mutex e
  por `%APPDATA%\bethterm\host.sock`.
- Cada start, falha e decisão vai para `%APPDATA%\bethterm\host-life.log`, com a origem `studio`.

**Vigiar e recuperar** (`supervisor.go`, uma goroutine a cada 2 s):
- Se o host não está rodando e ninguém pediu para encerrar, inicia; limite de 3 reinícios
  em 10 minutos (`restartLimiter`, função pura testável). Passado o limite, o Studio mostra
  "Host indisponível" com o botão **Tentar de novo** e não insiste sozinho.
- Reinício vazio (host sem terminais) dispara a restauração da Fase A2.

**Encerrar tudo** (`hostctl_windows.go`): só depois de confirmação que diz quantos
terminais serão fechados. Sinaliza o evento `Local\BethTermHostQuit`, grava
`host.quit-request` com o solicitante "Studio (confirmado)", espera 5 s e só então usa o
pid file. Nunca é chamado automaticamente.

**Bandeja em Go** (`tray_windows.go`): ícone no relógio numa thread própria com laço de
mensagens (a thread principal já é do WebView2). Reaproveita as lições do Rust: reinsere o
ícone em `TaskbarCreated` e por um vigia periódico.
- Menu: **Beth Studio** (negrito, clique abre ou foca), **Novo terminal ▸** (shells da bridge),
  **Sistema**, separador, **Sair da bandeja (terminais continuam)**, **Encerrar tudo (fecha os terminais)**.
- O ícone muda quando há agente esperando (`hub.agents`); a dica mostra terminais e estado do host.

**Esconder na bandeja**: o `WM_CLOSE` da janela principal do Studio vira `SW_HIDE`, a menos
que a saída tenha sido pedida pela bandeja. As janelas destacadas (`--term`) continuam
fechando normalmente. Uma segunda abertura do Studio foca a janela existente (já é assim).

**Uma GUI antiga rodando**: se `bethterm-gui.exe` estiver rodando, o Studio não sobe bandeja
nem supervisão (evita dois supervisores) e registra isso; quando a GUI sair, assume sozinho
(checa a cada 5 s). Isso faz a migração do ambiente atual sem pressa.

### Fase A2 — restaurar terminais depois de uma queda (Go + um patch no bridge)

**Receita de cada terminal** (`pane_specs.go`): a cada evento `list` (debounce de 2 s) e a
cada spawn, o Studio grava `%APPDATA%\bethterm\pane-specs.json` de forma atômica, com, por
terminal vivo: shell, argumentos, pasta atual (já traduzida), tipo (WSL, SSH, serial,
PowerShell…), ferramenta (`kind` + `id` salvo), título, distro e a posição no layout. Substitui o
`session.json` da GUI. Terminais que a GUI antiga abriu usam `pane-commands.json` como fallback.

**Restaurar** (`restore.go`): quando o host volta vazio e há receitas recentes (menos de 7 dias):
1. agrupa por distro e roda o gate do WSL uma vez por distro;
2. recria os terminais na ordem do layout, até 3 em paralelo, com `spawn` / `spawn_tool`;
3. monta o mapa `idAntigo → idNovo` e reaponta o layout (`layout.go`), os nomes
   (`panenames.go`) e as configurações por terminal (`settings.go`) para os ids novos, em
   vez de depender da adoção por título ou pasta;
4. emite `{"ev":"restore","total":N,"done":k,"stage":"…","distro":"…"}` para a interface.

**Gate do WSL** (`wsl_ready.go`, com executor de comandos injetável para teste; todos os
comandos sem janela e com tempo limite):
- `distroRunning(d)`: `wsl -l --running -q` (reaproveita `parseWSLRunningNames`).
- `ensureDistro(d)`: se parada, `wsl.exe -d d --exec true` com tentativas e recuo, até 60 s.
- Inicialização opcional: `%APPDATA%\bethterm\wsl-distros.json`
  (`{"Debian":{"init":"…","user":"root","timeout_sec":60}}`), executada **uma vez por boot da
  VM** (identificada por `/proc/sys/kernel/random/boot_id`).
- `waitDir(d, path)`: `wsl.exe -d d --exec test -d <path>` a cada 1 s, até 30 s; sem sucesso, usa `~`.
- O mesmo gate vale para "Novo terminal" WSL quando a distro está parada.

**Patch 0197 no bridge** (`upstream-wezterm/wezterm/src/cli/bridge.rs`, `spawn_shell`): para
shells cujo `argv[0]` é `wsl.exe` e pasta que começa com `/`, inserir `--cd <pasta>` após o
`argv[0]` e **não** usar `command_dir` do Windows. Hoje a pasta Linux vira diretório do
Windows, é descartada e o terminal abre no lugar errado. Recompila só o `bethterm.exe`, não o host.

**Interface**: a tela de abertura e uma faixa mostram "Aguardando o WSL (Debian)…" e
"Restaurando terminais (3 de 22)…".

### Fase B — retirar a GUI do build e do instalador

- Saem do workspace e da árvore: `wezterm-gui`, `window`, `wtinator-config`, e os módulos só de
  GUI do `wtinator` (bandeja, menu de contexto, barra de título, geometria de janela, temas por
  painel da GUI, e semelhantes). O plano começa por `cargo tree -i` para ver o que
  `wezterm`, `wezterm-mux-server` e `wtinator` ainda puxam, e **mantém** qualquer crate que o
  host ou a bridge precisem, mesmo que não seja usado pela GUI.
- Fica no `wtinator` o que o host e a bridge usam: `host`, `pane_cmd`, `wsl`, atalhos de shells e afins.
- `bethterm-setup`: entrega `bethterm.exe`, `bethterm-host.exe`, `bethterm-web.exe`,
  `bethterm-tool.exe`, ConPTY/OpenConsole e licenças; atalhos abrem `bethterm-web.exe`; some
  tudo que menciona o processo da GUI. As DLLs ANGLE e Mesa de `assets/windows/` também saem.
- Patch 0198 registra a remoção em `PATCHES.md`; as notas dos patches da GUI ficam como história.
- Regenerar `UPSTREAM_DIFF.patch`, `UPSTREAM_ADDED.txt`, `docs/UPSTREAM.md`, README e `FEATURES.md`.

## Erros e casos de borda

- Host não sobe em 8 s: registra no `host-life.log`, tenta de novo dentro do limite e mostra o motivo.
- Restauração parcial (um terminal falha): os outros continuam; o que falhou fica marcado como
  "terminal encerrado" no layout, com o motivo, e **Tentar de novo**.
- Distro que não sobe em 60 s: os terminais dela abrem na home do Windows com um aviso, e a faixa diz o que aconteceu.
- Bandeja some (Explorer reiniciou): reinserida pelo vigia.
- Dois Studios: a regra de instância única já existente continua valendo.

## Segurança e regras do projeto

- Nenhum teste nem instalação para ou substitui o `bethterm-host.exe` em uso. Testes com
  `APPDATA` curto e temporário, parando só processos iniciados por mim.
- O comando que sobe o host é montado no Go; nada vem do navegador. As rotas novas só
  respondem no PC (não no Studio remoto nem no celular).
- Atualizar `AGENTS.md` e o README do Studio: o Studio pode iniciar o host; só para com pedido confirmado.
- Atualizar `FEATURES.md` no mesmo conjunto de mudanças.

## Testes

- Unitários (Go): `restartLimiter` (3 em 10 min), serialização e leitura de `pane-specs.json`,
  `remapIDs` do layout e dos nomes, gate do WSL com executor falso (distro parada, init uma vez
  por boot, pasta que aparece depois, pasta que nunca aparece), parser de `wsl-distros.json`.
- Unitário (Rust): o helper de `--cd` do patch 0197.
- Manual em Studio isolado: subir host do zero, matar o host de teste e ver a recuperação, fechar a
  janela e ver a bandeja, `wsl --shutdown` seguido de restauração, Encerrar tudo com confirmação.
