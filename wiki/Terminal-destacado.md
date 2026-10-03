# Terminal destacado

Um terminal ou uma sessão SSH pode sair das abas e virar uma janela nativa do Windows, com barra de título própria. Ela pode ficar em outro monitor. É o mesmo terminal, com o mesmo conteúdo e o mesmo tema.

> Captura sugerida: janela de terminal destacada num segundo monitor, ao lado do Studio.

## Como usar

### Destacar

1. No cabeçalho do terminal, clique no botão **Destacar em janela (o terminal continua rodando)**.
2. Ou clique com o botão direito no terminal, escolha **Organizar este terminal…** e depois **Destacar em janela**.
3. Uma janela nova abre com o terminal. Arraste a barra de título para outro monitor, se quiser.

O terminal sai da aba onde estava. Se a aba ficar vazia, ela é fechada.

### Voltar para as abas

Você tem dois caminhos:

- Clique em **Encaixar de volta no Beth Studio** na barra de título da janela. O terminal entra na aba ativa do Studio.
- Arraste a barra de título da janela até a barra de abas do Studio e solte. Ao passar sobre uma aba ou sobre o **+**, a zona de soltar acende. Soltar sobre uma aba coloca o terminal nela; soltar sobre o **+** ou num espaço vazio da barra cria uma aba nova.

Depois de encaixar, a janela destacada fecha sozinha. Se o soltar não valer (por exemplo, fora da barra de abas), a janela continua aberta.

### Fechar a janela

Clique no botão de fechar da janela (a dica diz "Fechar a janela (o terminal continua rodando)"). O terminal continua rodando no host e volta à lista de terminais, em **Não organizados**. Para encerrar o processo de verdade, use **Encerrar terminal…** no Studio.

## Detalhes e limites

- **Aparência mantida.** A janela usa o mesmo servidor e o mesmo host do Studio, o tema da interface e o tema e a fonte do terminal. Mudanças feitas em **Aparência: tema, fonte e tamanho** valem nos dois lugares. Veja [Temas e fontes](Temas-e-fontes).
- **Uma janela por terminal.** Pedir para destacar um terminal que já tem janela só traz a janela existente para a frente. Clicar nesse terminal na barra lateral faz o mesmo.
- **Só no PC.** O Studio aberto pelo navegador e a [página do celular](Celular-e-acesso-remoto) não destacam terminais: a rota responde que a janela destacada só existe no computador. Em modo somente leitura, o botão também não está disponível.
- **Janela própria, processo próprio.** Cada janela é um processo `bethstudio-web.exe --term <número>` que se liga ao Studio que a abriu. Se o Studio fecha ou cai, a janela destacada fecha junto, mas o terminal continua no host.
- **Aparece na barra de tarefas** como uma janela separada, com identificador próprio por terminal.
- **SSH.** Uma sessão SSH destacada se comporta como qualquer terminal. A janela de arquivos (SFTP) é outra janela; veja [SSH, serial e SFTP](SSH-serial-e-SFTP).
- O tamanho inicial da janela é 900 x 600 pixels.

Veja também: [Terminais e abas](Terminais-e-abas), [Host persistente e restauração](Host-persistente-e-restauracao).
