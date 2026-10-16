# WSL: inicialização guiada e pastas ausentes na restauração

Data: 2026-10-16. Estado: **aprovada** em 2026-10-16 e implementada (ver o plano em `docs/superpowers/plans/2026-10-16-wsl-init-na-restauracao.md`).

> **Desvio registrado na implementação (§5.4).** O Go remove terminais encerrados das abas abertas (`dropEndedOpenTabs`), então o pendente não pode ser um bloco dentro da aba. Ele vive na **lista do banner** (com as quatro ações), na receita e como folha encerrada em grupo fechado do layout; ao abrir, a folha é revivida ali e o terminal volta na grade como "Aba fechada “nome”" (clicar reabre a aba). O id do pendente na receita é deslocado (`1_000_000 + id`) porque o host reaproveita os ids baixos. A POST de gravação usa o padrão do projeto (POST, não PUT). O Go apaga a folha encerrada da aba aberta (não a move para "fechadas"), então logo depois do remap o Studio a guarda num grupo fechado (`parkPending`). O limite do job passou de 15 min para 1 hora, e se o contexto acabar o que não abriu vira pendente em vez de sumir da receita.

## 1. Problema

Depois de reiniciar o PC o host sobe novo e vazio, e o Studio recria os
terminais a partir de `pane-specs.json` (`restore.go`, `restore_coord.go`).
Em algumas máquinas o WSL2 só monta os discos (por exemplo `/mnt/kingston`)
depois de um comando de inicialização que o usuário digita na mão
(`init-wsl2`), e esse comando pode abrir o UAC do Windows ou pedir senha.

Hoje:

- `wsl_ready.go` roda um `init` **em silêncio** (lido de
  `wsl-distros.json`, sem tela de configuração), dentro da distro, não
  interativo (`sh -c`, sem UAC nem senha, sem o PATH do `.bashrc`).
- Se a pasta de um terminal não aparece em 30 s, o terminal abre **na home,
  sem avisar** (`Fallbacks`), e a pasta de trabalho se perde.
- Nenhuma tela configura isso. O usuário final não vai editar JSON.

## 2. O que o usuário pediu (e o que é premissa)

Dito pelo usuário:

1. Configurar pela tela do Studio, nunca por JSON, e por distro (o software
   não é só para um usuário).
2. Na restauração, se a pasta de um terminal WSL não existe, **perguntar** se
   quer executar o script de init.
3. Se escolher executar, **esperar** terminar antes de abrir os outros
   terminais WSL. O usuário atende o UAC/senha num terminal de verdade.
4. Se mesmo assim a pasta não existir, avisar **no lugar do terminal**,
   perguntando se continua tentando ou se **guarda**, porque depois do init
   a pasta geralmente passa a existir.
5. Nada é descartado sem o usuário pedir.

Premissas minhas (marcadas para você corrigir):

- **P1.** "Guardar" = manter o terminal reservado e fora do ar, com a receita
  e o lugar no layout preservados, sem abrir na home.
- **P2.** O terminal de inicialização fecha sozinho se o comando terminou com
  sucesso e fica aberto se houve erro.
- **P3.** O init só é oferecido quando falta pasta, e no máximo uma vez por
  boot do Windows e por distro.
- **P4.** A pasta padrão para "Abrir na pasta padrão" é a home do WSL, com
  campo opcional na tela.

## 3. Fora do escopo

- Terminal WSL aberto à mão pelo usuário (`server.go`, `case "spawn"`): segue
  como está (espera a distro e cai na home se a pasta não vier).
- Terminais que não são WSL: abrem direto, sem esperar o init.
- Montar disco por conta própria. O Studio só dispara o **comando do
  usuário**.
- Contornar UAC ou senha. Quem responde é o usuário.

## 4. Configuração (tela)

Nova seção **Configurações > Terminais > WSL**, uma linha por distro
instalada (`listWSLDistros()`):

| Campo | Padrão | Observação |
|---|---|---|
| Inicializar ao restaurar | desligado | liga o fluxo da seção 5 |
| Comando | vazio | como digitaria no terminal (`init-wsl2`) |
| Tempo máximo (s) | 300 | conta desde o envio do comando |
| Pasta padrão | vazio (= home) | usada em "Abrir na pasta padrão" |

