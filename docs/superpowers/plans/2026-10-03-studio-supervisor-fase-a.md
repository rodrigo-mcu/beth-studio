# Studio supervisor (Fase A) — Plano de implementação

> **Para agentes:** use superpowers:executing-plans (ou subagent-driven-development) para executar tarefa por tarefa. Passos usam checkbox.

**Goal:** o Beth Studio sobe e vigia o `bethterm-host.exe`, tem bandeja própria, esconde na bandeja ao fechar a janela e só encerra o host com "Encerrar tudo" confirmado.

**Architecture:** tudo em Go, dentro de `bethterm-web/`. Uma interface `hostCtl` isola o Windows (mutex, processo, evento de saída); um `supervisor` decide quando subir o host e respeita um `restartLimiter`; a bandeja é uma thread Win32 própria que lê o estado do supervisor. Nada muda no Rust.

**Tech Stack:** Go 1.24 (`golang.org/x/sys/windows`), `go test`; React/TypeScript para a faixa "Host indisponível".

**Spec:** `docs/superpowers/specs/2026-10-03-studio-supervisor-design.md` (Fase A).

## Global Constraints

- Nunca parar nem substituir o `bethterm-host.exe` em uso; testes com `APPDATA` curto e temporário, parando só processos iniciados por mim.
- Comando que sobe o host é montado no Go; nada vem do navegador. As rotas novas respondem 403 ao Studio remoto e ao celular.
- O host só é encerrado por "Encerrar tudo" confirmado pelo usuário, nunca automaticamente.
- Limite de reinícios: 3 em 10 minutos. Host sobe com `BETHTERM_ACTIVE=1` e `WTINATOR_ACTIVE=1`; espera até 8 s pelo mutex `Local\BethTermHost` e por `host.sock`.
- Se `bethterm-gui.exe` estiver rodando, o Studio não sobe bandeja nem supervisão (checa a cada 5 s e assume quando a GUI sair).
- Fechar a janela principal esconde na bandeja; janelas `--term`, `--db` e `--sftp` continuam fechando normalmente.
- Sem menção a nomes internos da organização; atualizar `FEATURES.md`, `AGENTS.md` e o README do Studio no mesmo conjunto de mudanças.

## Review Focus

- Host sobe e some em seguida (loop): o limitador para no 4º reinício e a interface mostra o motivo (teste do supervisor).
- Usuário pediu "Encerrar tudo": o supervisor **não** reinicia o host (teste do supervisor).
- Duas instâncias do host (mutex já existente na hora de subir): não é erro, é "já rodando" (teste do hostCtl falso).
- Fechar a janela com janelas destacadas abertas: elas continuam; só "Sair da bandeja" as fecha (já feito por `hub.term.CloseAll`).
- GUI antiga presente: nenhuma bandeja duplicada e nenhum segundo supervisor (teste do supervisor com `guiRunning` falso).

## Estrutura de arquivos (todos em `bethterm-web/`)

- Criar `restart_limiter.go`, `restart_limiter_test.go` — limite de reinícios (puro).
- Criar `hostctl.go` — interface `hostCtl`, `lifeLog`, `hostExePath`.
- Criar `hostctl_windows.go`, `hostctl_other.go` — mutex, start, quit, GUI antiga.
- Criar `supervisor.go`, `supervisor_test.go` — laço de supervisão com relógio e `hostCtl` injetáveis.
- Criar `tray_model.go`, `tray_model_test.go` — entradas do menu (puro).
- Criar `tray_windows.go`, `tray_other.go` — ícone, menu, thread de mensagens.
- Criar `host_api.go` — `/api/host/retry`, `/api/host/state` e eventos.
- Modificar `main.go`, `webhost_windows.go` (WM_CLOSE → esconder), `server.go` (rota).
- Frontend: `frontend/src/components/HostBanner.tsx`, `lib/connection.ts`, `lib/types.ts`, `App.tsx`.
- Docs: `AGENTS.md`, `bethterm-web/README.md`, `FEATURES.md`, `docs/HISTORY.md`.

---

### Task 1: Limite de reinícios

**Files:** Create `restart_limiter.go`, `restart_limiter_test.go`.

**Interfaces — Produces:**
```go
type restartLimiter struct{ /* max int, window time.Duration, hits []time.Time */ }
func newRestartLimiter(max int, window time.Duration) *restartLimiter
func (l *restartLimiter) Allow(now time.Time) bool   // registra e devolve true se ainda cabe
func (l *restartLimiter) Reset()
func (l *restartLimiter) RetryAt(now time.Time) time.Time // quando volta a caber (zero se já cabe)
```

