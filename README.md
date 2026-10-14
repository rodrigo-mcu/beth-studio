# Beth Studio

**Beth Studio** é um terminal para Windows pensado para o mouse. Seus terminais, agentes de IA e sessões WSL ficam num processo que não morre quando você fecha uma janela, e a interface (abas, divisões, arquivos, banco de dados, SSH, voz) roda por cima dele.

Mais do que um terminal, o Beth Studio é um estúdio de trabalho: o terminal, um editor, um cliente de banco de dados, SSH/serial/SFTP e acesso pelo navegador ou pelo celular, tudo no mesmo programa.

> **Idioma.** A interface do Beth Studio e esta documentação estão em português do Brasil. A versão em inglês vem depois.

## Por que existe

- **Terminais que sobrevivem.** Um host persistente (`bethstudio-host.exe`) é o dono de todos os terminais. Fechar o Studio, travar a interface ou reiniciá-la não mata os shells, os agentes nem as sessões WSL.
- **Feito para uso pesado.** O autor usa o Beth Studio todo dia com cerca de 35 terminais abertos ao mesmo tempo: builds longos, vários agentes de IA rodando e sessões em WSL2 e PowerShell. Isso é uso real do projeto, não um teste de desempenho com medidas publicadas.
- **Imagens e arquivos chegam ao agente.** Copie uma imagem (Print Screen, "copiar imagem") ou um arquivo no Explorer e cole no terminal: o Studio salva um arquivo e cola o caminho, para o agente conseguir abri-lo. Imagens chegam como `![image](caminho)`. Num terminal WSL o caminho já vem reescrito de `C:\…` para `/mnt/c/…`. Soltar o arquivo sobre o terminal faz o mesmo. Veja [Arquivos, notas e área de transferência](wiki/Arquivos-notas-e-area-de-transferencia.md).
- **Atualiza a interface sem matar os hosts.** Uma versão nova da interface entra com **Configurações > Sobre > Recarregar interface**, sem reiniciar o Studio e sem encostar no `bethstudio-host.exe`, então terminais e agentes continuam rodando. Cada release traz o `BethStudio-ui-<versão>.zip` só com a interface. Atualizar pelo instalador com o host rodando também não derruba os terminais.
- **Mouse primeiro.** Nova aba, divisão, tema, fonte, destacar em janela: tudo se faz clicando, sem arquivo de configuração e sem atalho para decorar.
- **Recupera sozinho.** Se o próprio host cair, o Studio sobe outro e recria os terminais nas mesmas abas e pastas.
- **Uma interface só.** O Studio (Go + React em WebView2) é a única interface. A janela nativa que existia antes foi removida.

## O que dá para fazer

| Área | O que tem | Detalhes |
| --- | --- | --- |
| Terminais | Abas, divisões, busca, vistas por layout, host, tipo ou pasta | [Terminais e abas](wiki/Terminais-e-abas.md) |
| Janelas | Destacar um terminal em janela própria (inclusive em outro monitor) e arrastar de volta | [Terminal destacado](wiki/Terminal-destacado.md) |
| Aparência | Temas (Gogh, VS Code), fontes, tema e fonte por terminal | [Temas e fontes](wiki/Temas-e-fontes.md) |
| Arquivos | Editor de texto e Markdown, notas, prévia, colar arquivo do Explorer | [Arquivos, notas e área de transferência](wiki/Arquivos-notas-e-area-de-transferencia.md) |
| Resiliência | Host persistente, supervisão, restauração após queda | [Host persistente e restauração](wiki/Host-persistente-e-restauracao.md) |
| WSL | Início inteligente: espera a distro e a pasta montada | [WSL](wiki/WSL.md) |
| Bandeja | Ícone próprio, menu do sistema, "Encerrar tudo" com confirmação | [Bandeja e supervisão](wiki/Bandeja-e-supervisao.md) |
| Conexões | SSH, portas seriais e janela SFTP | [SSH, serial e SFTP](wiki/SSH-serial-e-SFTP.md) |
| Agentes e voz | Aviso de agente esperando, ditado por voz com correção opcional | [Agentes e voz](wiki/Agentes-e-voz.md) |
| Banco de dados | PostgreSQL, MySQL/MariaDB, SQL Server e SQLite | [Banco de dados](wiki/Banco-de-dados.md) |
| Remoto | Studio no navegador e página própria para o celular | [Celular e acesso remoto](wiki/Celular-e-acesso-remoto.md) |
| Sistema | Gerenciador de tarefas com CPU, memória, GPU, disco e por terminal | [Monitor do sistema](wiki/Monitor-do-sistema.md) |

A lista completa e atualizada está em [`FEATURES.md`](FEATURES.md). O manual passo a passo está na [wiki](wiki/Home.md).

## Como as peças se encaixam

```
 Studio (bethstudio-web.exe)           Go + React/xterm.js em WebView2
        │  HTTP + WebSocket (só em 127.0.0.1, com token)
        ▼
 Ponte (bethstudio.exe cli bridge)     linhas JSON; o terminal chega como "snapshot"
        │
        ▼
 Host (bethstudio-host.exe)            dono dos terminais (PTYs); sobrevive ao Studio
        │
        ▼
 Shells: PowerShell, cmd, WSL, Git Bash, SSH, serial…
```

