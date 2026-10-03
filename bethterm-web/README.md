# Beth Studio

Beth Studio é a interface (Go + React, WebView2) para os terminais do
BethTerm: organização, aparência e funções próprias — independentes da
GUI clássica (WezTerm).

Abre pelo menu da bandeja do BethTerm ("Beth Studio", patches 0173 /
0186 do `upstream-wezterm`) ou diretamente:

```powershell
.\bethterm-web.exe
```

## Como funciona

```
navegador (WebView2)  <-- WebSocket -->  bethterm-web.exe (Go)  <-- stdin/stdout JSON -->  bethterm.exe cli bridge  <-- mux -->  bethterm-host.exe
```

- **`bethterm-web.exe`** é um processo Go (`windowsgui`, sem console)
  que serve a página React embutida (`//go:embed`) em
  `http://127.0.0.1:<porta aleatória>`, dentro de uma janela WebView2
  própria (`webhost_windows.go`, via `pkg/edge`), e faz a ponte entre o
  navegador e o `bethterm cli bridge`.
- **`bethterm cli bridge`** (upstream-wezterm, patch 0171 em diante) é
  um cliente do mux do BethTerm que fala JSON-lines por stdin/stdout:
  lista painéis, observa telas, envia teclas/colagens, cria, redimensiona,
  separa e encerra terminais — sempre conectado direto ao **host**, nunca
  à GUI (sobrevive a um `gui-restart`). Protocolo completo em
  `upstream-wezterm/patches/0171-cli-bridge.md` e nas patches seguintes
  (0172–0182).
- Todas as chamadas de rede saem do **Go**; o navegador nunca fala
  direto com o bridge nem com provedores externos.

## Segurança

- Escuta só em `127.0.0.1`, porta aleatória por execução.
- Token aleatório por execução, exigido em toda requisição HTTP/WS
  (cookie HttpOnly + SameSite=Strict, nunca em URL/log). Checagem de
  `Origin` e de `Host` (anti DNS-rebinding).
- `--read-only` recusa `send`/`paste`/`kill`/`resize`/`spawn`/`separate`
  e as chamadas pagas de voz.
- Chaves de provedores de IA ficam cifradas com DPAPI do Windows
  (`%APPDATA%\bethterm\secrets.dat`), fora do `web-settings.json`; a
  API só devolve uma máscara (`••••1234`), nunca a chave.
- Sobe e vigia o `bethterm-host.exe` (supervisor.go, hostctl_windows.go):
  se não existe, inicia; se cai, reinicia no máximo 3 vezes em 10 minutos e
  depois mostra "Host indisponível" com **Tentar de novo**. Nunca encerra o
  host por conta própria: só **Encerrar tudo** na bandeja, depois de uma
  confirmação que diz quantos terminais serão fechados. Se a GUI antiga
  (`bethterm-gui.exe`) estiver rodando, não supervisiona nem cria bandeja.
- A janela principal, ao fechar, esconde na bandeja (o ícone fica no relógio);
  **Sair da bandeja** fecha o Studio e deixa o host e os terminais rodando.
- Fechar uma aba/visualização no web nunca encerra um terminal — só
  "Encerrar terminal…" com confirmação explícita (patch 0180) faz isso.
- Os terminais abertos pelo Studio herdam o ambiente do `bethterm-web.exe`
  (o bridge cria o comando com `os.Environ`). Ao iniciar, ele tira as
  variáveis de sessão de agente (`NO_COLOR`, `CLAUDECODE`, `CLAUDE_CODE_*`,
  `CODEX_*`, `GIT_EDITOR`…) que não estão salvas nas variáveis do Windows:
  quando um agente reabria o Studio, os terminais novos ficavam sem cor e
  recebiam o token da sessão do agente (`agentenv.go`).
- Nunca inicia uma distro WSL parada (o Gerenciador de tarefas só lê
  distros já `Running`).
- `/api/local-file` (e `save-as`/`reveal`) exige caminho absoluto, sem
  `..`, extensão da lista e limite de tamanho; "Salvar como" revalida o
  destino no Go e escreve via arquivo temporário + rename.

## Funcionalidades

