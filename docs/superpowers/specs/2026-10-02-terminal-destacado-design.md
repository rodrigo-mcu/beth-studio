# Terminal destacado em janela nativa (Beth Studio)

Data: 2026-10-02. Estado: aprovado em conversa, aguardando revisão deste spec.

## Objetivo

Deixar um terminal ou uma sessão SSH "solto" como janela nativa do Windows,
que pode ir para outro monitor. Depois, arrastar essa janela de volta para um
painel, aba ou "+" do Beth Studio para reencaixar. Fechar a janela destacada
não encerra o terminal: ele continua rodando e volta para a lista de terminais.

Critérios de sucesso:

1. Destacar um pane (terminal ou SSH) abre uma janela nativa com o mesmo
   conteúdo ao vivo, e o pane some das abas do Studio.
2. A janela pode ser movida para outro monitor e redimensionada.
3. Arrastar o cabeçalho da janela e soltar sobre uma zona do Studio
   (painel, aba ou "+") reencaixa o pane ali.
4. Fechar a janela (X) nunca chama `kill`: o pane volta para "não organizado"
   na lista e continua rodando no host.
5. Nenhum processo `bethterm-host` ou `bethterm-gui` é tocado.

## Fora do escopo

- Studio remoto e celular (`isRemote`): o botão Destacar fica escondido.
- Reabrir automaticamente as janelas destacadas depois que o Studio reinicia
  (os panes aparecem na lista como soltos).
- Mais de um pane por janela destacada.

## Contexto do código

- Os PTYs vivem no host nativo. O Go sobe `bethterm.exe cli bridge`, e o
  `hub` (Go) repassa tudo por WebSocket `/ws` para o frontend React.
- O layout web (abas + splits) só referencia `pane_id`, é gravado em
  `web-settings.json` por `/api/layout` e manipulado por funções puras em
  `frontend/src/lib/layout.ts` (testadas em `frontend/tests/layout.test.ts`).
- Fechar um pane já só desanexa do layout (`act.unorganize` -> `detachPane`).
  Matar só pelo `KillDialog` -> `conn.kill`.
- Drag-and-drop entre lista, painéis e abas usa HTML5 nativo
  (`lib/dnd.ts`, `DropZones` em `SplitView.tsx`, alvos em `TabBar.tsx`).
- Segunda janela nativa hoje só existe como processo separado
  (`--db` em `db_window_windows.go`, `--sftp` em `sftp_window.go`), cada um
  com servidor próprio e sem bridge. O host WebView2 é
  `webhost_windows.go` (`openWindow`), com janela sem moldura
  (`winframe_windows.go`, comandos `win:...`).

## Abordagem

Janela destacada = processo `bethterm-web.exe --term <pane_id> --url <url do
Studio>`, com seu próprio WebView2. Em vez de subir servidor e bridge
próprios, ela navega para o servidor do Studio que já está rodando, em
`/?t=<token>&mode=term&pane=<pane_id>`, e usa o mesmo `/ws` e o mesmo `hub`.

Descartados: segundo WebView2 no mesmo processo (o código assume uma janela
por processo e bloqueia `window.open`) e servidor/bridge próprios por janela
(duplica estado e o host).

## Componentes

### 1. Layout (`frontend/src/lib/layout.ts`)

- `Layout` ganha `detached: string[]` (pane_ids destacados), persistido junto
  com as abas e normalizado ao carregar (campo ausente = `[]`).
- Funções puras novas:
  - `detachToWindow(layout, pane)`: remove o pane da árvore de abas
    (`detachPane`) e o adiciona a `detached`.
  - `attachFromWindow(layout, pane, destino)`: remove de `detached` e insere
    no destino (zona de painel, aba ou nova aba), reusando `dropOnPane`,
    `movePaneToTab`, `addTab`.
  - `closeDetached(layout, pane)`: remove de `detached`; o pane fica "não
    organizado" (não entra em nenhuma aba).
  - Reconciliação com a lista do host: pane que sumiu do host sai de
    `detached`.
- Um pane em `detached` não aparece como "solto" na lista; aparece marcado
  como "em janela destacada" e, ao clicar, a janela é trazida para a frente.

### 2. Go: janela destacada

- Nova flag `--term <pane_id> --url <url>` em `main.go`, tratada por
  `term_window_windows.go` (modelo de `db_window_windows.go`): reexecuta o
  próprio exe, `webviewDataName` próprio, janela sem moldura via
  `applyFrame`, tamanho e posição iniciais perto da janela do Studio.
  Sem servidor HTTP nem bridge próprios.
