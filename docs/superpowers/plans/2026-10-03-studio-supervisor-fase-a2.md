# Studio supervisor (Fase A2) — restaurar terminais depois de uma queda

> **Para agentes:** use superpowers:executing-plans (ou subagent-driven-development) para executar tarefa por tarefa. Passos usam checkbox.

**Goal:** quando o host volta vazio depois de uma queda (outro processo de host), o Studio recria os terminais, cada um na sua pasta e distro, e religa abas, nomes e temas aos ids novos. Terminais WSL só abrem depois que a distro responde, o comando de inicialização rodou e a pasta existe.

**Architecture:** tudo em Go dentro de `bethterm-web/`, com um patch pequeno no `bridge.rs` (0197) para o WSL aceitar `distro` e `--cd`. As partes de decisão são puras e testáveis (`wslGate` com executor injetável, `buildSpecs`, `runRestore` com spawner falso, `remapPanes`). Nada toca o host em uso.

**Tech Stack:** Go 1.24, `go test`; Rust (`cargo +nightly test -p wezterm`, só o helper do patch); React/TypeScript para a faixa de progresso.

**Spec:** `docs/superpowers/specs/2026-10-03-studio-supervisor-design.md` (Fase A2).

## Global Constraints

- Nunca parar nem substituir o `bethterm-host.exe` em uso. Testes com `BETHTERM_HOST_ID` único e `APPDATA` temporário curto. O `bethterm.exe` novo (patch 0197) só é instalado quando o usuário mandar.
- Receita dos terminais em `%APPDATA%\bethterm\pane-specs.json`, gravada de forma atômica, sem sobrescrever com lista vazia quando o host mudou. Só restaura receitas com menos de 7 dias.
- Restaurar só se: o host é **outro processo** que o da receita, a lista está vazia e a receita não está vazia. Terminal fechado de propósito (mesmo host, lista vazia) nunca ressuscita.
- Gate do WSL: distro até 60 s; comando `init` uma vez por boot da VM; pasta até 30 s, senão `~`. Todos os comandos sem janela e com limite de tempo.
- Terminal que falha na restauração vira "terminal encerrado" no layout; os outros seguem. Não reiniciar o host nem abrir terminal duplicado se já houver terminais.
- Sem menção a nomes internos da organização; atualizar `FEATURES.md` e `PATCHES.md` junto.

## Review Focus

- Host reiniciou mas a lista ainda não chegou: não decidir nada (esperar a primeira lista).
- Usuário fechou todos os terminais de propósito e depois o host caiu: a receita vazia não restaura nada.
- Id novo igual ao id antigo de outro terminal (colisão): o remap é simultâneo e não troca terminais.
- Distro inexistente na receita (apagada): o terminal vira "encerrado" e não trava a restauração.
- Falha em `init` do WSL: aviso, mas os terminais seguem abrindo.

## Estrutura de arquivos (todos em `bethterm-web/`, salvo indicação)

- Criar `wsl_ready.go`, `wsl_ready_test.go` — gate do WSL.
- Criar `pane_specs.go`, `pane_specs_test.go` — receitas e decisão de restaurar.
- Criar `settings_remap.go`, `settings_remap_test.go` — `remapPanes` e congelamento do reconcile.
- Criar `restore.go`, `restore_test.go` — orquestração.
- Criar `restore_wire.go` — liga ao hub, ao supervisor e à bridge.
- Modificar `hub.go`, `settings.go`, `server.go` (`distro` em spawn).
- Rust: `upstream-wezterm/wezterm/src/cli/bridge.rs` (patch 0197), `upstream-wezterm/PATCHES.md`, `patches/0197-*.md`.
- Frontend: `frontend/src/lib/restoreBanner.ts`, `components/RestoreBanner.tsx`, `lib/connection.ts`, `lib/types.ts`, `App.tsx`.
- Docs: `FEATURES.md`, `docs/HISTORY.md`, `bethterm-web/README.md`.

