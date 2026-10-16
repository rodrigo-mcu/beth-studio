# WSL: inicialização guiada e pastas ausentes — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na restauração depois de reiniciar o PC, perguntar se roda o init do WSL quando falta a pasta de um terminal, rodá-lo num terminal visível, e deixar pendentes (sem perder a receita) os terminais cuja pasta continua ausente.

**Architecture:** `runRestore` (Go, `restore.go`) ganha etapas novas por meio de dois métodos no `restoreEnv` (`AskInit`, `RunInit`) e de uma checagem única de pasta no gate (`DirExists`). O hub implementa a pergunta por um canal respondido por `POST /api/restore/answer` e o init por `spawn` + `send` + arquivo marcador. Terminal pendente continua como **folha encerrada** (`gone`) do layout, mostrada por `GoneLeaf`, e a receita guarda o spec dele; a configuração vive em `webSettings.WSLInit` com tela própria.

**Tech Stack:** Go (`bethstudio-web/`), React + TypeScript (`bethstudio-web/frontend`), `node --test` para o frontend, `go test` para o Go.

**Spec:** `docs/superpowers/specs/2026-10-16-wsl-init-na-restauracao-design.md`

## Global Constraints

- **Nunca** parar, matar ou reiniciar `bethstudio-host.exe` ou `bethstudio-web.exe`; não instalar em `C:\Users\Public\BethStudio`; não rodar `BethStudio-Setup.exe`. Só `deploy-ui.ps1` (troca a interface sem tocar nos processos).
- **Não rodar a suíte Go inteira** (os testes do supervisor mexem no host). Rodar só por `-run` dos grupos tocados. Testes que gravam em disco usam `t.TempDir()` + `t.Setenv("BETHSTUDIO_DATA_DIR", dir)`.
- Sem `git commit` (o usuário só pede quando quiser). Atualizar `FEATURES.md` (e sua data) e `CHANGELOG.md` junto.
- Textos da interface e comentários em português do Brasil, com acentuação. Identificadores em inglês/português como o código vizinho.
- Os arquivos do repositório usam fim de linha misto: preservar o fim de linha de cada arquivo ao editar (scripts Python com `newline=''`).
- `upstream-wezterm/` **não muda**.
- Valores da spec: tempo máximo padrão 300 s; marcador `/tmp/.bethstudio-init-<boot_id>`; retentativa de pasta a cada 15 s por até 5 min; limite geral do job 15 min; comando máx. 1024 caracteres, sem caracteres de controle; terminal de init fecha sozinho com código 0 e fica aberto com erro ou tempo esgotado.

## Review Focus

1. **Nome de distro** com maiúsculas ou caracteres fora de `distroRe`: a API rejeita o inválido; a chave é minúscula (`Task 2`).
2. **Duas distros** com pasta ausente: uma pergunta por distro, respostas independentes; "Agora não" numa não bloqueia a outra (`Task 3`).
3. **Ninguém responde a pergunta**: a restauração espera, os terminais não-WSL já abriram, e o cancelamento do contexto encerra sem travar (`Task 3`).
4. **Comando com quebra de linha ou muito longo**: rejeitado na API, porque vira texto digitado num terminal (`Task 2`).
5. **Init com código ≠ 0, marcador ilegível, ou terminal fechado pelo usuário**: segue para reconferir as pastas e o que faltar vira pendente (`Task 4`).
6. **Pendente + id reaproveitado**: a folha pendente nunca é "adotada" por um terminal novo de mesmo id (`Task 5`).
7. **Host cai com pendentes guardados**: a receita ainda contém os specs pendentes (`Task 5`).

---

### Task 1: Gate do WSL — `DirExists` e sem init silencioso

**Files:**
- Modify: `bethstudio-web/wsl_ready.go`
- Modify: `bethstudio-web/restore.go` (interface `wslReady`)
- Modify: `bethstudio-web/server.go:516-535` (chamada de `Ensure`)
- Test: `bethstudio-web/wsl_ready_test.go` (existente; adaptar) e `bethstudio-web/restore_test.go` (fakes)