Botão **Testar agora**: abre o terminal de inicialização com o comando e
mostra o resultado (seção 5.3), sem restaurar nada.

Armazenamento: novo campo `WSLInit map[string]WSLInitCfg` em `webSettings`
(`settings.go`), chave = nome da distro em minúsculas. Endpoints
`GET/PUT /api/wsl-init` no mesmo estilo dos de voz.

Migração: se existir `wsl-distros.json`, o `init` dele é importado uma vez
para `WSLInit` (com "Inicializar ao restaurar" ligado) e o arquivo deixa de
ser lido. A execução silenciosa em `wslGate.Ensure` é **removida**: o init
passa a rodar só pelo fluxo guiado.

## 5. Fluxo da restauração

Fica em `restore.go`; a decisão do usuário entra por um canal, como o
`awaitSpawn` de `restore_wire.go`.

### 5.1 Etapas

1. **Não-WSL e WSL com pasta OK:** conferir as pastas de uma vez (`test -d`,
   sem esperar 30 s). Terminais que não são WSL abrem logo.
2. Subir cada distro necessária (`Ensure`, sem init).
3. Se há pasta ausente em alguma distro:
   - com init configurado e ligado: etapa `ask_init` (seção 5.2) e bloqueia
     os terminais WSL **dessa distro** até a resposta;
   - sem init configurado: segue direto para 5.4 e o aviso diz onde
     configurar.
4. **Executar:** terminal de inicialização (5.3); depois reconferir pastas.
5. **Agora não:** os terminais com pasta ausente viram pendentes (5.4).
6. Abrir os terminais WSL com pasta OK (paralelo 3, como hoje).
7. Terminais com pasta ainda ausente viram pendentes.

### 5.2 Pergunta

Evento `restore` com `stage: "ask_init"`, `distro` e a lista de pastas
ausentes. O banner (`RestoreBanner`) mostra "A pasta X não existe no WSL
<distro>. Executar o script de inicialização?" com **Executar** e **Agora
não**. A resposta vai em `POST /api/restore/answer`
(`{distro, action: "run"|"skip"}`). Sem resposta, a restauração fica
esperando (os terminais não-WSL já abriram); o limite geral de 15 min do
job continua valendo.

### 5.3 Terminal de inicialização

- Abre um terminal WSL visível da distro pelo mesmo `Spawn` da restauração
  (`hubRestoreEnv.Spawn`), na home.
- Envia o comando por `paste` da bridge, seguido de uma linha que grava o
  código de saída num arquivo marcador dentro da distro
  (`/tmp/.bethstudio-init-<boot_id>`), por exemplo
  `init-wsl2; echo $? > /tmp/.bethstudio-init-…`. Por ser shell interativo,
  PATH, alias, `sudo` e UAC funcionam como quando o usuário digita.
- Término, o que vier primeiro: (a) marcador existe, com o código de saída;
  (b) o usuário fecha o terminal; (c) tempo máximo; (d) botão **Continuar
  assim mesmo** no banner.
- Sucesso (código 0): o terminal fecha sozinho (P2). Erro ou tempo
  esgotado: fica aberto, e o banner mostra o motivo.
- O banner mostra "Aguardando o init do WSL <distro>…" com o tempo corrido.
- O init é registrado em `host-life.log` (`lifeLog`) com distro, código e
  duração.

### 5.4 Terminais pendentes

Um terminal cuja pasta continua ausente **não abre** e fica na receita.

- `restoreResult` ganha `Pending []restorePending` (id antigo, título,
  distro, pasta). `Fallbacks` deixa de existir para restauração.
- **Layout:** `remapPanesFrom` hoje marca como `Gone` toda folha sem id novo,
  e os pendentes sumiriam do layout. Passa a receber o conjunto de pendentes
  e **não toca** nessas folhas (nem remapeia, nem marca `Gone`).
- **Receita:** os pendentes continuam em `pane-specs.json`. Enquanto houver
  pendente, a receita **não é sobrescrita** pela lista viva (hoje o
  coordenador regrava a cada lista), senão eles se perdem.
