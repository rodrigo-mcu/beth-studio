# Beth Studio — pendências (2026-10-01)

Retrato do que ficou em aberto depois do Studio remoto, do navegador de
pastas, do "Novo arquivo" e da edição em lote no banco. Ordem: do que mais
ajuda no dia a dia para o menos urgente. Tamanho estimado: P / M / G.

## Banco de dados

1. **Aplicar no resultado de consulta do editor SQL** (M). A visão de
   tabela já tem Nova linha / Duplicar / Apagar com Aplicar numa
   transação (`db_rows_apply.go`, `lib/dbChanges.ts`); o resultado de
   SELECT no editor ainda grava célula por célula, na hora
   (`DbQueryPanel.tsx`, `/api/db/row`). Levar o mesmo modelo para lá.
2. **Túnel SSH de verdade** (M). `dbTunnelProvider` nunca recebe valor
   (`db_dialer.go`), então conexão com túnel falha. Ligar ao cliente SSH que o Studio já tem e
   liberar a UI em `DbConnectionDialog.tsx`.
3. **Transação manual entre execuções** (G): modo sem autocommit com
   Commit / Rollback, mantendo uma `sql.Conn` por aba (`db_exec.go`).
4. **Banco/schema atual no editor** (M): no MySQL o banco escolhido é
   ignorado e `USE` não sobrevive entre execuções; no Postgres não há
   `search_path` (`db_api.go` dbResolve, `DbQueryPanel.tsx`).
5. **Mais catálogo na árvore** (M/G): chaves estrangeiras, triggers,
   sequences, DDL da tabela, código das funções, menu do botão direito;
   com as FKs, autocomplete de JOIN e ir ao registro relacionado.
6. **Inserir em tabela sem chave primária** (P). Hoje ela fica só
   leitura; inserir não precisa de chave.
7. **Exportar o resultado inteiro** pelo servidor (hoje só o que está
   na tela), importar CSV, Excel e Markdown (M).
8. **Grade**: seleção de várias células, colar várias linhas, "filtrar
   por este valor"; filtros com OU, IN e WHERE livre (M).
9. **Editor**: parâmetros (`:nome`, `?`) e executar a instrução sob o
   cursor (M).
10. **Abas e rascunhos que sobrevivem ao fechar a janela**; histórico
    maior e por conexão (hoje 40 no total, só no localStorage) (P).
11. **Opções de conexão**: arquivo de CA, certificado de cliente,
    parâmetros extras, colar URL de conexão (M).
12. **Limites configuráveis** (timeout 600 s, 10 mil linhas por página,
    64 KB de texto e 4 KB de binário por célula) e "baixar valor" para
    BLOB inteiro (P/M).
13. **Assistente de IA**: escolher as tabelas citadas antes de cortar
    em 40 por schema; mandar as FKs (P).
14. Plano de execução visual, diagrama ER, comparar schemas (G).

**Riscos conhecidos, sem teste contra servidor de verdade** (não há
MySQL nem SQL Server na máquina de desenvolvimento):

- `KILL QUERY` ao cancelar no MySQL (`dbRunning.armKill`).
- EXPLAIN no SQL Server com `GO`; em conexão somente leitura ele roda
  dentro da transação, e não foi conferido se o `SET SHOWPLAN` é aceito
  ali.
- Somente leitura no SQL Server depende só da checagem do SQL e do
  rollback: o driver não aceita transação ReadOnly (`db_exec.go`).

## Studio remoto e celular

- **Layout nos dois Studios ao mesmo tempo**: a última gravação vence
  (`/api/layout`). Abrir/fechar abas no navegador muda o Studio do PC.
- **A−/A+ no Studio remoto** muda a fonte daquele terminal também no PC
  (a configuração por terminal é compartilhada).
- Botões menos usados respondem "Disponível só no PC" em vez de sumir no
  remoto: Uso de IA → Abrir, Sobre → mostrar arquivo, SFTP → mostrar no
  Explorer, Voz → abrir página de chaves / preços.
- **App do celular num aparelho de verdade**: conferir login, texto,
  imagem e voz depois da checagem de origem (Origin) e do
  `Referrer-Policy: same-origin`. Os testes automáticos passam; o
  aparelho não foi testado depois da mudança.
