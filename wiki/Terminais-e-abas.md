# Terminais e abas

O Beth Studio organiza seus terminais em abas e divisões (splits), tudo pelo mouse. Fechar uma aba ou uma visualização nunca encerra o terminal: ele continua rodando no [host persistente](Host-persistente-e-restauracao).

> Captura sugerida: janela do Studio com barra lateral, barra de abas e dois terminais divididos.

## Como usar

### Criar um terminal (Nova aba)

1. Clique em **Nova aba** (botão **+** na barra de abas).
2. Em **Novo terminal no Beth Studio**, escolha o tipo: cmd, PowerShell, WSL, Git Bash e os demais que aparecerem na lista. **SSH…** e **Serial…** levam às telas de [SSH, serial e SFTP](SSH-serial-e-SFTP).
3. Em **Pasta inicial (opcional)**, digite o caminho ou clique em **Procurar…**.
4. Em **Onde abrir no Beth Studio**, escolha entre **Como nova aba da janela do terminal em foco** e **Em janela nova do Beth Studio**.
5. Se quiser, preencha **Nome da aba no web**.
6. Clique em **Criar terminal**.

Para uma aba sem terminal (onde você solta terminais depois), clique em **Aba vazia** no mesmo diálogo. Você também pode soltar um terminal arrastado sobre o **+** para abri-lo numa aba nova.

### Escolher a pasta com "Procurar…"

1. Escolha o tipo de terminal primeiro. O campo e o botão só aparecem depois disso. Se houver um terminal em foco, a pasta dele já vem preenchida.
2. Clique em **Procurar…**. Abre o seletor de pastas do Windows.
3. A pasta escolhida preenche o campo. Para um terminal WSL, a pasta de um disco vira `/mnt/…`, e uma pasta dentro da distro Linux vira o caminho Linux.

No Studio aberto pelo navegador, **Procurar…** abre o navegador de pastas da própria página (veja abaixo).

### Dividir (splits)

1. No cabeçalho do terminal, clique no botão **Dividir** (abre mais um terminal à direita, abaixo, acima ou à esquerda). Ou clique com o botão direito no terminal e escolha **Novo terminal à direita…**, **Novo terminal abaixo…**, **Novo terminal acima…** ou **Novo terminal à esquerda…**.
2. Escolha o tipo. **Mesmo tipo deste** cria o novo terminal com o mesmo shell e a mesma pasta.
3. Para mudar o tamanho de cada parte, arraste a divisória. Duplo clique na divisória iguala os tamanhos.

Também dá para arrastar um terminal pelo cabeçalho e soltá-lo sobre outro. As bordas dividem (**Dividir à esquerda**, **Dividir à direita**, **Dividir acima**, **Dividir abaixo**) e o centro troca os dois de lugar (**Trocar de lugar**).

### Organizar um terminal

Clique com o botão direito no terminal e escolha **Organizar este terminal…**. O menu tem:

- **Mover para aba…** e **Abrir numa aba nova**.
- **Destacar em janela** (veja [Terminal destacado](Terminal-destacado)).
- **Dividir ao lado com…** e **Dividir abaixo com…**, que juntam este terminal a outro já existente.
- **Tirar de "nome da aba"**: o terminal sai da aba e continua rodando em **Não organizados**.
- **Encerrar terminal…**: pede confirmação antes de encerrar o processo.

### Renomear, reordenar e reabrir abas

1. Dê duplo clique numa aba para renomear (**Enter** confirma, **Esc** cancela).
2. Clique com o botão direito na aba para ver **Renomear…**, **Usar o nome do terminal**, **Fechar aba** e **Reabrir aba fechada**.
3. Arraste uma aba para reordenar.

Sem nome próprio, a aba mostra o título do terminal em foco (e acompanha as mudanças). Sem terminal vivo, mostra "Aba N".

### Painel lateral e botões de ferramenta

A barra lateral lista seus terminais. Quatro visões: **Minha organização**, **Como no Beth Studio**, **Por tipo** e **Por pasta**. Há busca no alto e filtros por tipo logo abaixo.

Os botões de ferramenta ficam numa fileira sob o título do painel: **SSH e Serial**, **Abrir arquivo**, **Novo arquivo**, **Falar**, **Tarefas**, **Banco de dados** e **Configurações** (**Buscar** fica na caixa de busca). Com o painel recolhido, os botões passam para a barra de abas; os que não cabem vão para o menu **Mais ações**. Use o botão de recolher/mostrar a barra lateral à esquerda da barra de abas.

### Navegador de pastas

O Studio aberto pelo navegador usa um navegador de pastas dentro da página em **Procurar…** e em **Abrir arquivo**. O mesmo navegador aparece como **Salvar como** ao salvar um texto novo.

1. Use os atalhos à esquerda: **Pasta do usuário**, cada disco e cada distro WSL.
2. Clique nos trechos da trilha do caminho para subir. Clique no espaço vazio da trilha para digitar ou colar um caminho.
3. Dê duplo clique numa pasta para entrar, ou num arquivo para abri-lo.
4. **Criar uma pasta aqui** pede o **Nome da pasta nova**.

## Sinais no terminal

- **Ponto "agente esperando".** Um ponto âmbar pulsante aparece quando um agente espera sua resposta: na aba, na barra lateral e, no cabeçalho do terminal, como **aguardando** (o **x** ao lado dispensa o aviso). Digitar no terminal também limpa o aviso. Em Configurações, **Terminais**, dá para ligar **Notificação do Windows** e **Som**. Veja [Agentes e voz](Agentes-e-voz).
- **Terminal encerrado.** Quando o processo termina, a posição do terminal mostra "terminal encerrado" com o botão **Remover**. Se o terminal não existe mais no host, o painel mostra **Remover daqui**.
- **Reparar visualização.** O botão de setas circulares no cabeçalho reconstrói só a tela daquele painel no Studio. Não envia `reset` nem mexe no host, então pode ser usado com um agente em execução.
- **Reconectar.** Se o Studio perde a ligação com o programa local, aparece uma faixa "Sem conexão com o bethstudio-web" com o botão **Reconectar agora**. Ele também tenta sozinho. Os terminais continuam vivos no host.

## Detalhes e limites

- **Fechar não encerra.** Fechar uma aba manda seus terminais para **Não organizados**. Só **Encerrar terminal…** (com confirmação) encerra o processo.
- **Splits do Studio e do host.** Um split que só existe no Beth Studio mantém o tamanho da coluna. Para ajustar o terminal à janela, use **Separar no Beth Studio para ajustar à janela…**, que tira o painel do split do host sem encerrar nada.
- **Tamanho.** Os botões de tamanho no cabeçalho alternam entre **Ajustar à janela** e **Igual ao Beth Studio**. Em Configurações, **Terminais**, você define o padrão.
- **Studio no navegador.** Pasta, arquivos e janelas nativas do PC não abrem remotamente: o navegador de pastas da página substitui o seletor do Windows. Veja [Celular e acesso remoto](Celular-e-acesso-remoto).
- **WSL.** O terminal WSL espera a distro responder antes de abrir. Veja [WSL](WSL).

Veja também: [Temas e fontes](Temas-e-fontes), [Arquivos, notas e área de transferência](Arquivos-notas-e-area-de-transferencia), [Bandeja e supervisão](Bandeja-e-supervisao).