**Interfaces:**
- Produces:
  - `func (g *wslGate) Ensure(ctx context.Context, distro string) error` (sobe a distro; sem init)
  - `func (g *wslGate) DirExists(ctx context.Context, distro, path string) bool` (uma checagem `test -d`, sem esperar)
  - `func (g *wslGate) BootID(ctx context.Context, distro string) string` (público; antes `bootID`)
  - interface `wslReady { Ensure(ctx, distro) error; WaitDir(ctx, distro, path) bool; DirExists(ctx, distro, path) bool; BootID(ctx, distro) string }`
  - Removidos: `wslDistroCfg`, `loadWSLDistroCfg`, `initDone`, o parâmetro `cfg` de `newWSLGate` (agora `newWSLGate(run cmdRunner) *wslGate`).

- [ ] **Step 1: Escrever os testes que falham** em `wsl_ready_test.go`: `TestDirExistsChecksOnce` (runner falso devolve nil para `test -d /a` e erro para `/b`; asserts `true`/`false` e que cada chamada executou exatamente um `wsl.exe -d D --exec test -d <path>`), `TestEnsureNeverRunsInit` (distro já rodando; asserts que nenhum comando com `sh -c` foi executado) e `TestBootIDTrimsOutput`. Remover os testes do init silencioso e de `loadWSLDistroCfg`.
- [ ] **Step 2: Rodar e ver falhar:** `go test -run "DirExists|EnsureNever|BootID" -count=1 .` (esperado: não compila/FAIL).
- [ ] **Step 3: Implementar** em `wsl_ready.go`: tirar o init de `Ensure`, renomear `bootID`→`BootID`, acrescentar `DirExists`, simplificar `newWSLGate`. Atualizar `main.go:124` (`newWSLGate(execRunner)`), `server.go` (`if err := gate.Ensure(ctx, distro); err != nil`), os fakes de `restore_test.go` e a interface em `restore.go`.
- [ ] **Step 4: Rodar:** `go test -run "WSL|Wsl|DirExists|Restore|Ensure" -count=1 .` (esperado: ok) e `go build -o NUL .`.

### Task 2: Configuração `WSLInit` e `GET/PUT /api/wsl-init`

**Files:**
- Modify: `bethstudio-web/settings.go` (`webSettings`, métodos)
- Create: `bethstudio-web/wsl_init_cfg.go` (tipos, validação, migração, handler)
- Modify: `bethstudio-web/server.go:191` (rota)
- Test: `bethstudio-web/wsl_init_cfg_test.go`

**Interfaces:**
- Produces:
  - `type WSLInitCfg struct { Enabled bool \`json:"enabled"\`; Command string \`json:"command"\`; TimeoutSec int \`json:"timeout_sec"\`; DefaultDir string \`json:"default_dir,omitempty"\` }`
  - `webSettings.WSLInit map[string]WSLInitCfg \`json:"wsl_init,omitempty"\`` (chave = distro em minúsculas)
  - `func validateWSLInit(distro string, c WSLInitCfg) (WSLInitCfg, error)` (distro por `distroRe`; comando ≤ 1024, sem caracteres de controle, `TimeoutSec` 0→300 e limitado a 1800; `DefaultDir` vazio ou começando por `/`)
  - `func (st *settingsStore) wslInitFor(distro string) (WSLInitCfg, bool)` e `func (st *settingsStore) setWSLInit(distro string, c WSLInitCfg) error`
  - `func importWSLDistrosFile(dir string, st *settingsStore)` (migra o `wsl-distros.json`: `init`→`Command`, `timeout_sec`; `Enabled` = true; só se a distro ainda não tem config; depois renomeia o arquivo para `wsl-distros.json.migrado`)
  - `GET /api/wsl-init` → `{"distros":["Ubuntu",…],"config":{"ubuntu":{…}}}`; `PUT /api/wsl-init` com `{"distro":"Ubuntu","config":{…}}` → 200 com o mesmo corpo do GET, 400 com `{"error":"…"}` se inválido; PUT bloqueado em modo somente leitura.

- [ ] **Step 1: Testes que falham:** `TestValidateWSLInit` (tabela: `"init-wsl2"` ok com timeout 300; `"a\nb"` erro; 1025 caracteres erro; distro `"a b"` erro; `DefaultDir:"relativa"` erro; `TimeoutSec:5000` vira 1800), `TestWSLInitPersistsLowercaseKey` (set com `"Ubuntu"`, ler com `"ubuntu"` e `"UBUNTU"`), `TestImportWSLDistrosFile` (arquivo com `{"Ubuntu":{"init":"init-wsl2","timeout_sec":120}}` vira config `Enabled:true`, o arquivo é renomeado, e uma config já existente não é sobrescrita), `TestWSLInitEndpoint` (GET lista distros injetadas; PUT inválido dá 400; PUT válido persiste).
- [ ] **Step 2: Rodar e ver falhar:** `go test -run "WSLInit|ValidateWSL|ImportWSL" -count=1 .`
- [ ] **Step 3: Implementar** os tipos, a validação, os métodos (sob `st.mu`, gravando com `saveLocked`), o handler (padrão de `serveVoiceSettings` para método, cabeçalho JSON e `writeJSON`; lista de distros por `listWSLDistros()` injetável por variável de pacote para o teste) e a rota. Chamar `importWSLDistrosFile(dataDir(), settings)` uma vez em `main.go` logo depois de criar o `settings`.
- [ ] **Step 4: Rodar:** mesmo comando (ok) e `go build -o NUL .`.