---

### Task 1: Gate do WSL

**Files:** Create `wsl_ready.go`, `wsl_ready_test.go`.

**Interfaces — Produces:**
```go
type cmdRunner func(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error)
type wslDistroCfg struct{ Init, User string; TimeoutSec int }
func loadWSLDistroCfg(dir string) map[string]wslDistroCfg    // wsl-distros.json, chave em minúsculas
func newWSLGate(run cmdRunner, cfg map[string]wslDistroCfg) *wslGate
func (g *wslGate) Ensure(ctx context.Context, distro string) (initErr error, err error)
func (g *wslGate) WaitDir(ctx context.Context, distro, path string) bool
```
`Ensure`: se `wsl -l --running -q` não lista a distro, `wsl.exe -d D --exec true` com tentativas e recuo até 60 s; depois, se há `init` e o `boot_id` mudou, `wsl.exe -d D -u <user|root> --exec sh -c <init>`. `WaitDir`: `wsl.exe -d D --exec test -d <path>` a cada 1 s, até 30 s.

- [ ] Testes com executor e relógio falsos: já rodando (sem `exec true`); parada que sobe; sobe na 3ª tentativa; nunca sobe (erro no prazo); `init` uma vez por boot e de novo no boot novo; argumentos do `init`; pasta que aparece depois; pasta que nunca aparece; caminho vazio; leitura do `wsl-distros.json` sem diferenciar maiúsculas.
- [ ] Rodar (falha), implementar, rodar (passa). Commit.

### Task 2: Receitas dos terminais

**Files:** Create `pane_specs.go`, `pane_specs_test.go`.

**Interfaces — Produces:**
```go
type paneSpec struct {
    PaneID int; ShellID, Kind, Distro, Cwd, Title string
    Tool *toolSpec // SSH salvo ou serial: {Kind, ID}
    Order int      // posição no layout (abas na ordem, folhas na ordem)
}
type specsFile struct{ Version int; SavedAt, HostID string; Specs []paneSpec }
func buildSpecs(list []byte, spawned map[int]string, layout *WebLayout) []paneSpec
func saveSpecs(path string, f specsFile) error     // atômico
func loadSpecs(path string) (specsFile, bool)
func shouldRestore(f specsFile, hostID string, panes int, now time.Time) bool
```
Regras: WSL guarda `Distro` e a pasta **Linux** (`/mnt/..` ou `/home/..`, convertida de `file://` ou UNC); PowerShell/pwsh/cmd/gitbash guardam a pasta do Windows; SSH salvo e serial viram `Tool`; `other`/`unknown` não entram. `shouldRestore` = lista vazia, receita não vazia, `HostID` diferente do atual e menos de 7 dias.

- [ ] Testes: cada tipo de terminal, ordem pelo layout, conversão de pasta WSL, `shouldRestore` em todos os casos do Review Focus, gravação atômica e leitura de arquivo corrompido (devolve `false`).
- [ ] Implementar e passar. Commit.

### Task 3: Remapear ids e congelar o reconcile

**Files:** Create `settings_remap.go`, `settings_remap_test.go`; modify `settings.go`.

**Interfaces — Produces:**
```go
func (st *settingsStore) setFrozen(on bool)                     // reconcile só atualiza st.live
func (st *settingsStore) remapPanes(m map[int]int) SettingsSnapshot
```
`remapPanes` é simultâneo: reescreve `Layout` (abas abertas e fechadas), `Panes` e `PaneNames` pelo mapa antigo→novo e põe o `HostID` atual; folha sem mapeamento vira `Gone`; entrada de aparência/nome sem mapeamento cuja chave colide com um id novo é descartada. Grava e transmite.

- [ ] Testes: troca simples; cruzamento (1→2 e 2→1) sem perder terminal; folha sem mapa fica `Gone`; colisão de id; `reconcile` congelado não marca nada como `Gone` nem fecha abas.
- [ ] Implementar e passar. Commit.

