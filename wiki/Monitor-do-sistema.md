# Monitor do sistema

O Gerenciador de tarefas do Beth Studio mostra, numa tela só, quanto o computador está gastando e quanto disso é de cada terminal. Ele mede CPU, memória, GPU e disco do Windows, os processos do próprio Beth Studio, o consumo de cada terminal e as distribuições WSL que já estão rodando.

## Como usar

Há dois caminhos, os dois com o mouse:

- No Studio, clique no botão **Tarefas** (ícone de atividade), na fileira de ferramentas do painel lateral. Com o painel recolhido, o botão volta para a barra de abas. A dica do botão diz: "Gerenciador de tarefas: memória, CPU, GPU, disco, consumo de cada terminal e do WSL".
- No ícone da bandeja, clique em **Sistema (CPU, memória, disco)**. Veja [Bandeja e supervisão](Bandeja-e-supervisao).

O painel abre com o título **Gerenciador de tarefas**. No cabeçalho aparecem "ao vivo" com a hora da última amostra, o tempo que a coleta levou (em ms), há quanto tempo o Windows está ligado e quantos processos existem. Para sair, clique no **X** (dica "Fechar").

> Captura sugerida: Gerenciador de tarefas aberto, com as seções Sistema, Beth Studio, Terminais e WSL.

Ele também funciona no Studio aberto pelo navegador (veja [Celular e acesso remoto](Celular-e-acesso-remoto)), mas mede o PC onde o Beth Studio roda, não o computador do navegador. O app do celular não tem esta tela.

## O que cada seção mostra

### Sistema

Um cartão por métrica, com a porcentagem grande, o valor absoluto ao lado e uma barra. A barra muda de cor conforme a carga.

- **CPU**: porcentagem da máquina inteira (a soma de todos os núcleos é 100%), gráfico dos últimos 60 segundos e uma barra por núcleo lógico.
- **Memória**: usada de total, mais "livre" e "commit" (memória comprometida contra o limite, que é a RAM mais o arquivo de paginação).
- **GPU**: um cartão por placa, com a utilização do motor mais ocupado (como no Gerenciador de Tarefas do Windows), memória "dedicada" e "compartilhada". Com uma placa NVIDIA, aparecem também a temperatura e o uso de VRAM, lidos do `nvidia-smi`. O nome da placa vem do `nvidia-smi` quando há uma só NVIDIA e é marcado como "(provável)", porque essa ligação é uma heurística. Sem os contadores do Windows e sem `nvidia-smi`, o cartão mostra "indisponível".
- **Disco C:**: espaço usado, livre e, quando os contadores do Windows estão disponíveis, atividade ("ativo"), "leitura" e "escrita". Sem eles, a atividade aparece como "indisponível".

Hoje o cartão de disco mede só a unidade `C:`.

### WSL2 (cartão dentro de Sistema)

Quando a VM do WSL2 está ativa, o cartão mostra a memória em camadas: o que o Linux usa ("Em uso no Linux"), o que a VM ocupa no Windows ("Ocupa no Windows", que inclui o cache de disco do Linux) e o quanto ainda pode crescer até o limite. Mostra também as áreas de swap (zram, com a RAM que realmente ocupa e a taxa de compressão, e arquivo ou partição de disco), um gráfico de CPU dos últimos 60 segundos e o disco virtual da distro. Com o WSL desligado, o cartão diz "WSL2 desligado: não usa memória, CPU nem disco agora."

### Beth Studio

Uma tabela com os processos do próprio Beth Studio e a soma da RAM deles, sem os programas que rodam dentro dos terminais. As colunas são **Componente**, **PID**, memória (working set privado), **Working set**, **CPU** e **GPU**. Os componentes são o host (`bethstudio-host`), os consoles dos terminais (`OpenConsole`), a ponte, o `bethstudio-web`, os processos do WebView2 da janela e a janela nativa antiga, quando existe. Um segundo host, se houver, aparece como "Outro host".

