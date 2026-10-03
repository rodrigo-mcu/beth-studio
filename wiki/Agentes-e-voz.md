# Agentes e voz

O Beth Studio percebe quando um agente de IA (Claude Code, Codex, Cursor e outros) parou esperando você e avisa de vários jeitos. Também deixa você ditar um texto com o microfone, transcrevê-lo e, se quiser, corrigi-lo com um modelo de linguagem antes de colar no terminal.

Esta página explica o aviso de "agente aguardando", a conversa com o agente pelo celular, o ditado por voz, os provedores de IA e o registro de custos.

## Agente aguardando

### Como o Studio sabe

O sinal vem do protocolo do terminal, não do nome do programa. Um terminal conta como "aguardando" quando recebe:

- o sino do terminal (bell);
- uma notificação de terminal (OSC 9);
- uma variável de terminal como `claude_status=waiting`. Vale `claude_status` e qualquer nome terminado em `_status` ou `_waiting`, ou que contenha `agent`, com valores como `waiting`, `approval`, `question`, `permission`, `needs_input` ou `blocked`.

Qualquer agente que envie um desses sinais é reconhecido.

Um sino no fim de um turno não fica "aguardando" para sempre. Se o título do terminal volta a mostrar um indicador de trabalho em andamento (os círculos ◐ ◑ ◒ ◓), o aviso sai sozinho. Avisos vindos de variável de terminal são limpos pelo próprio agente.

### O que você vê

- Um ponto âmbar pulsando ao lado do terminal na barra lateral, nas abas e no cabeçalho do terminal, com a palavra **aguardando**. Ele aparece sempre.
- Na barra lateral, um resumo **N aguardando**. Clique nele (**ver**) para abrir a lista e clique em um item para ir até o terminal.
- O ícone da bandeja ganha um ponto âmbar enquanto um agente espera você. Veja [Bandeja e supervisão](Bandeja-e-supervisao).
- Se você tentar encerrar um terminal com agente esperando, a confirmação de **Encerrar terminal…** avisa que o trabalho em andamento será interrompido.

### Como dispensar ou ligar avisos extras

1. Para limpar um aviso sem responder, clique em **dispensar** na lista da barra lateral, ou no X ao lado de **aguardando** no cabeçalho do terminal.
2. Para avisos extras, abra **Configurações**, entre em **Terminais** e vá à seção **Avisos de agente aguardando**.
3. Ligue **Notificação do Windows** e/ou **Som**. Essas opções valem só neste computador.

O aviso também some quando você envia algo ao terminal. No celular, os agentes que esperam aparecem primeiro na lista, com o tempo de espera.

> Captura sugerida: barra lateral com o resumo "2 aguardando" aberto e o ponto âmbar em um terminal.

## Conversa com o agente pelo celular

No app do celular (veja [Celular e acesso remoto](Celular-e-acesso-remoto)) existe uma lista de terminais e uma tela de conversa por terminal (`AgentList` e `AgentChat` no código). Você lê o texto do agente em letras grandes, escreve no campo de mensagem e toca em **Enviar**, que cola o texto e aperta Enter. Há teclas rápidas (1, 2, 3, setas, Enter e Esc) para os menus dos agentes, e **Falar** para ditar. Essa tela não existe no Studio do PC: lá você digita no próprio terminal.

## Ditado por voz

### Como usar

1. Clique no terminal que vai receber o texto.
2. Clique em **Falar**: no painel lateral, ou no botão de microfone do cabeçalho do terminal.
3. Na primeira vez, o Studio mostra um aviso de privacidade dizendo para onde vão o áudio e o texto. Leia e clique em **Entendi, gravar** (ou **Escolher provedor**, se quiser trocar antes).
4. Escolha o microfone, se precisar. Fale normalmente. A barra mostra o nível do som, e um aviso aparece se nenhum som for captado. A gravação vai até 10 minutos.
5. Clique em **Parar e transcrever**. O Studio transcreve e, se a correção estiver ligada, corrige.
6. Revise o texto. Se a correção mudou algo, a caixa **O que a correção mudou** mostra as diferenças e o botão **usar corrigido** / **usar original** alterna entre as versões.
7. Clique em **Enviar ao terminal** (ou `Ctrl+Enter`). O texto é colado sem Enter: você confirma no próprio agente.

Outros botões da revisão: **Gravar de novo** (descarta tudo), **Corrigir novamente** (reenvia o texto já transcrito ao corretor, sem gravar) e **Descartar**. Em caso de erro, aparecem **Tentar novamente** (reenvia o mesmo áudio) ou **Configurar em Provedores de IA**.

