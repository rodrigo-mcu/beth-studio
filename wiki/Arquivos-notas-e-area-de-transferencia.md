# Arquivos, notas e área de transferência

O Studio tem um painel para ler e editar arquivos de texto e Markdown, um bloco de notas que salva sozinho, e formas de levar texto, imagens e arquivos para dentro do terminal (por exemplo, para um agente). Também copia o histórico do terminal e abre links clicáveis.

> Captura sugerida: painel de arquivo aberto sobre o Studio, mostrando um `.md` formatado e a lista de notas.

## Como usar

### Abrir arquivo

1. Clique em **Abrir arquivo** (na barra lateral ou, com ela recolhida, na barra de abas).
2. Escolha o arquivo no diálogo do Windows. Ele abre na pasta do terminal em foco.
3. O painel abre com o conteúdo. Aceita `.md`, `.markdown`, `.txt`, `.log` e imagens (png, jpg, gif, webp, bmp, svg).

No Studio aberto pelo navegador, o diálogo é o [navegador de pastas](Terminais-e-abas) da própria página, com o título **Abrir arquivo**.

### Editar e salvar

1. Clique em **Editar este arquivo** (ícone de lápis). Só funciona para texto de tamanho razoável; um arquivo grande demais mostra só o início e sugere o editor padrão.
2. Edite e clique em **Salvar** (ou Ctrl+S). O arquivo é gravado no próprio lugar, mantendo as quebras de linha e links simbólicos.
3. Para parar, clique em **Parar de editar**.

Em Markdown, o botão **Ver o fonte (editar)** / **Ver formatado** alterna entre o texto-fonte e a versão formatada. A versão formatada mostra o texto ainda não salvo.

Salvaguardas:

- Fechar ou abrir outro arquivo com alterações pergunta antes (**Fechar assim mesmo?** / **Parar de editar assim mesmo?**).
- Se o arquivo mudou no disco depois que você o abriu (outro programa ou um agente salvou), o painel avisa antes de sobrescrever.

Outros botões do painel: **Copiar tudo**, **Copiar a seleção**, **Selecionar tudo no painel**, **Salvar uma cópia como…**, **Abrir com o editor padrão do Windows**, **Mostrar na pasta (Explorer)**, **Copiar o caminho**, **Quebra de linha** e os de tamanho de fonte e zoom da imagem (**Ajustar ao painel**, **Tamanho real (100%)**). Há também um menu de clique direito com **Recortar**, **Copiar**, **Colar** e **Selecionar tudo**.

### Novo arquivo

1. Clique em **Novo arquivo**. O editor abre em branco, com o título "Sem título".
2. Escreva. Salvar é opcional.
3. Para guardar num arquivo, clique em **Salvar** (ou Ctrl+S). Escolha a pasta e o nome (**Salvar como**). O nome termina em `.md` ou `.txt`, e nunca sobrescreve um arquivo existente. Depois de salvar, você continua editando o arquivo salvo.
4. Fechar um "Sem título" não pergunta nada. Na próxima vez que clicar em **Novo arquivo**, aparece "Você fechou um texto sem salvar…" com **Recuperar** e **Esquecer**.

Dentro do painel de um arquivo aberto, o botão **Novo arquivo de texto nesta pasta** cria um novo texto na mesma pasta.

### Notas

O que você escreve em **Novo arquivo** é salvo sozinho como uma nota.

1. Digite. A nota é salva 1,5 segundo depois da última tecla e de novo ao fechar.
2. Clique em **Mostrar a lista de notas** (ícone de caderno, no título do painel). A lista mostra o título (primeira linha), a data e a hora.
3. Clique numa nota para abri-la e continuar editando. **Nova nota em branco** (**+**) começa outra.
4. Para apagar, clique na lixeira da linha e confirme em **Apagar esta nota?**.

Cada nota é um arquivo `.md` com o nome da hora de criação (`AAAA-MM-DD_HH-MM-SS.md`) em `%APPDATA%\bethstudio\notes`. Abrir outra nota ou arquivo salva a atual antes. Se salvar falhar, o texto ainda vai para **Recuperar**.

### Janela do painel