- [ ] Teste: 3 permitidos em 10 min e o 4º negado; passados 10 min o seguinte é permitido; `Reset` limpa; `RetryAt` devolve o instante em que o mais antigo sai da janela.
- [ ] Rodar `go test -run RestartLimiter .` (falha), implementar, rodar (passa). Commit.

### Task 2: Controle do host (interface + Windows)

**Files:** Create `hostctl.go`, `hostctl_windows.go`, `hostctl_other.go`.

**Interfaces — Produces:**
```go
type hostCtl interface {
    Running() bool                         // mutex Local\BethTermHost existe
    Start() error                          // sobe e espera até 8 s (mutex + host.sock)
    RequestQuit(requester string) error    // evento Local\BethTermHostQuit + host.quit-request
    GUIRunning() bool                      // bethterm-gui.exe existe?
}
func lifeLog(msg string)                   // linha em %APPDATA%\bethterm\host-life.log, origem "studio"
func hostExePath() (string, error)         // bethterm-host.exe ao lado do exe do Studio
```

- Windows: `Running` = `OpenMutex(SYNCHRONIZE, "Local\\BethTermHost")`; `Start` = `exec.Command(host)` com `CREATE_NO_WINDOW|DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`, env acrescida de `BETHTERM_ACTIVE=1` e `WTINATOR_ACTIVE=1`, depois sondagem de 100 ms por até 8 s; `RequestQuit` = `OpenEvent`+`SetEvent` em `Local\BethTermHostQuit` depois de gravar `host.quit-request` (`requester`); fallback de 5 s usando o pid file só quando chamado por "Encerrar tudo"; `GUIRunning` = `CreateToolhelp32Snapshot` procurando `bethterm-gui.exe`.
- Formato do log: `2006-01-02 15:04:05.000 pid=<pid> studio <msg>`.

- [ ] Teste de `hostExePath` (dado um diretório com o exe) e do formato de `lifeLog` com `APPDATA` temporário.
- [ ] Implementar, `go vet -unsafeptr=false ./...`. Commit.

### Task 3: Supervisor

**Files:** Create `supervisor.go`, `supervisor_test.go`.

**Interfaces — Consumes:** Tasks 1 e 2. **Produces:**
```go
type hostState string // "running" | "starting" | "unavailable" | "quitting" | "gui-managed"
type supervisor struct{ /* ctl hostCtl, lim *restartLimiter, now func() time.Time, quitAsked atomic.Bool, state, msg */ }
func newSupervisor(ctl hostCtl, lim *restartLimiter, now func() time.Time, onState func(hostState, string)) *supervisor
func (s *supervisor) Tick()                     // uma avaliação (chamada a cada 2 s pelo Run)
func (s *supervisor) Run(ctx context.Context)   // laço de 2 s
func (s *supervisor) AskQuit()                  // marca "encerrar tudo": não reinicia mais
func (s *supervisor) Retry()                    // Reset do limitador + Tick
func (s *supervisor) State() (hostState, string)
```

Regras do `Tick`: GUI antiga → `gui-managed`, não faz nada; `quitAsked` → `quitting`, não sobe; host rodando → `running` (e `Reset` do limitador após 10 min estáveis); host ausente → se `Allow` então `Start` (`starting`/`running` ou, em falha, registra e mantém `starting`), senão `unavailable` com o motivo e `RetryAt`.

- [ ] Testes com `hostCtl` falso e relógio falso: sobe quando ausente; não sobe quando `quitAsked`; 4º reinício em 10 min vira `unavailable`; `Retry` volta a tentar; `gui-managed` não chama `Start`; host rodando limpa o estado.
- [ ] Implementar e passar. Commit.

### Task 4: Ligar no `main.go`, API e faixa na interface

**Files:** Modify `main.go`, `server.go`; Create `host_api.go`; Modify `frontend/src/lib/{connection,types}.ts`, `App.tsx`; Create `frontend/src/components/HostBanner.tsx`.