- Endpoint no servidor do Studio, `POST /api/term/detach` `{pane_id}`, só
  aceito de origem local (não remoto), que lança o processo `--term` e
  registra o PID. O comando é montado no Go; nunca vem do navegador.
- O `hub` guarda o mapa `pane_id -> processo da janela` para: trazer a janela
  para a frente, avisar o Studio quando ela fecha (evento WS `term_closed`)
  e fechar todas as janelas quando o Studio encerra. Fechar essas janelas
  mata só o processo da janela, nunca o host nem o pane.
- Impedir duplicata: destacar um pane já destacado só foca a janela
  existente.

### 3. Frontend: modo `term`

- `main.tsx` reconhece `mode=term` e monta `TermWindowApp`: cabeçalho próprio
  (nome do pane, botão "Encaixar", botão fechar) mais o `TerminalView` do
  pane, ocupando a janela toda. Usa `Connection` normal e `setWatched` com
  esse pane.
- O cabeçalho é a alça de movimento da janela nativa (comandos `win:...`
  existentes) e a alça do arrasto de reencaixe.
- No Studio: botão "Destacar" no cabeçalho do `TerminalView` e item no menu
  de contexto da lista (`PaneMenu`). Escondidos quando `isRemote`.
- `setWatched` do Studio considera panes destacados só se a janela destacada
  não os observa (cada cliente WS tem seu conjunto; respeita o limite de 16
  por cliente já existente).

### 4. Reencaixar

- **Botão "Encaixar"** na janela: o Studio insere o pane na aba ativa e a
  janela fecha.
- **Arrastar de volta**: HTML5 DnD não atravessa processos, então o arrasto
  é manual. Ao arrastar o cabeçalho da janela destacada, o Go (que já recebe
  os comandos `win:...`) lê a posição do cursor em coordenadas de tela
  enquanto o botão está pressionado e envia ao Studio, por evento WS
  `term_drag {pane, x, y, fim}`. O Studio converte para coordenadas do
  cliente, usa `elementFromPoint` para achar a zona sob o cursor, acende as
  mesmas zonas de soltar de hoje e, no `fim`, aplica `attachFromWindow` com
  o destino encontrado. Se soltar fora de qualquer zona, a janela só fica
  onde está (move normalmente).
- O Studio precisa estar visível; se estiver minimizado, soltar não encaixa.

### 5. Fechar a janela

- X da janela: processo encerra; o Go emite `term_closed {pane}`; o Studio
  aplica `closeDetached`. Nada de `kill`. Segue a regra já documentada em
  `killFlow.ts` e coberta por `tests/kill.test.ts`.

## Erros e casos de borda

- Pane some do host (`gone`): a janela destacada mostra o marcador de
  encerrado e oferece só fechar; o Studio limpa `detached` na reconciliação.
- Studio reinicia: janelas fecham junto; `detached` é limpo ao carregar
  (panes ficam soltos na lista).
- Processo `--term` morre sem aviso: o `hub` detecta o fim do processo e
  emite `term_closed`.
- Falha ao lançar a janela: o pane permanece na aba (a mudança de layout só
  é gravada depois que o Go confirma que a janela abriu).

## Regras do projeto respeitadas

- Não toca em `bethterm-host.exe` nem `bethterm-gui.exe`; sem `kill`.
- Não instala sobre o host em uso; testes manuais com build isolado.
- Sem menção a nomes internos da organização em código, docs ou UI.
- Atualizar `FEATURES.md` (e a data `Atualizado`) no mesmo conjunto de
  mudanças. Alterações em arquivos upstream do wezterm: nenhuma prevista
  (tudo em `bethterm-web/`); se surgir alguma, registrar em `PATCHES.md`.
- Build com prioridade baixa, `jobs=8` (ver memória de build).

## Testes

- Unitários (`frontend/tests/layout.test.ts`): `detachToWindow`,
  `attachFromWindow` (painel, aba, nova aba), `closeDetached`,
  reconciliação com pane `gone`, normalização de layout antigo sem
  `detached`.
- Go: teste do mapa de janelas do `hub` (registro, duplicata, fim do
  processo) e da validação do endpoint (rejeita remoto e `pane_id`
  inválido).
- Manual, em Studio isolado: destacar terminal e SSH, mover para outro
  monitor, arrastar de volta para painel, aba e "+", fechar pelo X e
  conferir que o terminal segue na lista e no host (`cli list`).
