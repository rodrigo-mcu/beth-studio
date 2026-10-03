# Temas e fontes

Cada terminal pode ter seu próprio tema de cores, fonte e tamanho. Os terminais que não têm nada próprio usam o padrão que você define em Configurações. A interface do Studio (barra lateral, abas, menus) tem um tema à parte.

> Captura sugerida: painel "Aparência: tema, fonte e tamanho" aberto sobre um terminal, aba Tema, com favoritos no topo.

## Como usar

### Mudar o tema, a fonte ou o tamanho de um terminal

1. No cabeçalho do terminal, clique em **Aparência: tema, fonte e tamanho** (ícone de paleta). Abre um painel à direita com as abas **Tema** e **Fonte**.
2. Na aba **Tema**, passe o mouse sobre um tema para ver o resultado (nada é salvo) e clique para aplicar a este terminal.
3. Use a busca (**Buscar tema…**) e os filtros **Todos**, **Escuros** e **Claros**, e as origens **Todas as origens**, **Beth Studio**, **VS Code** e **Gogh**.
4. Na aba **Fonte**, clique numa fonte para aplicá-la. **Só monoespaçadas** (marcado por padrão) ou **Todas**. Cada linha mostra um texto de exemplo na própria fonte.
5. Em **Tamanho**, clique em **Automático** ou use os botões de diminuir e aumentar (de 5 a 48). Escolha **Normal** ou **Negrito**.
6. Para fechar, clique de novo no botão da paleta ou no **x** do painel.

O botão **Atualizar listas** lê de novo as pastas de temas e as fontes instaladas, útil depois de instalar uma fonte ou um tema.

### Tamanho da fonte direto no cabeçalho

No cabeçalho do terminal há **A−** e **A+** para diminuir e aumentar a fonte, e um botão central que mostra o tamanho. Clicar nele volta ao tamanho automático (ajusta à área). Ctrl com a roda do mouse também muda o tamanho. A fonte do terminal só fica fixa depois que você mexe nela; o padrão é automático.

### Favoritos

1. Clique na estrela ao lado de um tema (**Favoritar tema**) ou de uma fonte (**Favoritar fonte**).
2. Os favoritos aparecem numa seção própria no topo da lista (**Favoritos** e **Favoritas**) e nos seletores de Configurações.
3. Clique na estrela de novo para tirar.

### Tema padrão, fonte padrão e tamanho padrão

Pelo painel de um terminal:

1. Escolha o tema (ou a fonte e o tamanho) que quer.
2. Clique em **Usar como padrão** no rodapé da aba. Terminais sem tema próprio passam a usar esse tema.
3. Para devolver um terminal ao padrão, clique em **Voltar ao padrão**.

Pelas Configurações:

1. Abra **Configurações** e, em **Aparência**, vá em **Terminais em geral**.
2. Em **Tema padrão**, **Fonte padrão** e **Tamanho padrão**, clique em **Trocar…** (ou use os botões do tamanho).
3. **Padrão de fábrica** devolve o tema padrão ao original do Studio.
4. A lista abaixo mostra os terminais que têm tema ou fonte próprios, cada um com **Voltar ao padrão**. **Aplicar o padrão a todos** remove os ajustes próprios de todos (pede confirmação com **Sim, aplicar a todos**).

### Tema da interface

Em **Configurações**, **Aparência**, **Tema da interface** vale para barra lateral, abas, cabeçalhos, menus, busca e painéis. As opções são **Escuro**, **Claro**, **Azul-marinho**, **Seguir o tema dos terminais** e **Escolher um tema…** (qualquer tema do catálogo). Passe o mouse para ver antes.

### Configurações de Terminais

Em **Configurações**, **Terminais**, você define:

- **Tamanho dos terminais**: **Ajustar à janela** ou **Igual ao Beth Studio**, como padrão para terminais sozinhos na aba.
- **Avisos de agente aguardando**: **Notificação do Windows** e **Som**.

## De onde vêm os temas

- **Beth Studio**: três temas embutidos (VS Code Light, VS Code Dark e o escuro do Windows Terminal).
- **Gogh**: cada arquivo `.json` na pasta `%APPDATA%\bethstudio\themes`. O Studio lê os temas dessa pasta.
- **VS Code**: os temas de cor das extensões instaladas do VS Code, VS Code Insiders, Cursor e VSCodium, e os temas que acompanham o próprio VS Code. As chaves `terminal.*` são usadas; o que faltar cai nas cores do editor.

## Espelhamento entre Studio e terminal

- **Cores para os programas.** O tema que você vê no Studio é enviado ao host, para que programas que perguntam a cor do fundo e do texto (Codex, Cursor e parecidos) acertem, inclusive em temas claros.
- **Contraste mínimo.** O texto cuja cor é quase igual à do fundo é escurecido ou clareado até ficar legível (contraste mínimo 3:1). Assim o negrito branco de alguns agentes continua visível num tema claro.
- **Novo terminal.** Um terminal novo (inclusive SSH ou serial) abre com o tema padrão dos terminais, se houver um; senão, com o tema da interface. O tema escolhido num terminal prevalece e fica. Mudar o tema da interface depois só recolore os terminais sem tema próprio.

## Detalhes e limites

- **Onde fica salvo.** Os ajustes por terminal e os padrões ficam em `web-settings.json` dentro de `%APPDATA%\bethstudio`. Os favoritos de temas conhecidos do catálogo ficam em `theme-favorites.json`; o tema padrão herdado em `default-theme.json` (o Studio lê, mas não escreve nesse arquivo).
- **Fonte ausente.** Se a fonte escolhida não existe no computador, o painel avisa e mostra a fonte usada no lugar.
- **Celular.** A [página do celular](Celular-e-acesso-remoto) tem seus próprios temas, salvos no aparelho.
- **Terminal destacado.** A [janela destacada](Terminal-destacado) mostra o mesmo tema e a mesma fonte.

Veja também: [Terminais e abas](Terminais-e-abas), [Perguntas frequentes](Perguntas-frequentes).
