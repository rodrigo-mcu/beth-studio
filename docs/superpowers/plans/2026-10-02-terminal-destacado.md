# Terminal destacado em janela nativa — Plano de implementação

> **Para agentes:** use superpowers:executing-plans (ou subagent-driven-development) para executar tarefa por tarefa. Passos usam checkbox.

**Goal:** destacar um terminal/SSH do Beth Studio como janela nativa do Windows, reencaixar arrastando, e fechar sem encerrar o terminal.

**Architecture:** a janela destacada é um processo `bethterm-web.exe --term <pane>` que navega para o servidor do Studio já em execução (URL e token por variável de ambiente, nunca por argv). O Studio principal guarda o registro `pane -> processo` (`termRegistry`), publica `term_windows` por WebSocket e recebe o arrasto da janela por `POST /api/term/drag`.

**Tech Stack:** Go (Win32 + go-webview2), React/TypeScript, `node --test`, `go test`.

**Spec:** `docs/superpowers/specs/2026-10-02-terminal-destacado-design.md`

**Ajuste em relação ao spec:** o estado "destacado" NÃO é gravado no layout (`web-settings.json`). Ele vive no registro do Go (as janelas morrem com o Studio, então persistir não teria utilidade) e chega ao frontend pelo evento `term_windows` + `GET /api/term/list`. Menos superfície (sem mudar `layout.go` nem `sanitizeLayout`), mesmo comportamento visível. Destacar usa `L.detachPane` (já existe); fechar a janela deixa o pane "não organizado" sem código extra; reencaixar usa `L.dropOnPane` / `L.movePaneToTab` (já existem).

## Global Constraints

- Nunca tocar `bethterm-host.exe` / `bethterm-gui.exe`; a janela destacada nunca chama `kill`.
- Studio remoto/celular (`remoteKey != ""`): endpoints `/api/term/*` respondem 403 e o botão Destacar fica oculto (`isRemote()`).
- Comando de lançamento montado no Go; `pane_id` validado (inteiro ≥ 0); token fora do argv.
- Nenhuma menção a nomes internos da organização (produto open source).
- Atualizar `FEATURES.md` (data `Atualizado`) no mesmo conjunto de mudanças. Nenhum arquivo upstream do wezterm é alterado.
- Build com prioridade baixa; não instalar sobre o host em uso; teste manual em instância isolada.

## Review Focus

- Destacar o mesmo pane duas vezes: só foca a janela existente (teste do registro).
- `pane_id` negativo/ausente em `/api/term/detach`: 400 (teste do handler).
- Chamada vinda do Studio remoto: 403 (teste do handler).
- Processo da janela morre sozinho: pane sai do registro e o evento é publicado (teste do registro).
- Soltar fora de qualquer zona: a janela não fecha e o pane não entra no layout (lógica `shouldCloseAfterDrop`, teste).

## Estrutura de arquivos

- Criar `term_registry.go` — registro `pane -> janela`, sem dependência de SO (testável).
- Criar `term_registry_test.go`.
- Criar `term_api.go` — handlers `/api/term/detach|focus|close|list|drag`.
- Criar `term_api_test.go`.
- Criar `term_window_windows.go` / `term_window_other.go` — lançar, focar, fechar, `runTermMode`, gancho de arrasto, `screenToStudioClient`.
- Modificar `server.go` (rotas), `main.go` (flag `--term`), `webhost_windows.go` (gancho no `hostWndProc`).
- Criar `frontend/src/lib/termDrop.ts` + `frontend/tests/termDrop.test.ts` — conversão de coordenadas e decisão pós-drop.
- Modificar `frontend/src/lib/dnd.ts` (`beginExternalPaneDrag`), `lib/connection.ts` (+ tipos em `lib/types.ts`), `main.tsx`.
- Criar `frontend/src/components/TermWindowApp.tsx`.
- Modificar `App.tsx`, `components/TerminalView.tsx`, `components/PaneMenu.tsx`, `FEATURES.md`.

---

### Task 1: Registro de janelas destacadas (Go)

**Files:** Create `term_registry.go`, `term_registry_test.go`.