- `maximum-scale=1` no `phone.html` (para a caixa de texto não dar zoom
  no iPhone) impede a pinça no Android.

## Arquivos e pastas

- "Procurar…" num terminal WSL que está em `/home/...`: o navegador de
  pastas não abre lá (`explorerStart` só converte `/mnt/<letra>`); abre
  na última pasta usada. Precisa saber a distro do terminal.
- Painel "Sem título": a dica do título mostra `untitled:` (o caminho
  interno).

---


# WezTerminator — O que falta (snapshot 2026-06-08)

**Data:** 2026-06-08
**Autor:** Claude (Opus 4.8)

Este documento lista **tudo o que NÃO está pronto** mas deveria
estar, em ordem de prioridade e dificuldade estimada. Cada item
indica o que precisa ser feito, o que está no caminho, e uma
estimativa de linhas de código.

## TL;DR — três grandes categorias

1. **Visual render do header (0030.5)** — feature de header
   data model + persistência estão prontas, mas o header
   NÃO aparece dentro do terminal. É o que falta para fechar
   o que o usuário pediu em 0030.

2. **Stubs vazios do `wtinator`** — 8 módulos declarados
   no `lib.rs` mas nunca preenchidos. Roadmap original
   previa esses features, mas o user não pediu nenhum
   explicitamente.

3. **Limitações/parâmetros "você quer mesmo?"** — algumas
   decisões que o user tomou no passado e que valem
   revisitar.

---

## 1. Visual render do per-terminal header (0030.5)

**Status:** Data model pronto, dialog de rename pronto,
persistência pronta. **Falta o render visual.**

**O que o user pediu em 0030 (2026-06-08):**
> "colocar um header em cada terminal mostrando qual terminal
> é e podendo nomear ele"

"O que está pronto":
- Click direito → "Rename terminal…" → dialog Win32
  aparece → user digita nome → Enter → nome persiste em
  `session.json` → próxima sessão restaura
- `Tab::set_header_text(Some("build-watch"))` funciona

"O que NÃO está pronto":
- Nenhuma linha visível com "Tab #3 · group: frontend ·
  build-watch" aparece DENTRO do terminal
- O `build_header(tab, tab_index)` formata a string
  corretamente (testado em 5 unit tests) mas o renderer
  não a desenha

### Como implementar (estimativa: ~150-300 linhas, risco médio)

**Decisão de design (não-trivial):** o header deve
"rolar junto com o scrollback" (vim modeline style,
decisão do user). Há dois caminhos:

**Caminho A — render-only marker (recomendado):**
- No `wezterm-gui/src/termwindow/render/pane.rs`,
  desenhar a linha do header ANTES da primeira linha
  do conteúdo do pane (overlay)
- Ajustar `dims.viewport_top` em +1 quando o header
  está visível, para o conteúdo "empurrar para baixo"
- Cuidar com:
  - `cursor.coords` — cursor do shell deve aparecer 1
    linha abaixo
  - `selection_y` — cliques/arrastes precisam entender
    que linha 0 é o header
  - `mouseevent.rs` — clicks na linha do header não
    devem ir para o shell
- Risco: quebrar vim, htop, less, tmux (TUIs que
  detectam tamanho do terminal via TIOCGWINSZ /
  CursorPosition)
- Mitigação: adicionar config
  `wtinator.disable_header_for_tui` que desabilita o
  header para processos cujo nome casa com a lista
  `{vim, htop, less, tmux, vi, nano, emacs, fzf, ...}`

**Caminho B — injetar no scrollback:**
- Inserir uma linha de texto no scrollback do pane via
  `TerminalState::set_line()`
- A linha é parte do scrollback do shell — rola junto
  naturalmente
- Risco alto: corrompe TUI apps que contam linhas
  exatas
- Mais simples em código mas mais arriscado em uso

**Recomendação:** começar com Caminho A, testar com
vim/htop, e cair para B se quebrar.

### Código que precisa mudar