- **Terminais**: xterm.js por painel, tamanho do host respeitado por
  padrão, com opção de "Ajustar à janela" (redimensiona o pane no host
  quando ele está sozinho em sua aba do BethTerm; patch 0178). Um
  terminal aberto ao lado no Studio é uma aba própria no host, e a
  janela nativa não estica esse painel de volta para a largura dela
  (patch 0194). "Separar no BethTerm" tira um pane de um split de
  verdade (patch 0182). **Reparar visualização** reconstrói só o
  xterm.js local a partir da última tela e pede uma nova fotografia ao
  bridge; não envia `reset` e pode ser usado com Claude Code em
  execução. Se a saída chega mais depressa do que o desenho, fica só o
  quadro completo mais recente. Rolagem de histórico (patch 0171
  `scroll`, âncoras estáveis no 0187). Colar no terminal: uma imagem da
  área de transferência vira PNG; um arquivo copiado no Explorer (PDF,
  vídeo ou qualquer outro, Ctrl+V ou Colar) é copiado para
  `C:\tmp\bethterm\clipboard-images` e o caminho entra no terminal para o
  agente. Imagem de arquivo cola como `![image](caminho)`; o resto cola o
  caminho. Em painel WSL o caminho vira `/mnt/c/...`. Até 8 arquivos. Pasta,
  ou arquivo acima de 2 GB, cola o caminho original em vez de copiar. Letras
  fora do ASCII no nome da cópia viram `_`. Soltar um arquivo no terminal
  continua enviando uma cópia, até 25 MB. No código, o handler `paste` lê
  `clipboardData` (texto e arquivos) antes de qualquer `await`: o navegador
  o esvazia quando o handler síncrono retorna, e ler depois deixa o Ctrl+V
  sem colar nada. O Studio remoto não lê a área de
  transferência deste computador. Menu do terminal: copiar/salvar histórico
  completo e print (patch 0188).
- **SSH / SFTP**: hosts salvos; título `user@host:port`; senhas em
  DPAPI (`secrets.dat`). Janela SFTP separada (`--sftp <id>` ou ícone
  pasta no terminal SSH) com dual-pane Local|Remoto e fila de
  upload/download — ver `docs/FEATURES-gaps.md`.
- **Organização própria**: abas e splits do web, independentes da
  janela/aba/split do BethTerm; arrastar e soltar; "Novo terminal à
  direita/abaixo/acima/à esquerda" com escolha do shell; visões "Minha
  organização", "Como no BethTerm" e "Por tipo" (WSL/PowerShell/cmd/Git
  Bash/Agentes, por distro).
- **Busca**: por título, pasta, aba, janela/aba do host, id, e
  (opcional) pelo conteúdo visível da tela.
- **Aparência**: temas VS Code/Gogh/embutidos (mesma fonte de dados da
  GUI, favoritos compartilhados via `theme-favorites.json`), fontes do
  sistema, tema de interface derivado do tema dos terminais ou fixo
  (Escuro = VS Code Dark Modern, Claro, Azul-marinho). O xterm.js usa
  `minimumContrastRatio: 3`: cor quase igual ao fundo é escurecida ou
  clareada até ficar legível (ex.: o negrito do Claude Code vem como
  SGR 97, branco brilhante, e sumia nos temas claros).
- **Avisos de agente**: ponto/contador quando um painel espera resposta
  (sino, OSC 9 toast ou `claude_status`-like; patch 0175/0181).
- **Microfone e IA de voz** ("Voz e IA"): grava, transcreve
  (Whisper-compatível) e opcionalmente corrige o texto com um LLM antes
  de colar no terminal (sem Enter — o usuário revisa e confirma), com
  prefixo avisando o agente que o texto veio de voz. Provedores prontos
  para transcrição e correção (DeepInfra — rota nativa de transcrição —
  OpenAI, Groq, Anthropic, Gemini, Azure, locais etc.),
  cartões de modelo com preço, "Testar tudo" (pipeline completo sem
  enviar ao terminal) e registro de custo por chamada
  (`%APPDATA%\bethterm\ai-usage.jsonl`, nunca grava áudio/texto).
  **Grok Build** e **Codex** entram com um código: o Studio mostra o
  código, com botão **Copiar**, e abre a página de autorização no
  navegador. O token fica cifrado no mesmo `secrets.dat` (`acct:<id>`).
  A conta corrige texto e responde no assistente do banco.