Detalhes em [Arquitetura](wiki/Arquitetura.md).

## Baixar

Na página **[Releases](../../releases/latest)** do repositório, baixe:

- **`BethStudio-Setup.exe`**: instalador de um arquivo só (recomendado).
- **`BethStudio-<versão>-windows-x64.zip`**: versão portátil; descompacte e abra `bethstudio-web.exe`.

Confira o arquivo com `SHA256SUMS.txt`. Requer Windows 10 ou 11.

> **Linux e macOS.** Hoje o Beth Studio só roda no Windows. Há planos de portá-lo para Linux e para macOS (sem WSL, que é do Windows), começando pelo Linux e por uma interface aberta no navegador. Ainda não há data nem compromisso de entrega. Detalhes em [Perguntas frequentes](wiki/Perguntas-frequentes.md).

Ajuda e limites do projeto: [`SUPPORT.md`](SUPPORT.md). Para gerar um release você mesmo: [`RELEASING.md`](RELEASING.md).

## Instalação

1. Baixe o `BethStudio-Setup.exe`.
2. Execute, escolha a pasta (a sugestão é `C:\Users\Public\BethStudio`) e clique em **Instalar**.
3. Abra pelo atalho ou pelo botão **Abrir** do instalador.

O instalador é portátil: sem registro do Windows e sem pastas escondidas. Atualizar com o host rodando não derruba seus terminais. Requisitos e detalhes em [Instalação](wiki/Instalacao.md).

## Compilar do código

```powershell
# host e CLI (Rust nightly, MSVC e Strawberry Perl no PATH)
cd upstream-wezterm
cargo +nightly build --release -p wezterm -p wezterm-mux-server

# Studio (Go 1.24+, Node.js com pnpm)
cd ..\bethstudio-web
.\build.ps1

# instalador
cd ..
.\pack-bethstudio-setup.cmd
```

Passo a passo, testes e dicas em [Compilar do código](wiki/Compilar-do-codigo.md).

## Segurança e privacidade

O Studio escuta só em `127.0.0.1`, numa porta aleatória, e exige um token em toda requisição. Nada sai do seu computador a menos que você ligue o acesso remoto (que usa um relé que você mesmo hospeda) ou use recursos que chamam provedores de IA. O que sai e quando está em [Segurança e privacidade](wiki/Seguranca-e-privacidade.md). Para reportar uma vulnerabilidade, veja [`SECURITY.md`](SECURITY.md).

## Base no WezTerm

O Beth Studio **nasceu do [WezTerm](https://github.com/wezterm/wezterm)** (Wez Furlong e colaboradores, licença MIT). O host, a ponte e o núcleo de emulação de terminal vêm de lá. O código-fonte do WezTerm usado fica em [`upstream-wezterm/`](upstream-wezterm/), com a base congelada num commit conhecido; cada alteração em arquivo existente está registrada em [`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md).

É um projeto **independente**: não é afiliado nem endossado por Wez Furlong ou pelo projeto WezTerm. Veja [Relação com o WezTerm](wiki/Relacao-com-o-WezTerm.md), [`docs/UPSTREAM.md`](docs/UPSTREAM.md) e [`NOTICE.md`](NOTICE.md).

## Como o projeto chegou aqui

A linha do tempo está em [`docs/HISTORY.md`](docs/HISTORY.md).

## Contribuir

Veja [`CONTRIBUTING.md`](CONTRIBUTING.md) e [`docs/HACKING.md`](docs/HACKING.md). Se o defeito também existe no WezTerm original, envie para o [projeto dele](https://github.com/wezterm/wezterm). Host, ponte, sessão e o Studio são daqui.

## Licença

**MIT** para tudo que vem do WezTerm, a mesma licença dele. Veja [`LICENSE.md`](LICENSE.md). O Beth Studio é um trabalho derivado do WezTerm, © Wez Furlong e colaboradores; os avisos originais foram mantidos.

**BSD-3-Clause** para o código que não vem do WezTerm: [`bethstudio-web/`](bethstudio-web/LICENSE) (o Studio e a página do celular) e [`bethstudio-mobile/`](bethstudio-mobile/LICENSE). Eles conversam com o host pelo processo `bethstudio cli bridge` e não contêm código do WezTerm. Quem redistribuir precisa manter o aviso de copyright e a licença; os ícones do aplicativo ficam de fora até a origem deles ser confirmada (veja o `LICENSE` de cada pasta). Autor: Rodrigo.

## Agradecimentos

- **[Wez Furlong](https://github.com/wezterm)** e os colaboradores do WezTerm, a base de tudo.
- **[Terminator](https://gnome-terminator.org/)**, cuja grade de divisões inspirou a camada de mouse.
- **[Gogh](https://github.com/Gogh-Co/Gogh)**, o catálogo comunitário de temas.
- **[VS Code](https://github.com/microsoft/vscode)**, pelas convenções de tema e fonte.
- **Elizabeth**, que dá o nome.

Este projeto foi desenvolvido com a ajuda de agentes de programação com IA. O registro de engenharia de cada mudança está em [`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md).