| Arquivo | Linhas estimadas | O que |
|---|---|---|
| `upstream-wezterm/wtinator/src/header.rs` | +30 | API `draw_header(quad_alloc, x, y, width, text, color)` |
| `upstream-wezterm/wezterm-gui/src/termwindow/render/pane.rs` | +150 | Ajustar `viewport_top`, renderizar overlay |
| `upstream-wezterm/wezterm-gui/src/termwindow/render/mod.rs` | +50 | Helpers de cor/fonte para o header |
| `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` | +20 | Cursor position adjustment |
| `upstream-wezterm/wtinator/src/header.rs` (test) | +50 | Tests de formatação adicional |

---

## 2. Stubs vazios do `wtinator` (roadmap original)

Estes módulos estão declarados no `wtinator/src/lib.rs`
mas o conteúdo é apenas `// stub`. O roadmap original do
projeto previa implementar todos. O user não pediu
nenhum explicitamente — são candidatos para iterações
futuras se/quando o user pedir.

### 2.1 `wtinator::broadcast` — broadcast input
- **O que seria:** digitar em um pane envia o mesmo
  input para todos os panes ativos (similar ao
  "Broadcast Input" do MobaXterm)
- **Como:** hook no `keyevent.rs` antes do
  `pane.key_down`; se o modo broadcast estiver ativo,
  itera por todos os panes do window e envia o
  mesmo `KeyEvent`
- **Estimativa:** ~100 linhas
- **UI:** toggle no right-click menu + indicador visual
  no status bar (um "BC" badge)

### 2.2 `wtinator::clipboard` — smart-paste pipeline
- **O que seria:** detecta o que está no clipboard
  (imagem, URL, texto longo, comando, etc.) e sugere
  ação: paste image, open URL, paste formatted, paste
  plain
- **Como:** no `paste_from_clipboard` (já existe em
  wezterm-gui), antes do paste, inspecionar o clipboard
  e mostrar um menu de opções se o conteúdo for
  ambíguo
- **Estimativa:** ~200 linhas
- **Complexidade:** alta (heurística de classificação)

### 2.3 `wtinator::vscode_settings` — VSCode settings import
- **O que seria:** além do font (patch 0023), importar
  outras settings do VSCode (terminal.integrated.fontFamily,
  terminal.integrated.cursorStyle, etc.) e aplicar como
  overrides
- **Como:** estender o `wtinator::vscode_font` para ler
  mais chaves; expor via `default_overrides()`
- **Estimativa:** ~80 linhas

### 2.4 `wtinator::config_lua` — Lua helper API
- **O que seria:** expor a API do WezTerminator para
  `wezterm.lua`, permitindo o user configurar groups,
  default shells, etc. via Lua
- **Como:** registrar funções em
  `wtinator::install()` que chamam
  `lua.create_function(...)` ou similar
- **Estimativa:** ~300 linhas (precisa entender o
  binding Lua do wezterm)
- **Risco:** alto (Lua API é frágil, quebrou no wezterm
  no passado)

### 2.5 `wtinator::picker` — picker genérico
- **O que seria:** framework reutilizável para os vários
  pickers (shell, split, theme, group)
- **Status:** provavelmente não é necessário — os
  pickers já são implementados inline em
  `context_menu.rs`. Pode ser deletado ou ficar como
  stub para sempre.

### 2.6 `wtinator::status_bar` — status bar nativa
- **O que seria:** uma barra de status nativa (não
  dentro do terminal) com informações de cada pane
  (cwd, status git, exit code, etc.)
- **Como:** usar a mesma infra do titlebar (patch 0020)
  com `FancyTabBar` ou custom; subscrever-se a
  `MuxNotification::PaneOutput` para pegar cwd
- **Estimativa:** ~400 linhas
- **Complexidade:** alta (precisa entender modelo de
  notificação do mux)

### 2.7 `wtinator::layout_io` — save/load layout
- **O que seria:** salvar a geometria de cada pane
  (split ratios, sizes absolutos) e restaurar
- **Já está parcialmente coberto** por 0029 (que salva
  groups). Falta geometria de splits
- **Estimativa:** ~150 linhas
- **Prioridade:** baixa (split ratios default funcionam
  bem)

