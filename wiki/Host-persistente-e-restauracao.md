# Host persistente e restauração

O host (`bethstudio-host.exe`) é o processo que guarda os seus terminais. O Beth Studio é só uma janela para ele: fechar o Studio não fecha nenhum terminal, e, se o próprio host cair, o Studio o levanta de novo e recria os terminais.

## Como funciona

```
 Beth Studio (bethstudio-web.exe)          bethstudio-host.exe
 interface + bandeja + supervisor  <--->   dono dos PTYs (shells,
        |                                  agentes, sessões WSL)
        |  bethstudio.exe cli bridge             ^
        +----------------------------------------+
                  socket %APPDATA%\bethstudio\host.sock
```

- **O host é o dono dos terminais.** Cada shell, agente ou sessão WSL vive dentro dele. A interface se conecta pela ponte (`bethstudio cli bridge`) e apenas mostra e controla esses terminais.
- **Por isso os terminais sobrevivem.** Fechar a janela do Studio, sair da bandeja ou atualizar a interface não toca no host. Ao abrir o Studio de novo, ele se conecta aos mesmos terminais.
- **Um único host.** Existe um host por usuário. A segunda abertura do Studio apenas foca a janela que já existe.

### O supervisor

O Studio é também o supervisor do host. A cada 2 segundos ele confere se o host está de pé (procurando o mutex `Local\BethStudioHost`):

1. **Host ausente ao abrir o Studio:** o Studio inicia o `bethstudio-host.exe` que fica ao lado dele, sem janela de console e desanexado. Espera até 8 segundos o host ficar pronto (mutex e `host.sock`).
2. **Host caiu com o Studio aberto:** o Studio o inicia de novo.
3. **Limite de reinícios:** no máximo 3 reinícios em 10 minutos. O primeiro start (abrir o Studio sem host) não gasta vaga desse limite.
4. **Passou do limite:** o Studio para de insistir e mostra uma faixa no alto da janela com a mensagem "O host caiu 3 vezes em 10 minutos. Nova tentativa automática às HH:MM, ou use Tentar de novo." e o botão **Tentar de novo**. O limite também se libera sozinho quando as quedas antigas saem da janela de 10 minutos.
5. **Falha ao iniciar:** se o host não sobe, a faixa mostra o motivo, e o supervisor tenta de novo dentro do limite.

O Studio nunca para o host por conta própria. Quem encerra é você, em **Encerrar tudo** (veja abaixo).

Se ainda houver uma janela nativa antiga rodando e cuidando do host, o Studio não sobe a supervisão nem a bandeja, para não haver dois supervisores. Quando a janela antiga sai, o Studio assume sozinho (confere a cada 5 segundos).

### Restauração depois de uma queda do host

Enquanto tudo vai bem, o Studio mantém a "receita" de cada terminal vivo no arquivo `%APPDATA%\bethstudio\pane-specs.json`. Ela é gravada de forma atômica (arquivo temporário e renomeação), alguns segundos depois de a lista de terminais mudar. Cada terminal guarda:

- o tipo e o shell (WSL, PowerShell, cmd, Git Bash);
- a pasta atual (para WSL, a pasta Linux; para os demais, a pasta do Windows);
- a distro, no caso do WSL;
- o título;
- a ferramenta salva, no caso de SSH (host salvo) e serial (perfil da porta);
- a posição na ordem do layout.

Quando o host volta, o Studio decide se restaura:

| Situação | Restaura? |
|---|---|
| O host novo é **outro processo** que o da receita, está **vazio**, e a receita tem **menos de 7 dias** | Sim |
| Você fechou um terminal de propósito (o mesmo host continua rodando) | Não. Terminal fechado de propósito nunca volta |
| O host é o mesmo processo da receita | Não |
| A receita é mais velha que 7 dias, está vazia ou ilegível | Não |

Quando restaura:

1. Para cada distro WSL envolvida, roda uma vez a espera descrita em [WSL](WSL) (distro respondendo, comando de inicialização, pasta).
2. Recria os terminais na ordem do layout, até 3 ao mesmo tempo.
3. Liga os ids antigos aos novos e reaponta o layout (abas e divisões), os nomes e as configurações de cada terminal. Assim cada terminal volta na mesma aba e posição, e os nomes e temas acompanham.
4. Mostra uma faixa de progresso: "Aguardando o WSL (Debian)…" e "Restaurando terminais (3 de 22)…".
5. No fim, a faixa mostra "N terminais restaurados." (some sozinha em 8 segundos) ou um resumo do que não voltou, com os detalhes.