### Task 4: Orquestração da restauração

**Files:** Create `restore.go`, `restore_test.go`.

**Interfaces — Consumes:** Tasks 1–3. **Produces:**
```go
type restoreEnv interface {
    Spawn(ctx context.Context, s paneSpec, cwd string) (newPane int, err error)
    Progress(p restoreProgress)
}
type restoreProgress struct{ Total, Done int; Stage, Distro, Message string }
type restoreResult struct{ Map map[int]int; Failed []restoreFailure }
func runRestore(ctx context.Context, specs []paneSpec, env restoreEnv, gate *wslGate, parallel int) restoreResult
```
Agrupa por distro e roda o gate uma vez por distro; abre os terminais na ordem de `Order`, até `parallel` ao mesmo tempo; WSL com pasta Linux espera a pasta (`WaitDir`) e cai em `~` se ela não aparecer; falha de um terminal não interrompe os outros.

- [ ] Testes com `restoreEnv` e gate falsos: ordem, gate uma vez por distro, pasta ausente cai em `~`, uma falha entre vários, distro que não sobe (terminais dela falham com o motivo), progresso monotônico, cancelamento.
- [ ] Implementar e passar. Commit.

### Task 5: Ligar ao hub, ao supervisor e à bridge

**Files:** Create `restore_wire.go`; modify `hub.go`, `main.go`, `server.go`.

- [ ] `hub`: esperas por `spawned` com `request_id` (como `scrollWait`); `restore` emite `{"ev":"restore",...}` para os clientes e guarda a última para quem conecta depois.
- [ ] Ao chegar uma lista (antes do `reconcile`): grava receitas (debounce 2 s, nunca com lista vazia de host diferente), e se `shouldRestore` for verdadeiro, congela o reconcile e dispara `runRestore` numa goroutine; no fim `remapPanes`, descongela e emite o resultado.
- [ ] Só o Studio com supervisor faz isso (`hub.sup != nil`). `spawn` do servidor aceita `distro` (validado `^[A-Za-z0-9._-]{1,64}$`) e usa o gate quando o shell é WSL e a distro está parada. Commit.

### Task 6: Patch 0197 (bridge)

**Files:** Modify `upstream-wezterm/wezterm/src/cli/bridge.rs`; create `patches/0197-bridge-wsl-cd.md`; modify `PATCHES.md`.

- [ ] Helper puro `wsl_spawn_args(args, distro, cwd)`: para `argv[0]` `wsl.exe`, com `distro` insere `-d <distro>`, com pasta que começa com `/` insere `--cd <pasta>`, e devolve `command_dir = None` nesse caso. Qualquer outro shell fica igual.
- [ ] Teste Rust do helper; `spawn_shell` e a op `spawn` aceitam `distro`. Recompila só o `bethterm.exe`. Commit.

### Task 7: Progresso na interface

- [ ] `lib/restoreBanner.ts` (texto: "Aguardando o WSL (Debian)…", "Restaurando terminais (3 de 22)…", e o resumo com falhas) + teste; `Connection` guarda `restore`; `RestoreBanner` na faixa do topo. Commit.

### Task 8: Documentação

- [ ] `FEATURES.md`, `docs/HISTORY.md`, `bethterm-web/README.md` (`pane-specs.json`, `wsl-distros.json`). Commit.

### Task 9: Verificação isolada

- [ ] `go vet`, `go test ./...`, `npm test`, `npm run build`, `cargo +nightly test -p wezterm` (helper).
- [ ] Com `BETHTERM_HOST_ID` único e `APPDATA` temporário: Studio de teste com receitas pré-gravadas e um host de teste vazio restaura os terminais, remapeia o layout; terminal com pasta ausente cai em `~`; com a receita vazia nada ressuscita. O host do usuário não é tocado.