### Task 3: Núcleo da restauração — etapas, pergunta e pendentes (`restore.go`)

**Files:**
- Modify: `bethstudio-web/restore.go`
- Test: `bethstudio-web/restore_test.go`

**Interfaces:**
- Consumes: Task 1 (`wslReady` com `DirExists`, `Ensure`, `WaitDir`), Task 2 (`WSLInitCfg`).
- Produces:
  - em `restoreEnv`: `AskInit(ctx context.Context, distro string, missing []string) (run bool, err error)` e `RunInit(ctx context.Context, distro string, cfg WSLInitCfg) initOutcome`; em `restoreEnv` também `InitConfig(distro string) (WSLInitCfg, bool)`
  - `type initOutcome struct { Ran bool; ExitCode int; Err string; ClosedByUser bool; TimedOut bool }`
  - `restoreResult` perde `Fallbacks` e ganha `Pending []restorePending`
  - `type restorePending struct { PaneID int \`json:"pane_id"\`; Title string \`json:"title,omitempty"\`; Distro string \`json:"distro"\`; Cwd string \`json:"cwd"\`; Spec paneSpec \`json:"-"\` }`
  - estágios novos em `restoreProgress.Stage`: `"ask_init"`, `"init"` (além de `start|wsl|spawn|done`); `restoreProgress` ganha `Missing []string \`json:"missing,omitempty"\``

Fluxo de `runRestore` (spec §5.1): (1) abrir já os terminais que não são WSL; (2) `gate.Ensure` por distro; (3) por distro, `DirExists` de cada `cwd` dos terminais WSL dela → `missing`; (4) se `missing` não vazio e `InitConfig` ligada e com comando: `AskInit`; `run=true` → `RunInit`, depois reconferir com `WaitDir` curto (uma rodada de `DirExists` a cada 2 s por até 20 s); (5) abrir os terminais WSL com pasta OK; (6) os com pasta ausente vão para `Pending` sem `Spawn` e sem `Failed`.

- [ ] **Step 1: Testes que falham** (com fakes de `restoreEnv`/`wslReady` já existentes, estendidos): `TestRestoreAllDirsOKNeverAsks`, `TestRestoreMissingDirAsksAndRunsInit` (pasta passa a existir depois do `RunInit`; asserts: `AskInit` chamado 1×, `RunInit` 1×, `Spawn` do WSL só depois do `RunInit`, `Pending` vazio), `TestRestoreSkipInitMakesPending` (`AskInit` devolve `false`: nenhum `Spawn` do WSL com pasta ausente; `Pending` tem o terminal; o terminal Windows abriu), `TestRestoreInitDoesNotFixDirStaysPending`, `TestRestoreNoInitConfiguredGoesPending` (sem `AskInit`), `TestRestoreTwoDistrosAskedIndependently` (Review Focus 2), `TestRestoreAskNeverAnsweredStopsOnCancel` (Review Focus 3: `AskInit` bloqueia até `ctx.Done()`; asserts que `runRestore` retorna e o terminal Windows já foi aberto), `TestRestoreInitAskedOncePerDistro` (3 terminais da mesma distro, 1 pergunta).
- [ ] **Step 2: Rodar e ver falhar:** `go test -run "TestRestore" -count=1 .`
- [ ] **Step 3: Implementar** `runRestore` conforme o fluxo acima, mantendo o paralelismo 3 e a ordem por `Order`; `Pending` recebe o `paneSpec` original. Remover `restoreFallback`/`Fallbacks` e o uso em `restore_wire.go` (o evento `finished` passa a levar `pending`).
- [ ] **Step 4: Rodar:** `go test -run "TestRestore|Coordinator" -count=1 .` (ok).

### Task 4: Hub — pergunta por canal, terminal de init e `POST /api/restore/answer`