- **Gerenciador de tarefas**: RAM/CPU/GPU/disco C: do sistema, dos
  processos do BethTerm e de cada terminal (soma da subárvore de
  processos do shell, associada por título de console lido por um
  processo auxiliar descartável), RAM/CPU da VM do WSL2 e de cada
  distro em execução.
- **Banco de dados**: janela própria na barra de tarefas
  (`bethterm-web.exe --db`, título "Banco de dados"). O botão no Studio
  abre ou foca essa janela. PostgreSQL, MySQL, SQL Server e SQLite;
  senhas em DPAPI (`secrets.dat`, chave `db:<id>`). Árvore
  conexão → banco → schema → Tables, Views, Materialized Views,
  Functions, Queries. Consultas salvas, autocomplete e assistente de
  SQL (não executa o SQL e não envia linhas nem senhas). O botão de
  paleta abre a mesma lista de temas de um terminal (busca, filtros,
  amostras); passar o mouse só pré-visualiza, o clique grava, e clicar
  fora fecha o painel. A escolha vale nesta janela e no Studio
  (`web-settings.json`). Na grade, duplo clique ou F2 edita uma célula
  quando a linha tem chave primária (visão da tabela, ou um SELECT de
  uma tabela só que inclui todas as colunas da chave). Enter grava, Esc
  cancela; o menu da célula pode definir NULL. JOIN, tabela sem chave
  e conexão somente leitura continuam só para leitura. O UPDATE altera
  uma coluna e só confirma se exatamente uma linha bater com a chave.
- **Links no terminal**: hyperlinks OSC 8 têm prioridade (vale o
  destino real, não o texto exibido); URLs e caminhos soltos no texto
  são só o fallback, com colunas medidas nas células do xterm (o
  sublinhado termina na extensão). `http(s)` abre no navegador padrão
  por uma rota única (`/api/open-link`); a janela WebView2 bloqueia
  popups e navegação.
- **Painel de arquivo** (`FilePreviewPanel`): caminhos locais
  `.md`/`.txt`/`.log` e imagens (png/jpg/gif/webp/bmp/svg, svg só como
  `<img>`) abrem num painel flutuante redimensionável. Caminhos WSL
  (`file:///mnt/...` ou texto) são convertidos: `/mnt/<letra>/x` →
  `<LETRA>:\x`, o resto → `\\wsl.localhost\<distro>\...` (fallback
  `\\wsl$`); a distro vem do argv `-d`, do cwd UNC ou da distro padrão
  no registro, sem iniciar nenhuma. Markdown renderizado e sanitizado
  (títulos, tabelas, código com quebra de linha, autolink); links
  relativos abrem no mesmo painel; imagens locais do `.md` carregam por
  `/api/local-file`, remotas nunca carregam sozinhas (marcador que abre
  no navegador). Ações só com ícone: copiar tudo (fonte cru)/seleção,
  selecionar tudo, salvar como (Ctrl+S), abrir no editor padrão,
  mostrar na pasta, copiar caminho, renderizado/fonte, quebra de linha,
  fonte/zoom, maximizar; Esc fecha.
- **⚙ Configurações**: tela única (Aparência, Terminais, Celular, Voz e IA,
  Provedores de IA, Uso e custos de IA, Barra lateral, Sobre) com os
  caminhos de todos os arquivos de dados e logs. Em Provedores de IA,
  o campo **Buscar provedor** filtra por nome, id, notas e modelo.
- **Celular**: web-app próprio, instalável na tela inicial — build
  separada do Studio (`frontend/phone.html` + `src/phone/`, `vite.phone.config.ts`,
  saída `dist/phone`). O domínio do celular só serve `dist/phone`
  (`phone_gate.go`); o app é público, `/api` e `/ws` pedem a senha.
  Localmente, para teste: `http://127.0.0.1:<porta>/phone/?t=<token>`.
  Lista cada terminal em execução uma vez, abre um agente por
  vez, rola o histórico e envia texto (colar e Enter) ou áudio. O ditado
  cai no campo para revisão; só **Enviar** manda. A gravação usa o
  MediaRecorder e, em paralelo, PCM → WAV 16 kHz; se o arquivo do
  MediaRecorder vier oco (Safari do iPhone), sobe o WAV (`src/phone/audio.ts`). O áudio
  sobe para este PC e é transcrito aqui; o celular não recebe o endereço
  nem a chave do provedor. Em **Configurações → Celular** cola-se a linha
  que o servidor imprimiu (`bethstudio://link…`), cria-se a senha do
  telefone, e a tela mostra se este computador está conectado.
  O programa Linux é `cmd/bethstudio-proxy` (`bethstudio-proxy-linux` no
  build). Ele não abre 80/443: o proxy HTTPS que já existe no servidor
  encaminha o domínio, inclusive WebSocket, para a porta ou o socket
  escolhidos. O Studio liga para fora. Banco, SSH e arquivos não passam
  por essa página.