### 2.8 `wtinator::shell_menu` — shell picker
- **O que seria:** submenu "Shells" no right-click com
  todos os shells disponíveis
- **Já está implementado** em `context_menu.rs` linhas
  ~570-700 (função `shell_picker_items()`)
- **Status:** stub no `wtinator::shell_menu` é misleading
  — o código real está em `context_menu.rs`
- **Ação:** ou deletar o stub ou mover o código para
  `wtinator::shell_menu`

---

## 3. Decisões a revisitar

### 3.1 Dialog Win32 do Rename (0030)

**Estado atual:** dialog Win32 nativo, ~200 linhas de
unsafe, threading model com `std::thread::spawn` para
não congelar a main thread.

**Alternativa que não foi escolhida:** `rfd` (Rusty File
Dialogs) tem `rfd::AsyncFileDialog::add_prompt()` que
faria o mesmo. Vantagens:
- Portável (mesmo código no Linux/macOS)
- Sem unsafe (o `rfd` encapsula a Win32 API)
- Menos código

**Por que não foi usado:** o user disse "pode abrir uma
janela nativa do windows sem problema", o que
sugeriu não adicionar deps novos. Mas se a estética
Win32 não for requisito, `rfd` seria uma limpeza
significativa (~150 linhas a menos, sem unsafe no
nosso código).

### 3.2 Auto-save timer (0029)

**Estado atual:** 30s hardcoded. Cancelado via
`Arc<AtomicBool>` quando a janela fecha.

**Alternativas:**
- Tornar configurável (`wtinator::config.session_save_interval_secs`)
- Salvar em mudanças significativas (group move, header
  change) em vez de timer
- Salvar em SIGINT/exit também (Windows: WM_ENDSESSION)

**Prioridade:** baixa — 30s é razoável.

### 3.3 Schema do session.json (0029)

**Estado atual:** schema v2. v1 files parseiam transparente
(via `serde(default)`). Aceita qualquer versão ≤ 2;
rejeita > 2.

**Decisão a fazer:** se o schema mudar de novo (ex: para
suportar geometria de splits), bump para v3. v1 e v2
devem continuar parseando. O código atual rejeita
silenciosamente v3+ (usuário tem que deletar o arquivo).

**Alternativa melhor:** fazer o load() tentar todas as
versões conhecidas em sequência (v3 → v2 → v1) e
aplicar migrations. Mais robusto.

### 3.4 Header visual (0030.5)

**Decisão de design precisa:** o user quer
- Rola junto com scrollback (decidido)
- Mas: header com altura de 1 linha é suficiente? Ou
  precisa de mais (icon + nome + group, estilo
  breadcrumb)?
- Cor: preto sobre branco, ou tema-aware?

**Recomendação:** 1 linha simples com texto cinza médio
sobre fundo off-white, separando group / title com "·".
Mínimo invasivo.

### 3.5 Detecção de TUI para desabilitar header

**Decisão pendente:** como detectar que o pane está
rodando um TUI (vim, htop, etc.) e desabilitar o
header automaticamente?

**Opções:**
- Lista hardcoded de process names (vim, htop, less, ...)
- Heurística: se o cursor está em `(0, 0)` E o terminal
  emitiu `CSI ? 1049 h` (alternate screen) → TUI
- Config: `wtinator.disable_header_for_tui: true/false`
  default true

**Recomendação:** config flag + lista hardcoded
(heurística do alternate screen é complexa e propensa
a falsos positivos).

---

## 4. Memory notes (referência rápida)

As notas de memória em
a pasta de memória do agente (fora do repositório)
têm observações adicionais que valem revisitar:

- `ctrl-v-paste-garbage-bug.md` — falso alarme (user
  confirmou que Ctrl+V está OK, era mal-entendido).
  Mas documenta que a interceptação
  `clipboard.rs` → `image_paste.rs` EXISTE e o
  `prompt_rename` tem `cfg(windows)` que é o caminho
  "se você tiver uma imagem, cola markdown link" no
  Ctrl+V. Se o user reclamar no futuro, é o caminho
  a investigar.

- `move-terminal-between-groups-feature.md` — análise
  pre-implementação do feature 0028. Já implementada,
  nota é histórica.