Por padrão o texto colado começa com uma linha avisando o agente que a mensagem veio de voz e pode ter erros de reconhecimento. Desmarque **Avisar o agente que veio de voz** na revisão para tirar, ou edite o texto da linha.

### Configurar em Voz e IA

Abra **Configurações** e clique em **Voz e IA**. A seção **Provedores de IA**, logo abaixo, cuida das chaves e contas. (O botão de engrenagem do popup **Falar** abre a mesma tela.) Em **Voz e IA** você encontra:

- **Microfone**: escolha o dispositivo (padrão: **Padrão do Windows**) e use **Testar microfone** para medir o sinal por 5 s.
- **Testar tudo**: roda o caminho inteiro (microfone ou áudio de exemplo, transcrição, correção e texto final) sem enviar nada ao terminal, mostrando tempo e custo de cada etapa. Só roda quando você clica e gasta alguns centavos.
- **Transcrição (voz → texto)**: **Provedor**, **Modelo** (com **Escolher com preços…**) e **Idioma**. O padrão é DeepInfra com `openai/whisper-large-v3-turbo` e idioma português.
- **Correção por IA (opcional)**: marque **Passar o texto num modelo para corrigir erros de reconhecimento**. Escolha **Provedor**, **Modelo** e **Prazo**. A correção vem desligada por padrão. Passando do prazo (padrão 30 s, entre 5 e 180 s), o Studio usa o texto transcrito sem correção. Há também **Mostrar a correção enquanto chega** (senão ela aparece de uma vez, no fim).
- **Prompt da correção**: o texto de instrução do corretor pode ser editado. Variáveis: `{idioma}`, `{vocabulario}` e `{foneticos}`. O padrão pede para corrigir só erros de reconhecimento, sem traduzir, resumir ou responder ao conteúdo, e marcar trechos ambíguos entre `[? ]`.
- **Vocabulário do projeto**: um termo por linha. Vai no prompt da correção e como dica na transcrição. O padrão traz BethStudio, WezTerm, WSL, PowerShell e Claude Code.
- **Incluir vocabulário técnico padrão**: lista pronta de termos de desenvolvimento (linguagens, IA, ferramentas, protocolos) com a grafia correta. Clique em **Ver lista** para ler e buscar. Na correção, ela vai inteira, junto com a tabela de variantes fonéticas (como o termo soa em português). Na transcrição, vai só um subconjunto curto, porque o prompt do transcritor é pequeno.
- **Envio ao agente**: o prefixo de voz e a opção **Enviar direto ao terminal, sem revisar (o Enter continua sendo seu)**.

### O que sai do computador

O ditado só funciona enviando dados a um provedor, a menos que você use um provedor local:

- O **áudio** gravado vai para o provedor de **Transcrição** escolhido.
- O **texto transcrito** vai para o provedor de **Correção por IA**, se você ligou a correção.
- As chamadas saem do programa `bethstudio-web.exe`, não do navegador da janela. As chaves ficam no programa e nunca voltam para a tela.
- O Beth Studio não guarda o áudio nem o texto. Ele guarda só a configuração e um registro de custo (veja abaixo).
- Os provedores locais (**Ollama (local)**, **LM Studio (local)** e **Whisper local**) mandam os dados para o endereço configurado, por padrão uma porta do próprio computador.
- No celular, o áudio vai primeiro para este computador e é transcrito aqui. O celular nunca recebe o endereço nem a chave do provedor.

## Provedores de IA

Abra **Configurações** e clique em **Provedores de IA**. Há uma caixa de busca no topo que filtra por nome, identificador, notas e modelo. Para cada provedor, a tela mostra se ele serve para transcrição, correção ou ambos.

Provedores implementados no código:

| Provedor | Transcrição | Correção |
|---|---|---|
| DeepInfra | sim | sim |
| OpenAI | sim | sim |
| Groq | sim | sim |
| Together AI | sim | sim |
| Fireworks AI | sim | sim |
| Azure OpenAI | sim | sim |
| ElevenLabs (Scribe) | sim | não |
| Deepgram | sim | não |
| Anthropic (Claude) | não | sim |
| Google Gemini | não | sim |
| OpenRouter | não | sim |
| Mistral | não | sim |
| xAI (Grok) | não | sim |
| Grok Build | não | sim |
| Codex | não | sim |
| Ollama (local) | não | sim |
| LM Studio (local) | não | sim |
| Whisper local (faster-whisper-server / LocalAI) | sim | não |
| Personalizado (compatível com OpenAI) | sim | sim |

