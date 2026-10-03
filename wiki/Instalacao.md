# Instalação

O Beth Studio se instala com um único arquivo, o `BethStudio-Setup.exe`. A instalação é portátil: tudo fica em uma pasta visível, sem registro do Windows e sem pastas ocultas.

## Requisitos

- Windows. Hoje o Beth Studio só roda no Windows (veja [Perguntas frequentes](Perguntas-frequentes)).
- Microsoft Edge **WebView2 Runtime**. Ele já vem no Windows 11 e no Windows 10 atual. O Studio usa o WebView2 para desenhar a janela.
- Para compilar a partir do código, veja [Compilar do código](Compilar-do-codigo).

Se o WebView2 faltar, o Studio mostra uma mensagem pedindo para instalá-lo. Ele também aceita ser aberto com `--no-window` e usado em um navegador (veja [Referência da CLI e da API](Referencia-da-CLI-e-API)).

## Instalar com o BethStudio-Setup.exe

1. Dê dois cliques em `BethStudio-Setup.exe`. O instalador é uma janela nativa do Windows (não usa WebView).
2. Em **Pasta**, confira o destino. A sugestão é a pasta Public da máquina, normalmente `C:\Users\Public\BethStudio`. Clique em **Procurar…** para escolher outra.
3. Deixe marcada a opção **Criar atalhos no Ambiente de Trabalho e no Menu Iniciar** se quiser os atalhos. Ela vem marcada.
4. A opção **Encerrar tudo antes de instalar (fecha o Beth Studio e todos os terminais)** vem desmarcada. Marque só se quiser que a instalação feche tudo e atualize inclusive o host. O instalador pede uma confirmação antes (OK ou Cancelar), porque tudo o que roda nos terminais será perdido.
5. Clique em **Instalar**. Se já existe uma instalação na pasta, o botão se chama **Atualizar**.
6. Ao terminar, clique em **Abrir** para iniciar o Beth Studio. O botão **Abrir** só funciona se a pasta já tiver o `bethstudio-web.exe`.

> Captura sugerida: janela do instalador com a pasta, as duas caixas de seleção e os botões Abrir e Instalar.

O texto na própria janela resume a política: os arquivos ficam só nessa pasta, o instalador não escreve no registro e não usa AppData nem pastas ocultas.

## O que é instalado

O instalador extrai estes arquivos para a pasta escolhida:

| Arquivo | Para que serve |
| --- | --- |
| `bethstudio-web.exe` | O Studio (Go + React em WebView2). É o programa que você abre. |
| `bethstudio-host.exe` | O host persistente. É dono de todos os terminais. |
| `bethstudio.exe` | A CLI e a ponte (`cli bridge`) entre o Studio e o host. |
| `bethstudio-tool.exe` | Terminais de ferramenta (SSH e serial) que o host cria. |
| `OpenConsole.exe` e `conpty.dll` | ConPTY empacotado, usado pelo host. |
| `LICENSE.md` e `NOTICE.md` | Licença e atribuição ao WezTerm. |

Os atalhos (`BethStudio.lnk`) apontam sempre para o `bethstudio-web.exe`.

## Onde ficam dados e logs

| O quê | Onde |
| --- | --- |
| Dados do usuário (sessão, temas, favoritos, configurações do Studio, notas, receita dos terminais) | `%APPDATA%\bethstudio\` |
| Registro de vida do host (inícios, paradas, quem pediu) | `%APPDATA%\bethstudio\host-life.log` |
| Log do Studio | `%LOCALAPPDATA%\bethstudio-web\bethstudio-web.log` |
| Chaves de provedores de IA (cifradas com DPAPI) | `%APPDATA%\bethstudio\secrets.dat` |

Se um terminal sumiu, leia primeiro o `host-life.log`. Uma parada com `requester UNKNOWN` veio de fora do Beth Studio.

Para mais sobre o que é guardado e o que sai da sua máquina, veja [Segurança e privacidade](Seguranca-e-privacidade) e [Host persistente e restauração](Host-persistente-e-restauracao).

## Atualizar sem perder terminais

Os terminais, os agentes e as sessões WSL vivem no `bethstudio-host.exe`. Parar o host perde tudo isso. Por isso:

- Se você só atualizar a interface, o host e os terminais continuam rodando.
- Se o executável do host mudou e há terminais rodando, o instalador pergunta:
  - **Sim**: encerra os hosts e atualiza tudo (os terminais são encerrados).
  - **Não**: atualiza só a interface. Os hosts e os terminais continuam.
  - **Cancelar**: não atualiza.
- Com o host em execução, o executável novo fica como `bethstudio-host.exe.new` e entra na próxima vez que o host iniciar. Para ele entrar, escolha **Encerrar tudo** na bandeja e abra o Beth Studio de novo (veja [Bandeja e supervisão](Bandeja-e-supervisao)).
- **Encerrar tudo antes de instalar** faz o caminho completo: fecha a interface primeiro, depois cada host (primeiro pelo evento de saída, depois forçando após 10 segundos).

Resumo: nada encerra seus terminais sem você pedir. Só a opção **Encerrar tudo** (no instalador ou na bandeja) faz isso, e sempre depois de uma confirmação.

## Desinstalar

Não há desinstalador. Como a instalação é portátil, remova à mão:

1. Se quiser manter os terminais, não faça nada ainda. Para sair de verdade, use **Encerrar tudo** na bandeja e confirme.
2. Apague a pasta de instalação (por exemplo `C:\Users\Public\BethStudio`).
3. Apague os atalhos `BethStudio.lnk` do Ambiente de Trabalho e do Menu Iniciar, se os criou.
4. Se quiser apagar também seus dados, apague `%APPDATA%\bethstudio\` e `%LOCALAPPDATA%\bethstudio-web\`.

## Variáveis de ambiente úteis

| Variável | Efeito |
| --- | --- |
| `BETHSTUDIO_DATA_DIR` | Troca a pasta de dados do Studio (os testes usam uma cópia). |
| `BETHSTUDIO_EXE` | Caminho do `bethstudio.exe` que o Studio usa como ponte. |
| `BETHSTUDIO_HOST_ID` | Dá ao host um identificador próprio (mutex, evento de saída e arquivos separados). Usado em testes isolados. |
| `BETHSTUDIO_HOST_EXE` | Caminho do host escolhido à mão (testes de integração). |
| `APPDATA` | Define a pasta de dados. O socket do host precisa caber em menos de 108 caracteres. |

As variáveis existem sobretudo para teste e desenvolvimento. No uso normal você não precisa de nenhuma.

## Próximos passos

- [Home](Home)
- [Terminais e abas](Terminais-e-abas)
- [Compilar do código](Compilar-do-codigo)