**Interfaces — Produces:**
```go
type termProc interface{ Kill(); Focus() }          // implementado por *exec.Cmd wrapper no Windows
type termRegistry struct{ /* mu, m map[int]termProc, onChange func([]int) */ }
func newTermRegistry(onChange func(panes []int)) *termRegistry
func (r *termRegistry) Add(pane int, p termProc) (existed bool) // existed=true: já havia; foca e não substitui
func (r *termRegistry) Remove(pane int) bool                    // dispara onChange se removeu
func (r *termRegistry) Has(pane int) bool
func (r *termRegistry) Focus(pane int) bool
func (r *termRegistry) Close(pane int) bool                     // Kill do processo da janela
func (r *termRegistry) Panes() []int                            // ordenado
func (r *termRegistry) CloseAll()
```

- [ ] Escrever testes: `Add` duplicado devolve `existed=true` e chama `Focus` do original; `Remove` dispara `onChange` com a lista nova; `Panes` ordenado; `CloseAll` chama `Kill` em todos.
- [ ] Rodar `go test -run TermRegistry ./...` (falha: tipos não existem).
- [ ] Implementar com `sync.Mutex`; `onChange` chamado fora do lock.
- [ ] Rodar e passar. Commit.

### Task 2: Endpoints `/api/term/*` (Go)

**Files:** Create `term_api.go`, `term_api_test.go`; modify `server.go` (rotas), `hub.go` (campo `term *termRegistry`, criado em `newHub`, `onChange` faz `broadcast(map{"ev":"term_windows","panes":panes})`).

**Interfaces — Consumes:** Task 1. **Produces:**
- `POST /api/term/detach {pane_id}` → abre a janela (ou foca se já existe), `{ok:true}`.
- `POST /api/term/focus {pane_id}`, `POST /api/term/close {pane_id}` (fecha só o processo da janela).
- `GET /api/term/list` → `{panes:[...]}`.
- `POST /api/term/drag {pane_id,x,y,end}` (x,y = tela, vindos da janela destacada) → converte para cliente do Studio com `screenToStudioClient` e faz broadcast `{"ev":"term_drag","pane":N,"x":cx,"y":cy,"end":bool}`.
- Variável injetável `openTermWindow func(h *hub, pane int) error` (o handler a chama; testes a substituem).

- [ ] Testes de handler com `httptest`: pane negativo → 400; `remoteKey != ""` → 403; método GET em detach → 405; detach válido chama `openTermWindow` uma vez; detach repetido não duplica.
- [ ] Rodar (falha), implementar `serveTerm(w, r, remoteKey)` e ligar em `route` (`strings.HasPrefix(path, "/api/term/")`), rodar (passa). Commit.

### Task 3: Janela nativa (`--term`) — Windows

**Files:** Create `term_window_windows.go`, `term_window_other.go`; modify `main.go`, `webhost_windows.go`.

**Interfaces — Produces:**
- `openTermWindow` real: reexecuta o próprio exe com `--term <pane>`, env `BETHTERM_TERM_URL=<base>/?t=<token>&mode=term&pane=<pane>` e `BETHTERM_TERM_API=<base>`, `BETHTERM_TERM_TOKEN=<token>`; `CreationFlags` como `openDBWindow`; `go cmd.Wait()` → `Remove(pane)`.
- `runTermMode(pane int, winSize string, devtools bool)`: sem servidor, sem bridge; `windowTitle = "Terminal " + pane`; `webviewDataName = "WebView2-term"`; `setTermAppUserModelID`; `openWindow(url, ...)` com tamanho padrão 900x600.
- Gancho em `hostWndProc`: `var termWndHook func(msg, wp, lp uintptr)`; `WM_MOVING (0x0216)` → `termWndHook` posta `/api/term/drag` (throttle 40 ms, em goroutine, com `GetCursorPos`); `WM_EXITSIZEMOVE (0x0232)` → `end:true`.
- `screenToStudioClient(x, y int) (cx, cy int, ok bool)` usando `ScreenToClient(hostHWND, ...)`.
- `termProc` real: `Kill` = `cmd.Process.Kill()`; `Focus` = `FindWindowW("BethTermWeb", "Terminal N")` + `bringToFront`.
- `term_window_other.go`: `openTermWindow` devolve erro "só existe no Windows"; `runTermMode` chama `fatal`.