Se um terminal falha, os outros continuam. Se a pasta de um terminal WSL não aparece, ele abre na pasta inicial da distro e o resumo avisa.

> Captura sugerida: faixa "Restaurando terminais (3 de 22)…" no alto do Studio durante uma restauração.

> Captura sugerida: faixa "Host indisponível" com o botão Tentar de novo.

## Como usar

### Fechar o Studio sem perder nada

1. Clique no **X** da janela do Beth Studio.
2. A janela se esconde na bandeja. O host e os terminais continuam rodando.
3. Para voltar, clique no ícone da bandeja (veja [Bandeja e supervisão](Bandeja-e-supervisao)) ou abra o Studio de novo.

### Quando aparecer "Host indisponível"

1. Leia a mensagem da faixa: ela diz quando haverá a próxima tentativa automática.
2. Clique em **Tentar de novo**. O contador de reinícios é zerado e o Studio tenta subir o host na hora.
3. Se continuar falhando, consulte o `host-life.log` (abaixo).

### Encerrar tudo

**Encerrar tudo** é a única forma de o Studio parar o host. Ele fecha todos os terminais.

1. Clique com o botão direito no ícone do Beth Studio na bandeja.
2. Clique em **Encerrar tudo (fecha os terminais)**. O item só aparece com o host rodando.
3. Uma janela de confirmação intitulada **Encerrar tudo** pergunta "Encerrar o Beth Studio e fechar N terminais?" e avisa: "Shells, agentes e sessões WSL abertos serão fechados. Isso não pode ser desfeito."
4. Clique em **Sim** para confirmar. O botão padrão é **Não**.

Depois da confirmação, o Studio registra quem pediu (arquivo `host.quit-request`), sinaliza o evento `Local\BethStudioHostQuit` e espera até 5 segundos o host sair. Se ele não sair, o Studio encerra o processo pelo `host.pid`. Em seguida o próprio Studio fecha, e o host não volta sozinho.

### Ler o host-life.log

O arquivo `%APPDATA%\bethstudio\host-life.log` registra cada início e fim do host, quem pediu uma parada e as decisões do Studio. Cada linha tem data, `pid=`, o papel de quem escreveu (`host`, `studio`, `cli`...) e a mensagem. Exemplos de linhas do Studio: "host ausente; iniciando", "host iniciado", "falha ao iniciar o host: …", "Encerrar tudo confirmado pelo usuário na bandeja do Studio", "host novo e vazio; recriando N terminais da receita", "restauração terminou: N recriados, M falharam, K abriram na home".

Um pedido de saída que não veio do Studio nem do instalador aparece como `requester UNKNOWN`. O host também grava `alive panes=N` a cada 60 segundos. O arquivo gira ao passar de 4 MB (o anterior vira `host-life.1.log`).

Se um terminal sumiu e você não sabe por quê, leia esse arquivo antes de supor qualquer coisa.

## Limites e comportamentos a conhecer

- **Regra de nunca perder terminais.** O Studio só para o host depois de um **Encerrar tudo** confirmado. Nada na interface ou na bandeja o encerra automaticamente. Instalar uma versão nova também não deve parar um host em uso sem o seu pedido.
- **A restauração recria terminais; não recupera o conteúdo.** Quando o host cai, o que estava rodando dentro dos terminais (processos, agentes, histórico da tela) se perde. Voltam o shell, a pasta, a distro, o título e a posição.
- **Só restaura quando o host volta vazio e como outro processo.** Se você fechou terminais de propósito, eles não ressuscitam.
- **Receita com mais de 7 dias é ignorada.**
- **Tipos que voltam:** WSL, PowerShell, cmd, Git Bash, SSH (apenas hosts salvos) e serial (apenas com o perfil da porta). Outros tipos não entram na receita. Veja [SSH, serial e SFTP](SSH-serial-e-SFTP).
- **Receita ilegível ou ausente:** nada é restaurado; o Studio registra no log e regrava a receita quando possível.
- **Controle do host só no computador.** O botão **Tentar de novo** e o estado do host respondem apenas no PC, nunca no Studio remoto nem no celular (veja [Celular e acesso remoto](Celular-e-acesso-remoto)).
- **Atualizar com o host em uso:** um instalador que roda com o host vivo grava `bethstudio-host.exe.new` e troca o arquivo na próxima vez que o host iniciar (veja [Instalação](Instalacao)).

Veja também: [Bandeja e supervisão](Bandeja-e-supervisao), [WSL](WSL), [Terminais e abas](Terminais-e-abas), [Arquitetura](Arquitetura), [Perguntas frequentes](Perguntas-frequentes).