- [ ] `main.go`: criar `supervisor` depois do `hub` (`onState` faz `hub.broadcast({"ev":"host","state":…,"message":…})`) e iniciar `go sup.Run(ctx)` antes da bridge. Só no Studio principal (não nos modos `--db`, `--sftp`, `--term`) e não em `--no-window` de teste, a menos que `--supervise` seja passado.
- [ ] `host_api.go`: `GET /api/host/state`, `POST /api/host/retry` (403 se `remoteKey != ""`).
- [ ] Frontend: `Connection` trata o evento `host` (campo `host` no snapshot); `HostBanner` aparece só em `unavailable` com o motivo e o botão **Tentar de novo**; teste de TypeScript para a escolha do texto.
- [ ] Teste Go do handler (403 remoto, 405 método). Commit.

### Task 5: Esconder na bandeja ao fechar a janela

**Files:** Modify `webhost_windows.go`.

- [ ] Em `hostWndProc`, `WM_CLOSE` na janela principal (`studioMainWindow`) → `ShowWindow(hwnd, SW_HIDE)` e `return 0`, a menos que `quitRequested` esteja ligado (flag atômica global que a bandeja liga em "Sair da bandeja"). Janelas `--term/--db/--sftp` seguem o caminho antigo.
- [ ] `showStudioWindow()` mostra e traz para a frente (reaproveita `bringToFront`); a instância única já a chama.
- [ ] Manual: fechar a janela deixa o processo e a bandeja vivos; novo clique no atalho traz a janela de volta. Commit.

### Task 6: Bandeja (modelo puro)

**Files:** Create `tray_model.go`, `tray_model_test.go`.

**Interfaces — Produces:**
```go
type trayItem struct{ ID int; Label string; Default, Sep, Grayed bool; Sub []trayItem }
func trayMenu(shells []trayShell, hostRunning bool, waiting int) []trayItem
func trayTooltip(panes, waiting int, st hostState) string
```
Itens: **Beth Studio** (default, ID `trayOpen`), **Novo terminal ▸** (um por shell; vazio e cinza se a bridge está parada), **Sistema**, separador, **Sair da bandeja (terminais continuam)**, **Encerrar tudo (fecha os terminais)** (só se o host roda).

- [ ] Testes: ordem dos itens, Studio em negrito, "Encerrar tudo" só com host rodando, submenu de shells, dica com agentes esperando.
- [ ] Implementar e passar. Commit.

### Task 7: Bandeja (Windows) e ações

**Files:** Create `tray_windows.go`, `tray_other.go`; Modify `main.go`.

- [ ] Thread própria (`runtime.LockOSThread`) com janela de mensagens oculta, `Shell_NotifyIconW` (`NIM_ADD/MODIFY/DELETE`), reinserção em `TaskbarCreated` e vigia a cada 30 s, menu com `CreatePopupMenu`/`TrackPopupMenuEx` na thread da bandeja (não em thread auxiliar).
- [ ] Ações: abrir (mostra a janela); **Novo terminal** → `spawn` pela bridge com o `shell_id`; **Sistema** → mostra a janela e envia `{"ev":"open","what":"tasks"}` (o frontend abre o gerenciador); **Sair da bandeja** → liga `quitRequested`, fecha a janela e o processo (o host continua); **Encerrar tudo** → `MessageBoxW` "Encerrar o BethTerm e fechar N terminais?" e, só com Sim, `sup.AskQuit()` + `ctl.RequestQuit("Studio (confirmado)")` + sair.
- [ ] Ícone com marca âmbar quando `waiting > 0` (usa `hub.agents`).
- [ ] Só inicia se `!ctl.GUIRunning()`; quando a GUI sair, inicia (checa a cada 5 s). Commit.

### Task 8: Documentação e catálogo

- [ ] `AGENTS.md` e `bethterm-web/README.md`: o Studio pode iniciar o host; só para com "Encerrar tudo" confirmado; nova bandeja; fechar a janela esconde.
- [ ] `FEATURES.md`: entradas "Studio na bandeja", "Studio sobe e vigia o host" e "Encerrar tudo"; `docs/HISTORY.md`: linha de 2026-10-03.
- [ ] Commit.

### Task 9: Verificação isolada

- [ ] `npm test`, `npm run build`, `go vet -unsafeptr=false ./...`, `go test ./...`.
- [ ] Com `APPDATA` temporário: Studio sem host sobe o host; matar o **host de teste** e ver o reinício e o limite de 3; fechar a janela e ver a bandeja; "Encerrar tudo" com Não e com Sim; sem tocar no host do usuário.
- [ ] Commit final da fase.