**Files:**
- Modify: `bethstudio-web/restore_wire.go`
- Create: `bethstudio-web/restore_init.go` (terminal de init)
- Modify: `bethstudio-web/server.go` (rota)
- Test: `bethstudio-web/restore_init_test.go`

**Interfaces:**
- Consumes: Task 3 (`restoreEnv`, `initOutcome`), Task 1 (`BootID`, runner).
- Produces:
  - `func (h *hub) awaitInitAnswer(distro string) chan bool` / `func (h *hub) answerInit(distro string, run bool) bool` (espelha `awaitSpawn`/`notifySpawn`)
  - `hubRestoreEnv.AskInit`, `.RunInit`, `.InitConfig` implementados
  - `func initMarkerPath(bootID string) string` → `/tmp/.bethstudio-init-<bootID>` (bootID vazio → `/tmp/.bethstudio-init-nb`)
  - `func initTypedLine(cmd, marker string) string` → `cmd + "; echo $? > " + marker + "\r"`
  - `func pollInitMarker(ctx, run cmdRunner, distro, marker string) (code int, ok bool)`
  - `POST /api/restore/answer` `{"distro":"Ubuntu","action":"run"|"skip"}` → 200 `{"ok":true}`; 404 se não há pergunta aberta; 403 em modo somente leitura.
  - `RunInit`: remove o marcador antigo; `Spawn` de um terminal WSL (`wsl.default`, na home, distro dada); `send` de `initTypedLine` pela bridge (`{"op":"send","pane_id":N,"data":…}`); loop de 2 s: marcador existe (lê o código), ou o terminal sumiu da lista viva (`ClosedByUser`), ou `cfg.TimeoutSec` (`TimedOut`), ou resposta `"skip"`/botão "Continuar assim mesmo" (`POST /api/restore/answer` com `action:"continue"` durante o init). Código 0 → `kill` do terminal de init; senão deixa aberto. `lifeLog` com distro, código e duração.

- [ ] **Step 1: Testes que falham:** `TestInitTypedLine` (`init-wsl2` + marcador → `init-wsl2; echo $? > /tmp/.bethstudio-init-abc\r`), `TestInitMarkerPath`, `TestPollInitMarker` (runner falso: 1ª chamada erro, 2ª `"0\n"` → `(0,true)`; `"3"` → `(3,true)`; lixo → `ok=false`), `TestAnswerInitRoutes` (pergunta aberta recebe `true`; sem pergunta devolve `false`; resposta duplicada ignorada), `TestRunInitOutcomes` (com bridge e lista falsos: código 0 fecha o terminal; código 2 deixa aberto com `Err`; terminal removido da lista vira `ClosedByUser`; relógio injetado estoura `TimedOut`) — Review Focus 5.
- [ ] **Step 2: Rodar e ver falhar:** `go test -run "InitTyped|InitMarker|PollInit|AnswerInit|RunInit" -count=1 .`
- [ ] **Step 3: Implementar** com o relógio e o runner injetáveis (campos no `hubRestoreEnv`, como `wslGate.now/sleep`) para não dormir de verdade nos testes. `runRestoreJob` passa a chamar `h.setRestore` com `stage:"ask_init"` (distro, `missing`) e `stage:"init"` (distro, segundos corridos).
- [ ] **Step 4: Rodar:** `go test -run "InitTyped|InitMarker|PollInit|AnswerInit|RunInit|TestRestore" -count=1 .` e `go build -o NUL .`.

### Task 5: Pendentes — receita, layout e ações

**Files:**
- Modify: `bethstudio-web/restore_coord.go`, `restore_wire.go`, `settings_remap.go`, `settings.go`
- Create: `bethstudio-web/restore_pending.go`
- Modify: `bethstudio-web/server.go` (rota)
- Test: `bethstudio-web/restore_pending_test.go`, `restore_coord_test.go`, `settings_remap_test.go`