- **Interface:** no lugar de cada pendente aparece um cartão com o nome, a
  pasta e as ações:
  - **Continuar tentando** (reconfere agora; em seguida a cada 15 s por até
    5 min, enquanto o cartão estiver visível, e então para);
  - **Guardar** (para de tentar, o cartão fica com "Tentar de novo");
  - **Abrir na pasta padrão**;
  - **Descartar** (única ação que apaga a receita e a folha do layout).
- Quando a pasta aparece, o terminal abre sozinho no lugar do cartão e o
  layout é remapeado só para ele.

### 5.5 Pendência entre sessões

Pendentes guardados sobrevivem a fechar e abrir o Studio enquanto o host
vive. Se o host cair, o fluxo recomeça pela etapa 1.

## 6. Mudanças por arquivo

| Arquivo | Mudança |
|---|---|
| `wsl_ready.go` | remove a execução silenciosa do init; fica `Ensure` (distro viva), `WaitDir`, e `DirExists` (checagem única); importa `wsl-distros.json` |
| `restore.go` | etapas 5.1, canal de decisão, `Pending` |
| `restore_wire.go` | `ask_init`, terminal de inicialização, `Pending` no evento `finished`, retentativas |
| `restore_coord.go` | não regravar a receita enquanto houver pendentes |
| `settings.go`, `settings_remap.go` | `WSLInit`; `remapPanesFrom` preserva folhas pendentes |
| `server.go` | `GET/PUT /api/wsl-init`, `POST /api/restore/answer`, ações dos pendentes |
| `frontend/src/lib/restoreBanner.ts`, `components/RestoreBanner.tsx` | perguntas, espera do init, "Continuar assim mesmo" |
| `frontend/src/components/` | cartão de terminal pendente; seção WSL em Configurações |
| `FEATURES.md` | atualizar a entrada "Smart WSL start" e acrescentar o fluxo guiado |
| `upstream-wezterm/` | **nenhuma mudança** (tudo no Studio) |

## 7. Riscos e pontos a verificar no plano

- **R1.** Como o frontend trata hoje uma folha de layout cujo `pane_id` não
  existe na lista viva. Se ela é descartada na renderização, o cartão
  pendente precisa de um tipo de folha novo. Verificar antes de codar.
- **R2.** Digitar no terminal recém-aberto: o `paste` deve ser aceito antes
  de o shell terminar de subir (a entrada fica na fila do tty). Testar com
  a distro fria.
- **R3.** O arquivo marcador usa o boot_id da distro, que `wslGate` já lê.
  Se a leitura falhar, vale só o fim por fechamento do terminal, tempo
  máximo ou botão.
- **R4.** A receita fica congelada com pendentes; definir o que acontece se
  o usuário fechar um terminal normal nesse meio-tempo (proposta: a receita
  só muda para os terminais vivos, e os pendentes seguem intactos).
- **R5.** Segurança: o comando vem da configuração do próprio usuário e é
  enviado como texto digitado ao terminal; a API de configuração exige a
  mesma sessão/modo não somente-leitura das outras.

## 8. Testes

- `restore_test.go` com fakes: pasta OK; pasta ausente + usuário executa +
  passa a existir; pasta ausente + "agora não"; init termina e a pasta
  continua ausente (pendente); sem init configurado; várias distros; canal
  nunca respondido (cancelamento por contexto).
- `settings_remap_test.go`: folhas pendentes não viram `Gone` nem são
  remapeadas.
- `restore_coord_test.go`: receita não é sobrescrita com pendentes.
- `wsl_ready_test.go`: importação do `wsl-distros.json`; `DirExists`.
- Frontend: `restoreBanner.test.ts` para os novos estágios.
- Manual, em isolamento (`BETHSTUDIO_HOST_ID`, `APPDATA` curto,
  `BETHSTUDIO_IGNORE_GUI=1`), sem tocar no host do usuário: distro com um
  `init-fake` que cria uma pasta depois de alguns segundos.

## 9. Ordem de entrega sugerida

1. Backend: `DirExists`, etapas e `Pending`, preservação no remap e na
   receita, com testes.
2. Banner: pergunta, espera do init, continuar assim mesmo.
3. Configuração em tela e migração do `wsl-distros.json`.
4. Cartão de terminal pendente e suas ações.
5. `FEATURES.md`.
