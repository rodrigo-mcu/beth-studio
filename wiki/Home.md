# Beth Studio

**Beth Studio** é um terminal para Windows pensado para o mouse. Seus terminais, agentes de IA e sessões WSL ficam num processo que continua vivo quando você fecha uma janela, e a interface (abas, divisões, arquivos, banco de dados, SSH, voz) roda por cima dele.

Esta wiki é o manual de uso e de desenvolvimento. A interface do programa está em português do Brasil.

## Comece por aqui

1. [Instale](Instalacao) com o `BethStudio-Setup.exe`.
2. Abra o Studio e crie seu primeiro terminal: [Terminais e abas](Terminais-e-abas).
3. Conheça o que mais ele faz nas seções abaixo.

Dúvidas comuns estão em [Perguntas frequentes](Perguntas-frequentes).

## A ideia em três frases

- Um **host** (`bethstudio-host.exe`) é o dono dos terminais. O Studio só mostra o que o host tem.
- Fechar o Studio, travar a interface ou reiniciá-la **não mata** nenhum terminal.
- Se o próprio host cair, o Studio sobe outro e **recria os terminais** nas mesmas abas e pastas.

## O que o Beth Studio faz

**Terminais**

- [Terminais e abas](Terminais-e-abas): abas, divisões, busca, vistas por layout, host, tipo ou pasta.
- [Terminal destacado](Terminal-destacado): um terminal em janela própria, em qualquer monitor, e de volta às abas arrastando.
- [Temas e fontes](Temas-e-fontes): temas Gogh e VS Code, favoritos, fonte e tema por terminal.

**Trabalho ao redor do terminal**

- [Arquivos, notas e área de transferência](Arquivos-notas-e-area-de-transferencia): editor, notas, prévia, colar arquivo e imagem.
- [SSH, serial e SFTP](SSH-serial-e-SFTP): hosts salvos, portas seriais e janela SFTP.
- [Agentes e voz](Agentes-e-voz): aviso de agente esperando e ditado por voz.
- [Banco de dados](Banco-de-dados): PostgreSQL, MySQL/MariaDB, SQL Server e SQLite.
- [Monitor do sistema](Monitor-do-sistema): CPU, memória, GPU, disco e consumo por terminal.

**Confiabilidade**

- [Host persistente e restauração](Host-persistente-e-restauracao)
- [WSL](WSL): início que espera a distro e a pasta.
- [Bandeja e supervisão](Bandeja-e-supervisao)

**Fora do PC**

- [Celular e acesso remoto](Celular-e-acesso-remoto)
- [Segurança e privacidade](Seguranca-e-privacidade)

**Para desenvolvedores**

- [Arquitetura](Arquitetura)
- [Referência da CLI e da API](Referencia-da-CLI-e-API)
- [Compilar do código](Compilar-do-codigo)
- [Relação com o WezTerm](Relacao-com-o-WezTerm)

## Projeto

- Licença MIT. O projeto nasceu do [WezTerm](https://github.com/wezterm/wezterm) e é independente dele.
- Lista completa de funcionalidades: `FEATURES.md` na raiz do repositório.
- História e decisões: `docs/HISTORY.md`.