### Terminais

Uma linha por terminal, com **Título**, **Tipo**, **RAM**, **CPU** e **Proc.** (número de processos). A RAM é a soma do shell e de tudo o que ele abriu. Clique no título de uma coluna para ordenar (por padrão, RAM do maior para o menor). Clique em qualquer outro ponto da linha (a seta à esquerda) para expandir e ver os 5 maiores processos daquele terminal (nome, PID, RAM, CPU). Clicar no nome do terminal fecha o painel e leva até ele ("Ir para o terminal N"). Um ponto colorido ao lado do nome indica a qualidade da associação com o processo. Uma etiqueta no cabeçalho da seção diz se todos os terminais foram associados a um processo ou quantos ficaram "sem associação".

### WSL

Uma ficha por distribuição, com estado, versão do WSL, "padrão" e a carga média. Para as que estão rodando: memória, disco e uma tabela com os maiores processos (**Processo**, **PID**, **RSS**, **CPU\***, **Tempo**; o CPU\* é a média desde o início do processo, como o `ps` calcula). Distribuições paradas aparecem como "Parada" e nunca são consultadas.

## Como ele mede

- **Coleta.** Uma chamada do Windows por segundo (`NtQuerySystemInformation`) cobre todos os processos e a CPU de cada núcleo. Nenhum handle de processo é aberto. A memória vem de `GlobalMemoryStatusEx`; GPU e atividade do disco vêm dos contadores de desempenho (PDH). A coleta típica leva cerca de 20 ms, e o cabeçalho mostra o tempo real.
- **RAM** é o working set privado, a coluna "Memória" do Gerenciador de Tarefas do Windows. O working set total e os bytes privados (commit) aparecem na dica da célula.
- **Quando mede.** O painel consulta uma vez por segundo enquanto está aberto. Fechado, não consulta nada, e o Go para de amostrar cerca de 10 segundos depois da última consulta. `nvidia-smi` e o WSL são consultados em segundo plano a cada 5 segundos, com limite de tempo.
- **De qual processo é cada terminal.** Os shells são os filhos diretos do host. O título do console de cada um é lido por um processo auxiliar descartável (o painel nunca se anexa a um console no processo principal), e esse título é cruzado com o título do terminal. A associação tenta título exato, depois título normalizado (sem os símbolos de "trabalhando" dos agentes) e, por último, a ordem de criação, marcada como estimada. A etiqueta de cada linha mostra o tipo de associação ("Associação: ...").

## Detalhes e limites

- **Não acorda o WSL.** Se não há processo `vmmem`, o `wsl.exe` nem é chamado. A lista de distros em execução é conferida logo antes de cada consulta. Existe uma pequena corrida: uma distro que para exatamente entre as duas checagens pode ser iniciada de novo por aquela consulta. Terminais WSL aparecem na tabela só pelo lado Windows (`wsl.exe`).
- **Distros WSL2 dividem a mesma VM**, então o "free" de cada distro mostra a VM, não só a distro.
- **Associação por título pode errar** quando há terminais com o mesmo título. Nesse caso o pareamento é pela ordem, e a linha fica marcada como aproximada ou estimada.
- **Disco** mede só `C:`, e a atividade depende dos contadores do Windows.
- **GPU** pode aparecer como "indisponível" em máquinas sem os contadores ou sem `nvidia-smi`. O nome "(provável)" é uma suposição.
- A coleta do disco tem limite de 250 ms e, se passar, reaproveita a última amostra, para não travar nada.
- O painel só lê. Ele não encerra processos nem inicia, para ou reinicia nada. Para fechar um terminal, use o menu do terminal (veja [Terminais e abas](Terminais-e-abas)).

Para entender de onde vêm esses processos, veja [Host persistente e restauração](Host-persistente-e-restauracao), [WSL](WSL) e [Arquitetura](Arquitetura).