O painel flutua sobre o Studio e se comporta como uma janela.

1. Arraste a barra de título para mover.
2. Arraste qualquer borda ou canto para redimensionar.
3. Dê duplo clique no título (ou use **Maximizar o painel**) para maximizar. **Restaurar o tamanho do painel** volta.
4. **Encostar na esquerda (altura toda)** e **Encostar na direita (altura toda)** fixam o painel numa lateral.
5. **Fechar (Esc)** fecha.

Posição e tamanho são lembrados. Se a janela do app diminui, o painel volta para dentro dela.

### Colar para o terminal

Use **Colar no terminal** no cabeçalho, **Colar** no menu de clique direito, ou Ctrl+V (Shift+Insert também).

- **Arquivo copiado no Explorer** (PDF, vídeo, qualquer coisa): o Studio copia o arquivo para `C:\tmp\bethstudio\clipboard-images` (ou `%TEMP%\bethstudio\clipboard-images`, se `C:\tmp` não existir) e cola o caminho no terminal. Imagens chegam como `![image](caminho)`; outros arquivos chegam como o caminho, entre aspas se tiver espaço.
- **Imagem na área de transferência** (Print Screen, "copiar imagem"): é salva como arquivo e colada do mesmo jeito.
- **Texto**: colado normalmente. Se o sistema não liberar a leitura da área de transferência, abre **Colar no terminal** com uma caixa para você colar o texto e clicar em **Enviar**.
- **Soltar um arquivo sobre o terminal**: a imagem vira um arquivo e outros arquivos viram uma cópia; o caminho vai para o terminal. Solte até 5 arquivos de cada vez, de até 25 MB cada.
- **Terminal WSL**: o caminho é reescrito de `C:\…` para `/mnt/c/…`.

### Copiar e salvar o histórico

Clique com o botão direito no terminal:

- **Copiar histórico** copia todo o histórico (scrollback).
- **Salvar histórico…** grava num arquivo.
- **Copiar print do terminal** e **Salvar print…** geram uma imagem do que está na tela.
- **Copiar** copia a seleção (Ctrl+C com texto selecionado, ou Ctrl+Shift+C, também copia).

### Links clicáveis

Links e caminhos na saída do terminal ficam sublinhados. Ao passar o mouse, uma dica diz o que o clique faz.

- Links `http` e `https` abrem no navegador padrão, nunca dentro do Studio.
- Caminhos de `.md`, `.txt`, `.log` e imagens abrem no painel de arquivo, com a pasta do terminal como referência (inclusive no WSL).
- Qualquer outro arquivo que exista (PDF, documento, planilha, arquivo compactado e o restante) abre no programa padrão do Windows.
- Programa e script (`.exe`, `.bat`, `.cmd`, `.ps1`, `.lnk`, `.js`, `.vbs`, `.msi`, `.scr` e similares) não são executados: o clique mostra o arquivo na pasta.
- Hiperlinks que o próprio programa envia (OSC 8) valem pelo destino real, não pelo texto mostrado. Um texto curto como "here" abre a URL de verdade.
- Com um programa em tela cheia que usa o mouse, o clique puro continua no programa. A dica passa a dizer **Ctrl+clique para abrir**. Segure Ctrl e clique no link.

## Detalhes e limites

- **Limite da cópia do Explorer.** Até 8 arquivos por vez. Uma pasta, ou um arquivo acima de 2 GB, cola o caminho original em vez de uma cópia. Letras fora do ASCII no nome copiado viram `_`.
- **Studio no navegador.** O Studio remoto não lê a área de transferência do PC. O navegador de pastas substitui os diálogos do Windows, e **Salvar uma cópia como…** baixa o arquivo. Veja [Celular e acesso remoto](Celular-e-acesso-remoto).
- **Somente leitura.** Em modo somente leitura, o colar fica desabilitado.
- **Privacidade.** Os arquivos colados ficam numa pasta temporária local. Veja [Seguranca e privacidade](Seguranca-e-privacidade).

Veja também: [Terminais e abas](Terminais-e-abas), [Agentes e voz](Agentes-e-voz), [Temas e fontes](Temas-e-fontes).
