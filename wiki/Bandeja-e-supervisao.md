# Bandeja e supervisão

O Beth Studio tem um ícone na bandeja do Windows (perto do relógio). Fechar a janela só a esconde; o Studio continua vigiando o host e os terminais continuam vivos.

## Como funciona

- **Fechar a janela esconde na bandeja.** Clicar no **X** da janela principal esconde a janela. Nada é encerrado. Isso vale enquanto o ícone da bandeja existe; sem ele, fechar a janela fecha o Studio. Janelas de terminal destacadas fecham normalmente (veja [Terminal destacado](Terminal-destacado)).
- **Um processo só.** Interface, bandeja e supervisão do host são o mesmo processo (`bethstudio-web.exe`). O supervisor é descrito em [Host persistente e restauração](Host-persistente-e-restauracao).
- **Clique esquerdo no ícone** mostra a janela do Studio e a traz para a frente, mesmo escondida.
- **Clique direito** abre o menu.

### Itens do menu

| Item | O que faz |
|---|---|
| **Beth Studio** (em negrito) | Mostra e foca a janela do Studio. É o item padrão. |
| **Novo terminal** (submenu) | Lista os shells disponíveis (os mesmos do menu de novo terminal da interface). Clicar em um abre o terminal no host e mostra a janela. Fica desabilitado se o host não está rodando. Sem shells, mostra "(nenhum shell disponível agora)". |
| **Sistema (CPU, memória, disco)** | Mostra a janela e abre o painel Sistema (veja [Monitor do sistema](Monitor-do-sistema)). |
| **Sair da bandeja (terminais continuam)** | Fecha o Studio de verdade e tira o ícone. O host e os terminais continuam rodando. |
| **Encerrar tudo (fecha os terminais)** | Pede confirmação e, se você confirmar, fecha todos os terminais e o host. Só aparece com o host rodando. |

> Captura sugerida: menu da bandeja aberto com o submenu Novo terminal.

### Dica do ícone e ícone âmbar

Ao passar o mouse sobre o ícone, a dica mostra o estado:

- "Beth Studio — nenhum terminal", "— 1 terminal" ou "— N terminais";
- quando há agentes esperando você, acrescenta ", 1 agente aguardando você" ou ", N agentes aguardando você";
- "Beth Studio — iniciando o host…", "— host indisponível" ou "— encerrando", conforme o estado do supervisor.

Quando algum agente está esperando uma resposta sua, o ícone ganha uma **bolinha âmbar** no canto inferior direito. Ela some quando nenhum agente espera mais. Veja [Agentes e voz](Agentes-e-voz).

> Captura sugerida: ícone da bandeja com a bolinha âmbar e a dica "1 agente aguardando você".

### Se o ícone sumir

O Studio reinsere o ícone quando o Explorer do Windows reinicia e confere a presença dele a cada 30 segundos. A dica e o ícone são atualizados a cada 2 segundos.

## Como usar

### Esconder e voltar

1. Clique no **X** da janela do Beth Studio. Ela vai para a bandeja.
2. Clique uma vez no ícone da bandeja (ou no item **Beth Studio** do menu) para voltar.
3. Se o ícone não estiver visível, clique na seta de ícones ocultos da barra de tarefas.

### Abrir um terminal sem abrir a janela

1. Clique com o botão direito no ícone.
2. Passe o mouse em **Novo terminal** e clique no shell desejado.
3. O terminal é criado no host e a janela do Studio aparece.

### Sair do Studio mantendo os terminais

1. Clique com o botão direito no ícone.
2. Clique em **Sair da bandeja (terminais continuam)**.
3. O Studio fecha. Ao abri-lo de novo, ele se conecta ao mesmo host e aos mesmos terminais.

### Encerrar tudo

1. Clique com o botão direito no ícone e em **Encerrar tudo (fecha os terminais)**.
2. Na janela **Encerrar tudo**, leia "Encerrar o Beth Studio e fechar N terminais?" e clique em **Sim**. O botão padrão é **Não**.
3. O host é encerrado e o Studio fecha. Nada volta sozinho.

## Limites e comportamentos a conhecer

- **Sair da bandeja não é Encerrar tudo.** Sair da bandeja fecha só o Studio; os terminais continuam no host. Encerrar tudo fecha os terminais e o host, e não pode ser desfeito.
- **O Studio nunca encerra o host sozinho.** Só **Encerrar tudo**, depois de confirmado, faz isso. Cada decisão fica no `host-life.log` (veja [Host persistente e restauração](Host-persistente-e-restauracao)).
- **Sem o ícone da bandeja**, fechar a janela principal fecha o Studio. O esconder-na-bandeja só vale enquanto o ícone existe.
- **Uma segunda abertura do Studio** foca a janela que já existe, em vez de abrir outra.
- **Janela nativa antiga:** se ela ainda estiver rodando e cuidando do host, o Studio não cria a bandeja nem a supervisão, para não haver dois ícones nem dois supervisores. Quando a janela antiga sai, o Studio assume sozinho.
- **Novo terminal** na bandeja depende da lista de shells informada pela ponte; sem a ponte pronta, a lista fica vazia.
- A bandeja é do Windows e do computador onde o Studio roda. No Studio remoto e no celular não há bandeja (veja [Celular e acesso remoto](Celular-e-acesso-remoto)).

Veja também: [Host persistente e restauração](Host-persistente-e-restauracao), [WSL](WSL), [Terminais e abas](Terminais-e-abas), [Perguntas frequentes](Perguntas-frequentes).