### Chave de API

1. Escolha o provedor e clique em **Trocar chave** (ou cole direto, se ainda não há chave).
2. Cole a chave em **Cole a chave de API** e clique em **Salvar**.
3. Use **Testar** para validar e **Buscar modelos** para listar os modelos do provedor, quando ele tem essa lista.
4. Para remover uma chave salva, clique em **Apagar chave**.

As chaves digitadas ficam cifradas com a proteção de dados do Windows (DPAPI) em `%APPDATA%\bethstudio\secrets.dat`. Como alternativa, cada provedor lê uma variável de ambiente (por exemplo `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPINFRA_API_KEY`). Se existir as duas, a chave salva tem prioridade. Alguns provedores permitem editar a URL base (Azure, Fireworks, os locais e o personalizado).

### Login por código: Grok Build e Codex

**Grok Build** e **Codex** usam a sua conta, sem colar chave:

1. Em **Provedores de IA**, escolha **Grok Build** ou **Codex** e clique em **Entrar com código** (ou **Entrar de novo**).
2. O Studio mostra um código, com o botão **Copiar**.
3. Clique em **Abrir a página para autorizar**, entre na sua conta no navegador e digite o código.
4. O Studio detecta a autorização sozinho. Para desistir antes, clique em **Cancelar**.
5. Para desconectar, clique em **Sair da conta**.

O token de acesso fica cifrado neste PC (DPAPI). Essas duas contas servem para a correção de texto e para o assistente do [Banco de dados](Banco-de-dados). Elas não fazem transcrição.

## Uso e custos de IA

Abra **Configurações** e clique em **Uso e custos de IA**. Cada chamada paga (transcrição, correção, assistente de banco e as do **Testar tudo**) vira uma linha em `%APPDATA%\bethstudio\ai-usage.jsonl`. O registro tem data, função, provedor, modelo, duração, tempos, tamanho (segundos de áudio ou tokens), sucesso ou erro e custo estimado. Ele nunca grava áudio nem texto. O arquivo gira ao chegar a 5 MB, mantendo o anterior.

A tela mostra totais, um gráfico **Por dia (30 dias)** e a lista **Últimas chamadas**, com filtro por provedor, modelo ou erro. Os botões **Exportar CSV** e **Abrir pasta** levam os dados para fora. Em **Avisar quando o mês passar de US$**, você define um limite. Ele só avisa no **Falar**; não bloqueia nada.

Os preços vêm do catálogo do provedor quando ele publica uma lista (DeepInfra e OpenRouter) ou de uma tabela de referência embutida, datada, para os demais. Por isso o custo é uma estimativa.

## Variáveis de sessão de agente

Quando um agente (como Claude Code ou Codex) abre o `bethstudio-web.exe`, as variáveis de ambiente dele iriam junto para os terminais novos. Isso causava terminais sem cor e levava dados da sessão do agente para terminais que não são dela. Por isso o Studio, ao iniciar, remove do próprio ambiente:

- `NO_COLOR`, `FORCE_COLOR`, `AI_AGENT`, `CLAUDECODE`, `CLAUDE_PID`, `GIT_EDITOR`, `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `GCM_INTERACTIVE`, `COREPACK_ENABLE_AUTO_PIN`, `NODEFAULTCURRENTDIRECTORYINEXEPATH` e `PSEXECUTIONPOLICYPREFERENCE`;
- qualquer variável que comece com `CLAUDE_CODE_` ou `CODEX_`.

Só sai o que não está salvo nas variáveis do Windows (de Usuário ou da Máquina). O que você configurou de propósito fica. Os nomes removidos vão para o log, nunca os valores.

## Detalhes e limites

- O aviso de agente aguardando conta só os alertas recebidos enquanto o Studio está ligado. Ele não consegue consultar o estado atual de um terminal.
- A tela de conversa com agente é do app do celular.
- O ditado precisa de permissão de microfone na janela do Studio. Os nomes dos microfones aparecem depois da primeira permissão.
- As configurações de voz (sem chaves) ficam em `%APPDATA%\bethstudio\web-settings.json`.

## Veja também

- [Terminais e abas](Terminais-e-abas)
- [Bandeja e supervisão](Bandeja-e-supervisao)
- [Celular e acesso remoto](Celular-e-acesso-remoto)
- [Banco de dados](Banco-de-dados)
- [Segurança e privacidade](Seguranca-e-privacidade)