**Interfaces:**
- Consumes: Task 3 (`restorePending`), `carry` já existente em `restore_coord.go`.
- Produces:
  - `func (c *restoreCoordinator) setPending(p []paneSpec)` e `func (c *restoreCoordinator) pendingSpecs() []paneSpec`; em `flush`, os specs pendentes são **acrescentados** aos specs montados da lista viva (com `PaneID` = id antigo; `Order` depois dos vivos) e `structKey` os inclui.
  - `func (st *settingsStore) reviveLeaf(oldPane, newPane int, host string) bool` (a folha `Gone` com `Pane==oldPane` e título/cwd batendo volta a viva com `newPane`, `HostID=host`, `Gone=false`; nada mais é tocado). Folha viva com o mesmo número nunca é alterada (Review Focus 6).
  - `POST /api/restore/pending` `{"pane_id":N,"action":"retry"|"default"|"keep"|"discard"}`: `retry` reconfere `DirExists` e, se existe, abre (`Spawn`), chama `reviveLeaf` e tira o item de `pending`; `default` abre na `DefaultDir` da config (vazio = home); `keep` só marca `keep:true` (para de retentar); `discard` remove o spec da receita e a folha encerrada do layout. Todas atualizam o evento `restore` (`pending` com `keep`).
  - retentativa automática: a cada 15 s por até 5 min para pendentes sem `keep`, enquanto houver pendente.

- [ ] **Step 1: Testes que falham:** `TestFlushKeepsPendingSpecsInTheRecipe` (Review Focus 7: lista viva sem o terminal pendente; receita gravada ainda o contém), `TestReviveLeafOnlyRevivesTheGoneOne` (folha viva de mesmo id intacta; a encerrada revive com o id novo), `TestPendingRetryOpensWhenDirAppears`, `TestPendingKeepStopsRetrying`, `TestPendingDiscardRemovesRecipeAndLeaf`, `TestPendingDefaultOpensInDefaultDir`, `TestRemapKeepsPendingAsGoneLeaf` (o `Map` não contém o pendente e a folha fica `Gone` com título e cwd).
- [ ] **Step 2: Rodar e ver falhar:** `go test -run "Pending|ReviveLeaf|FlushKeeps|RemapKeeps" -count=1 .`
- [ ] **Step 3: Implementar.** `runRestoreJob` guarda `res.Pending` (`setPending` + evento `finished` com `pending`). Nenhuma mudança no `remapPanesFrom` além do teste que fixa o comportamento atual (folha sem id novo vira `Gone`).
- [ ] **Step 4: Rodar:** `go test -run "Pending|ReviveLeaf|FlushKeeps|RemapKeeps|Coordinator|TestRestore" -count=1 .` e `go build -o NUL .`.

### Task 6: Frontend — banner da restauração (pergunta, espera do init, pendentes)

**Files:**
- Modify: `bethstudio-web/frontend/src/lib/restoreBanner.ts`, `components/RestoreBanner.tsx`, `lib/types.ts` (se o tipo do evento vive lá), `lib/connection.ts` (helpers de API)
- Test: `bethstudio-web/frontend/tests/restoreBanner.test.ts`

**Interfaces:**
- Produces:
  - `RestoreEvent.stage` ganha `"ask_init" | "init"`; `RestoreEvent` ganha `missing?: string[]` e `pending?: { pane_id: number; title?: string; distro: string; cwd: string; keep?: boolean }[]`; `fallbacks` sai.
  - `RestoreBannerInfo` ganha `ask?: { distro: string; missing: string[] }`, `initElapsed?: number` e `pending: RestorePendingItem[]`.
  - `answerRestoreInit(conn, distro, action: "run" | "skip" | "continue"): Promise<void>` e `actOnPending(conn, paneId, action: "retry" | "default" | "keep" | "discard"): Promise<void>`.

- [ ] **Step 1: Testes que falham** em `restoreBanner.test.ts`: `ask_init` → `text` "A pasta /mnt/x não existe no WSL Ubuntu. Executar o script de inicialização?" e `ask` preenchido (várias pastas: "A pasta X (e mais N)…"); `init` → `busy:true` e texto "Aguardando o init do WSL Ubuntu… 42 s"; `finished` com `pending` → resumo "… 2 terminais aguardando a pasta" e `pending` na info; sem pendentes e tudo OK mantém o aviso curto de 8 s; o texto antigo de "abriram na pasta inicial" some.
- [ ] **Step 2: Rodar e ver falhar:** `node --test tests/restoreBanner.test.ts`
- [ ] **Step 3: Implementar** a lógica pura em `restoreBanner.ts`; em `RestoreBanner.tsx`: botões **Executar** / **Agora não** quando há `ask`, **Continuar assim mesmo** durante o init, e a lista de pendentes com **Continuar tentando**, **Guardar**, **Abrir na pasta padrão**, **Descartar** (chamam os helpers).
- [ ] **Step 4: Rodar:** `node --test tests/restoreBanner.test.ts` e `npx tsc --noEmit`.

