# Ponte de agentes Windows ↔ WSL2 pelo Studio — desenho

Data: 2026-10-31. Pedido do usuário (ditado): o Studio deve ligar um Claude
Code no Windows a um Claude Code no WSL2, sem programa externo, para que ele
possa dizer "fala com o agente no WSL" (ou o contrário). O usuário pediu para
estudar como a comunicação funciona na mesma máquina e a documentação do
Claude, e depois seguir com a melhor opção.

## O que foi verificado (2026-10-31)

Fonte: documentação oficial lida diretamente (cross-session-messaging,
channels-reference, env-vars, mcp, cli-reference) e testes nesta máquina.

1. **Mensagem nativa entre sessões** (`SendMessage`/`ListAgents`) existe e é
   push (sessão ociosa começa um turno novo). Cada sessão tem uma caixa de
   entrada: socket Unix no Linux/WSL, named pipe no Windows
   (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`). A
   descoberta usa um registro interno em `~/.claude/sessions/<pid>.json`
   (`peerProtocol`, arquivos `.key`). **A documentação diz textualmente que
   uma sessão no WSL 2 e uma no Windows nativo não se alcançam.**
2. O formato da mensagem na caixa de entrada **não é documentado** (só a linha
   de autenticação `{"type":"auth","token":...}`). Um teste postando no pipe
   da própria sessão com um formato plausível não entregou nada. Conclusão:
   ligar as duas caixas de entrada exigiria engenharia reversa de um
   protocolo interno que muda a cada versão. **Descartado.**
3. **MCP stdio** é o mecanismo documentado e estável para dar ferramentas a um
   agente (`claude mcp add ... -- comando`). Funciona igual nos dois lados.
4. **Interop do WSL com stdio funciona** (teste: `printf ... | findstr.exe`
   dentro do Debian). Logo o Claude do WSL pode rodar o
   `bethstudio-tool.exe` do Windows como servidor MCP. Esse processo é do
   Windows: fala com o Studio em `127.0.0.1` sem passar pela rede NAT do WSL
   (Windows 10 aqui, sem modo espelhado) nem pelo firewall.
5. **Channels** (`claude/channel`) é o único push documentado de fora para
   dentro de uma sessão aberta. É prévia de pesquisa: canal próprio só com
   `--dangerously-load-development-channels server:<nome>`, com um aviso em
   tela cheia a cada início, e exige login claude.ai ou chave da API. Se o
   servidor não foi carregado como canal, a notificação é descartada em
   silêncio.
6. Digitar no terminal do outro agente (o Studio controla os painéis) entraria
   como se fosse o usuário: descartado na fase 1 por segurança.

## Desenho (fase 1)

- **Studio = carteiro.** Um quadro de mensagens em memória no
  `bethstudio-web.exe` (`ponte.go`), com rotas `/api/ponte/*` protegidas pelo
  token do Studio e recusadas no Studio remoto e no celular. Ao subir, o
  Studio grava `<dados>\ponte.json` (`url`, `token`, `pid`) e apaga ao sair.
- **Servidor MCP** `bethstudio-tool.exe ponte-mcp [--nome X] [--lado wsl]`
  (`ponte_mcp.go`), stdio, sem dependências. Ao iniciar, registra o agente no
  Studio (nome único, lado, pasta) e mantém um laço de espera que é também o
  sinal de vida. Ferramentas:
  - `ponte_agentes`: quem está na ponte agora.
  - `ponte_enviar(para, mensagem)`: `para` aceita nome exato, `wsl` ou
    `windows`, ou parte do nome; ambíguo devolve a lista.
  - `ponte_aguardar(segundos)`: espera e devolve mensagens novas (padrão
    120 s, máx. 600 s).
  - Também declara `claude/channel`: se a sessão foi aberta com o canal de
    desenvolvimento, a mensagem entra sozinha (push); senão o agente usa
    `ponte_aguardar`. A mensagem fica guardada nos dois casos.
- **Toda mensagem chega emoldurada** como vinda de outro agente, não do
  usuário, e sem valor de autorização (mesma regra da mensagem nativa).
- Lado: `--lado`, ou `WSL_DISTRO_NAME`, ou pasta UNC `\\wsl...`; senão
  Windows. Nome padrão `<lado>-<pasta>`.
- Agente sem sinal de vida por 3 min sai da lista; até 100 mensagens por fila;
  texto até 200 mil caracteres.

## Atualizações da fase 1 (2026-10-31, depois do primeiro uso real)

- **Nome do agente = nome da sessão do Claude** (o do `/list-agents`, ex.
  "MOBI VMS"), lido de `<home>\.claude\sessions\*.json` do lado do agente.
  Antes o nome vinha da pasta (`windows-mobi`) e quem enviava não sabia qual
  escolher. No Windows o servidor acha a sessão pelo id
  (`CLAUDE_CODE_SESSION_ID`) ou pelo pai do processo; no WSL pelo id, que só
  chega ao `.exe` se a configuração do MCP repassar
  `WSLENV=CLAUDE_CODE_SESSION_ID` (o botão de registro já faz isso; quem
  registrou antes precisa registrar de novo). Servidores antigos já em
  execução recebem o nome pelo próprio Studio (pai do processo, só Windows).
- **Identidade = id da sessão** (`cc-<id>`): sessão retomada ou reconectada
  reaproveita nome e fila. Verificações rápidas do Claude (`claude mcp get`,
  `claude -p`) só entram na lista depois de alguns segundos vivas, para não
  virarem agentes fantasmas; quem some sai da lista em ~75 s.
- **Busca tolerante** em `ponte_enviar`: nome igual, igual ignorando espaços,
  traços e acentos, `wsl`/`windows`, nome dentro do que foi dito, pasta. Vale o
  mais específico; empate ou nenhum: nada é enviado e a resposta lista nome,
  lado e pasta.
- **Ouvir sozinho**: hook `bethstudio-tool.exe ponte-hook` em `SessionStart` e
  `Stop` com `asyncRewake`. Comprovado com Claude real que um hook assim,
  saindo com código 2, abre um turno novo numa sessão parada. O hook só diz
  "há mensagem; leia com ponte_aguardar": o texto da mensagem nunca vai para o
  contexto como aviso do sistema. A mensagem conta como "não lida" até o
  modelo ler por `ponte_aguardar` (que avisa o Studio por `/ack`). Ligado e
  desligado por botão em Configurações; edita o `settings.json` de usuário do
  Claude de cada lado com cópia de segurança (`.beth-ponte.bak`, uma vez só)
  e reescreve o arquivo inteiro (a ordem das chaves pode mudar).

## Uso: tem que ser simples (pedido do usuário)

"Clicou no menu, configuração, ativou, usou", com instruções e comandos para
copiar e colar. Então:

- **Configurações > Ponte de agentes**: interruptor "Ligar a ponte" (guardado
  nas configurações; desligada, as rotas `/api/ponte/*` respondem 403 e o
  `ponte.json` não existe).
- Botões **Registrar no Claude do Windows** e **Registrar no Claude do WSL
  (<distro>)**: o Studio roda `claude mcp add --scope user beth-ponte -- ...`
  em cada lado (no WSL por `wsl.exe -d <distro> -- bash -lic`), mostra o
  resultado e permite remover. Os mesmos comandos aparecem prontos para
  copiar.
- Um passo a passo curto: abrir (ou reiniciar) o Claude em cada lado e dizer
  "fala com o agente no WSL: …". Lista ao vivo de quem está na ponte.
- Opcional, para push: comando de abrir o Claude com o canal de
  desenvolvimento, explicado como opcional e experimental.

## Fora da fase 1

- Acordar sozinho uma sessão ociosa sem o canal de desenvolvimento.
- Tela no Studio mostrando a conversa entre os agentes.
- Botão no Studio para registrar o MCP no Claude dos dois lados (por enquanto
  é um comando `claude mcp add` em cada lado).