- `save-restore-session-feature.md` — análise
  pre-implementação do feature 0029. Já implementada,
  nota é histórica.

- `phase-0-build-environment.md` — Rust nightly
  2026-06-05, PATH Windows (Strawberry perl + nmake).
  Ambiente de build. Atualizar quando a versão mudar.

- `right-click-menu-architecture.md` e
  `native-menu-architecture.md` — histórico da migração
  Skia → native menu. Documentação arquitetural,
  nenhuma ação.

---

## 5. Coisas pequenas / polimento

- **`executable_output.md`**: documenta workaround para
  apps GUI que só mostram output no MobaXterm. Se a
  versão do MobaXterm mudar, o workaround pode quebrar.
  Verificar periodicamente.

- **MobaXterm local bash (0026)**: documenta que não
  reproduz o bridge de terminal do MobaXterm real. O
  user aceitou como "frescura". Se o user quiser
  mais funcionalidade aqui, precisa de pesquisa
  séria sobre como o MobaXterm implementa o conin.exe.

- **`scripts/EXECUTABLE_OUTPUT.md`** menciona que o
  seguir o log do próprio app (via `shells.json`, patch 0183)
  é o caminho confiável. Se o app parar de escrever nesse
  log, esse caminho quebra.

- **Cursor contrast (0024)**: dead-band de [0.45, 0.55]
  é razoável mas pode causar surpresas em temas
  com background exatamente cinza. Considerar
  expor `wtinator::cursor_color_threshold`.

---

## Próxima sessão: priorização sugerida

Se o user voltar e disser "implementa o que falta",
a ordem de prioridade que recomendo é:

1. **0030.5 — render do header** (resolve o que falta
   da feature atual, ~150-300 linhas, risco médio)
2. **`wtinator::status_bar`** se o user pedir (feature
   grande, alto risco, alto valor)
3. **`wtinator::broadcast`** (feature pequena, baixo
   risco, valor questionável)
4. **Decisão sobre `rfd` vs Win32 nativo** no dialog
   de rename (refactor cosmético)

Os outros (clipboard pipeline, vscode_settings,
config_lua, layout_io) podem esperar até o user pedir
explicitamente.

---

## Backlog noted 2026-06-13

Três itens registrados nesta sessão (NÃO implementados —
apenas anotados para investigação futura):

- **Copy/paste sometimes copies the wrong character** —
  investigate the clipboard copy path
  (`KeyAssignment::CopyTo` → `selection_text` →
  `copy_to_clipboard`) plus the Windows clipboard write.
  Possible wide-char / grapheme boundary issue or
  CRLF / encoding mismatch. Needs a repro before any fix.

- **Image copy/paste in claude-code** — verify the patch
  0022 OSC 1337 / Markdown file-link path works
  end-to-end inside claude-code. Related memory note:
  `ctrl-v-paste-garbage-bug.md`.

- **macOS-style typing cursor effect** — the user wants a
  macOS Terminal / iTerm-like cursor (smooth blink easing
  / trail). Investigate `default_cursor_style`,
  `cursor_blink_rate`, `cursor_blink_ease_in` /
  `cursor_blink_ease_out`, and `animation_fps`; may need a
  render addition. User goal: "o terminal tem que ser
  funcional, e bonito".

- **Per-terminal (per-pane) font family + size** — DEDICATED
  PROJECT (user chose this path 2026-06-13). Today font +
  size are window-global (`TermWindow.render_metrics` /
  `self.fonts` are window-scoped; `IncreaseFontSize` /
  `DecreaseFontSize` in `termwindow/resize.rs` change the
  whole window's scale). wezterm renders the window on ONE
  uniform cell grid, so per-pane font requires: per-pane
  `RenameMetrics`/`cell_size`, a per-pane shaping cache,
  reworking the split-tree layout math (sizes are in cells),
  per-pane mouse coordinate mapping, and the renderer. This
  is a multi-day, high-risk change to the render core — must
  be its own patch with a detailed plan written first. NOT a
  parallel-agent task. Pain point: "eu mudo a fonte de um
  terminal o tamanho dela muda em todos".