### Task 7: Frontend — seção WSL em Configurações

**Files:**
- Create: `bethstudio-web/frontend/src/components/WslInitSettings.tsx`, `lib/wslInit.ts`
- Modify: `components/SettingsDialog.tsx` (seção dentro de "Terminais")
- Test: `bethstudio-web/frontend/tests/wslInit.test.ts`

**Interfaces:**
- Produces: `lib/wslInit.ts` com `type WslInitCfg = { enabled: boolean; command: string; timeout_sec: number; default_dir?: string }`, `validateWslInit(c: WslInitCfg): string | null` (mesmas regras de `validateWSLInit` do Go: ≤ 1024, sem controle, `default_dir` vazio ou com `/`), `loadWslInit(conn)`, `saveWslInit(conn, distro, cfg)`.
- A seção lista as distros de `GET /api/wsl-init`; por distro: interruptor "Inicializar ao restaurar", comando, tempo máximo (s), pasta padrão; salva ao sair do campo; mostra o erro de validação inline.

- [ ] **Step 1: Testes que falham** em `wslInit.test.ts`: `validateWslInit` (comando com `\n` → mensagem; 1025 caracteres → mensagem; `default_dir:"x"` → mensagem; configuração boa → `null`).
- [ ] **Step 2: Rodar e ver falhar:** `node --test tests/wslInit.test.ts`
- [ ] **Step 3: Implementar** o componente e acrescentar o teste ao script `test` do `package.json`.
- [ ] **Step 4: Rodar:** `node --test tests/wslInit.test.ts`, `npx tsc --noEmit`.

### Task 8: Frontend — terminal pendente no lugar do terminal

**Files:**
- Modify: `bethstudio-web/frontend/src/App.tsx` (`renderGone`), componente `GoneLeaf`
- Test: `bethstudio-web/frontend/tests/pendingLeaf.test.ts` (lógica pura em `lib/restoreBanner.ts` ou `lib/pending.ts`)

**Interfaces:**
- Consumes: Task 6 (`RestoreEvent.pending`).
- Produces: `function pendingFor(pending: RestorePendingItem[], pane: number, title?: string, cwd?: string): RestorePendingItem | undefined` (casa por `pane_id` **e** título/cwd, para não confundir com um terminal encerrado comum de mesmo id). `GoneLeaf` ganha a prop opcional `pending` e, quando presente, mostra "A pasta <cwd> não existe no WSL <distro>" com as quatro ações da Task 6.

- [ ] **Step 1: Testes que falham:** `pendingFor` acha pelo id+título; não casa com id igual e título diferente; devolve `undefined` sem pendentes.
- [ ] **Step 2: Rodar e ver falhar:** `node --test tests/pendingLeaf.test.ts`
- [ ] **Step 3: Implementar** e registrar o teste no `package.json`.
- [ ] **Step 4: Rodar:** `node --test tests/pendingLeaf.test.ts`, `npm test`, `npx tsc --noEmit`.

### Task 9: Documentação e verificação final

**Files:**
- Modify: `FEATURES.md` (entrada "Smart WSL start" e o fluxo guiado; data), `CHANGELOG.md` (`[Unreleased]`), a spec (nota do desvio: pendente = folha encerrada com ações, e por quê: reaproveitamento de ids)
- Run: `deploy-ui.ps1` (somente a interface)

- [ ] **Step 1:** Atualizar os três documentos.
- [ ] **Step 2: Verificação completa:** `go build -o NUL .`; `go test -run "WSL|Wsl|DirExists|Ensure|WSLInit|ValidateWSL|ImportWSL|InitTyped|InitMarker|PollInit|AnswerInit|RunInit|TestRestore|Pending|ReviveLeaf|FlushKeeps|RemapKeeps|Coordinator|Carry|Spec|Pane|Classify|UILog" -count=1 .`; `npm test` e `npx tsc --noEmit` em `frontend/`. Esperado: tudo verde.
- [ ] **Step 3:** `powershell -File bethstudio-web\deploy-ui.ps1` e conferir que `bethstudio-host` e `bethstudio-web` seguem com o mesmo `StartTime`.
- [ ] **Step 4:** Registrar no relato final que as mudanças em Go só valem depois de atualizar o Studio e que o teste manual em isolamento (distro com `init-fake`, `BETHSTUDIO_HOST_ID` único, `APPDATA` curto, `BETHSTUDIO_IGNORE_GUI=1`) não foi feito, se for o caso.