- [ ] Implementar, `go vet ./...` e `go build`. Commit.

### Task 4: Frontend — lógica pura + conexão

**Files:** Create `frontend/src/lib/termDrop.ts`, `frontend/tests/termDrop.test.ts`; modify `lib/dnd.ts`, `lib/types.ts`, `lib/connection.ts`, `package.json` (script `test`).

**Interfaces — Produces:**
```ts
export function toCssPoint(x: number, y: number, dpr: number): { x: number; y: number }       // px físicos -> CSS
export function shouldCloseAfterDrop(inLayoutAfterDrop: boolean): boolean                       // true só se o pane entrou no layout
// dnd.ts
export function beginExternalPaneDrag(pane: number): void   // set({kind:"pane",pane})
// connection.ts
snapshot.termWindows: number[]; onTermDrag(fn: (e:{pane:number;x:number;y:number;end:boolean})=>void): () => void
```

- [ ] Testes de `toCssPoint` (dpr 1, 1.25, 2; arredonda para 0,1 px) e `shouldCloseAfterDrop`; rodar (falham), implementar, passam.
- [ ] `Connection`: tratar `term_windows` (patch `termWindows`) e `term_drag` (listeners); no `onopen` buscar `GET /api/term/list`. Commit.

### Task 5: `TermWindowApp` (modo `term`)

**Files:** Create `components/TermWindowApp.tsx`; modify `main.tsx`.

- [ ] `main.tsx`: `mode === "term"` carrega `TermWindowApp` (import dinâmico, como `db`).
- [ ] `TermWindowApp`: cria `Connection`, lê `pane` da URL, `conn.setWatched([pane])`, cabeçalho de 32 px com nome (`paneLabel`), botão "Encaixar" (`POST /api/term/close` não: pede `POST /api/term/attach {pane_id}`? — não; encaixar = `conn.api("/api/term/drag",{pane_id,x:-1,y:-1,end:true,attach:true})`, ver Task 2: campo opcional `attach` faz o Studio encaixar na aba ativa) e X (`window.chrome.webview.postMessage("win:close")`); cabeçalho com `onMouseDown` → `postMessage("win:drag")`; corpo = `TerminalView` com `canClose={false}`. Se o pane some da lista: faixa "Terminal encerrado" + só fechar. Commit.

### Task 6: Integração no Studio

**Files:** modify `App.tsx`, `components/TerminalView.tsx`, `components/PaneMenu.tsx`.

- [ ] `TerminalView`: prop opcional `onDetach`; `IconButton` "Destacar em janela" (ícone `ExternalLink`) antes do fechar; ausente quando remoto.
- [ ] `PaneMenu`: ação `detach?: (pane) => void` e item "Destacar em janela".
- [ ] `App.tsx`: `act.detach(pane)` = `commit(L.detachPane(layout, pane))` e `conn.api("/api/term/detach",{pane_id})` (se falhar: restaura layout e `setNotice`); `act.open(pane)` para pane com `snap.termWindows.includes(pane)` chama `/api/term/focus` em vez de abrir aba; efeito que ouve `conn.onTermDrag`: no evento não-final, `beginExternalPaneDrag` + `dispatchDrag("dragover")` no `document.elementFromPoint`; no `end`, `dispatchDrag("drop")`, depois (50 ms) se `L.findPane(getLayout(), pane)` → `POST /api/term/close`; sempre `endDrag()`. Evento com `attach` encaixa na aba ativa (`L.movePaneToTab`) e fecha a janela. Commit.

### Task 7: Catálogo, build e teste isolado

- [ ] `FEATURES.md`: nova entrada "Terminal destacado em janela" e data `Atualizado`.
- [ ] `npm test` e `npm run build` em `frontend/`; `go vet ./... && go test ./...`; `build.ps1` (prioridade baixa).
- [ ] Teste manual isolado (APPDATA temporário curto, sem tocar o host em uso): destacar terminal e SSH, mover para outro monitor, arrastar para painel/aba/"+", fechar pelo X, conferir o pane na lista e vivo (`cli list`). Commit.