- **Studio completo pelo navegador** (`remote_auth.go`, `remote_gate.go`,
  `src/lib/remote.ts`): o mesmo túnel do celular serve o Studio inteiro em
  `https://<domínio>/studio/`. Desligado por padrão; liga em
  **Configurações → Celular** depois de configurar o segundo fator (TOTP,
  QR gerado aqui). Entra com a senha do celular + código; cookie próprio
  (`Path=/studio`), sessão de 12 h sem uso / 7 dias, token só como SHA-256
  em `remote-sessions.json`. Tentativas limitadas por IP e no geral
  (`login_limit.go`, vale também para o login do celular). O que abre algo
  na tela do PC responde 403 pelo túnel e some da interface; links abrem no
  navegador de quem usa, Banco e SFTP em outra aba, "Salvar como" vira
  download, e "Procurar…" / "Abrir arquivo" usam o navegador de pastas da
  página (`FolderBrowser.tsx`, sobre `/api/local-fs/list`, que também lista
  as distros WSL). O remoto nunca muda o tamanho dos terminais no host.
  Registro em `%LOCALAPPDATA%ethterm-web
emote-access.log`.
  O `bethstudio-proxy` usa o último `X-Forwarded-For` (ou `X-Real-IP`)
  quando o pedido vem do proxy HTTPS local: no nginx,
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
  Vitrine manual com a ponte real: `BETH_REMOTE_PREVIEW=1
  BETHTERM_DATA_DIR=<temp> BETHTERM_EXE=<bethterm.exe> go test -v -run
  TestRemotePreview -timeout 0 .` Especificação:
  `docs/superpowers/specs/2026-09-30-studio-remoto-design.md`.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1            # frontend (Vite) + bethterm-web.exe
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipFrontend
```

Roda em prioridade `BelowNormal` e com metade dos núcleos
(`GOMAXPROCS`), para não travar a máquina do usuário durante o build.
Requer `bethterm.exe` (das patches 0171+) em `../upstream-wezterm/target/release`
ou via `--bethterm`/`BETHTERM_EXE`.

## Arquivos de dados (`%APPDATA%\bethterm\`)

| Arquivo | Conteúdo |
|---|---|
| `web-settings.json` | organização, aparência, configuração de voz (sem chaves), preferências |
| `secrets.dat` | chaves de IA, tokens de conta (Grok Build e Codex) e senhas de banco/SSH, cifradas (DPAPI) |
| `db-connections.json` | conexões de banco (sem senha) |
| `db-queries.json` | consultas SQL salvas |
| `ai-usage.jsonl` | log de custo de cada chamada de transcrição/correção |
| `model-prices.json` | cache de 24h dos preços de modelos |
| `bridge-latency.log` | medidor de latência de eco por painel (patch 0177) |
| (lidos, não escritos) `theme-favorites.json`, `pane-commands.json`, `default-theme.json` | compartilhados com a GUI |

Log do processo: `%LOCALAPPDATA%\bethterm-web\bethterm-web.log`.

## Ferramentas de desenvolvimento

- `tools/probe`: cliente de linha de comando do protocolo WS, para
  testar sem abrir a janela.
- `tools/fakebridge`: substituto do `bethterm cli bridge` para testes
  sem tocar em terminais reais.
- `tools/makesample.ps1`: gera o áudio de exemplo (`voicesample/`) com
  a voz SAPI pt-BR do Windows, usado pelo "Testar tudo".

Ver também `docs/INTEGRATION-sysmon.md` (como o Gerenciador de tarefas
foi ligado ao resto do app) e
`upstream-wezterm/patches/0171-cli-bridge.md` em diante para o
protocolo do bridge.
