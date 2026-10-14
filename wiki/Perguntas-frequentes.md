# Perguntas frequentes

Respostas curtas para as dúvidas mais comuns. Cada resposta aponta para a página com os detalhes.

## O que acontece se eu fechar o Studio?

Os terminais continuam rodando. Ao fechar a janela principal, o Studio se esconde na bandeja e o ícone fica no relógio. **Sair da bandeja** fecha o Studio e deixa o host e os terminais rodando. Fechar uma aba no Studio também não encerra o terminal: só **Encerrar terminal…**, com confirmação, faz isso. Veja [Bandeja e supervisão](Bandeja-e-supervisao).

## O que acontece se o host cair?

O Studio percebe e reinicia o host, no máximo 3 vezes em 10 minutos. Se passar disso, mostra o aviso **Host indisponível** com o botão **Tentar de novo**. Depois de uma queda, o Studio recria os terminais a partir de uma receita (shell, pasta, distro WSL, host SSH ou porta serial salvos). Isso só acontece quando o host novo é outro processo, está vazio e a receita tem menos de 7 dias. O que estava rodando dentro dos terminais (programas, agentes) não volta: o terminal é recriado, não retomado. Veja [Host persistente e restauração](Host-persistente-e-restauracao).

## Como encerro tudo de verdade?

Pela bandeja, em **Encerrar tudo**. O Studio pergunta antes e diz quantos terminais serão fechados. É a única forma de o Beth Studio parar o host. O instalador tem uma opção parecida, **Encerrar tudo antes de instalar**, que também pede confirmação.

## Posso usar em macOS ou Linux?

Hoje, não. O Beth Studio só roda no Windows: usa ConPTY, WebView2, a bandeja do Windows e um instalador Win32. O WezTerm de origem é multiplataforma, mas o Beth Studio não foi portado. Há planos de portar para **Linux** e **macOS** (sem WSL, que só existe no Windows), mas sem data e sem compromisso de entrega. A ordem prevista é Linux primeiro, com a interface aberta no navegador, e depois macOS, que ainda exige assinatura e notarização da Apple. O que falta trocar: a janela (WebView2), os terminais do lado Go (ConPTY por PTY comum), o cofre de senhas (DPAPI), a bandeja, o início com o sistema, a área de transferência e o seletor de pasta, além dos instaladores. O host persistente, a interface web e a página do celular já são portáveis em princípio. Quer ajudar? Abra uma issue antes de enviar código. O único programa para Linux é o `bethstudio-proxy`, o relé opcional do acesso pelo celular (veja [Celular e acesso remoto](Celular-e-acesso-remoto)).

## Tem janela nativa?

Não mais. A janela nativa do WezTerm foi removida (patch 0198). O Studio é a única interface. Os subcomandos `start`, `ssh`, `serial` e `connect` do `bethstudio.exe` respondem com uma mensagem pedindo para abrir o Beth Studio. Veja [Relação com o WezTerm](Relacao-com-o-WezTerm).

## Onde ficam os meus dados?

Em `%APPDATA%\bethstudio\`: sessão, temas baixados, favoritos, configurações do Studio, notas e a receita dos terminais. O log do Studio fica em `%LOCALAPPDATA%\bethstudio-web\bethstudio-web.log`. As chaves de provedores de IA ficam cifradas com DPAPI em `secrets.dat`. Os programas ficam só na pasta de instalação. Veja [Instalação](Instalacao).

## Funciona offline?

Sim, para o uso local: terminais, abas, notas, editor e temas já gravados na pasta de temas não precisam de internet. Precisam de rede só as funções que, por natureza, saem da máquina: voz e IA (provedor escolhido por você), conexões SSH e bancos de dados remotos, o acesso pelo celular, e **Verificar atualização** quando você clica nesse botão. O Studio não consulta o GitHub sozinho. Veja [Instalação](Instalacao) e [Segurança e privacidade](Seguranca-e-privacidade).

## O Beth Studio envia dados sobre mim?

Não. O projeto não tem telemetria, relatório de falhas nem estatísticas, e não usa SDKs de análise de terceiros. As chamadas de rede feitas por ele são as que você aciona, como usar voz e IA, ou **Verificar atualização** em Configurações → Sobre (um pedido anônimo ao GitHub, sem conta). Veja [Segurança e privacidade](Seguranca-e-privacidade).

## É seguro abrir pelo celular?

O acesso é opcional e vem desligado. Nada sai do seu computador até você montar o relé (`bethstudio-proxy`) em um servidor Linux seu. O Studio local escuta só na interface local (loopback), em uma porta aleatória, e exige um token em toda requisição. O celular tem uma página própria, atrás de senha, que só lê agentes e envia texto ou áudio. Banco de dados, SSH e arquivos ficam na janela do Studio. O Studio completo pelo navegador é outra opção, desligada por padrão: pede senha e um código de 6 dígitos (autenticador), encerra a sessão após 12 horas sem uso e 7 dias no máximo, limita tentativas erradas e registra entradas e falhas em `remote-access.log`. Um relé mal configurado ou um servidor exposto continua sendo risco seu. Leia [Celular e acesso remoto](Celular-e-acesso-remoto) e [Segurança e privacidade](Seguranca-e-privacidade).

## Preciso instalar o WebView2?

O Windows 11 e o Windows 10 atual já têm o WebView2 Runtime. Se faltar, o Studio mostra uma mensagem pedindo para instalar o Microsoft Edge WebView2 Runtime. Veja [Instalação](Instalacao).

## Posso atualizar sem perder meus terminais?

Sim. O instalador só troca o host quando você manda. Com o host rodando, o executável novo fica como `bethstudio-host.exe.new` e entra na próxima vez que o host iniciar. Se o host mudou e há terminais abertos, o instalador pergunta se você quer encerrá-los ou atualizar só a interface. Veja [Instalação](Instalacao).

## Posso usar meu `wezterm.lua`?

Sim. O Beth Studio lê o `wezterm.lua` (ou `.wezterm.lua`) sem mudanças. As opções próprias ficam em uma tabela `wtinator = { ... }`, o nome histórico do crate. A maioria das funções é feita com o mouse e não precisa de configuração. Veja [Terminais e abas](Terminais-e-abas).

## Posso rodar o Beth Studio ao lado de um WezTerm instalado?

O Beth Studio usa executáveis com nomes próprios (`bethstudio*.exe`) e pasta de dados própria (`%APPDATA%\bethstudio`). Uma instalação do WezTerm em `C:\Program Files\WezTerm` não é usada por ele. Ao testar o Beth Studio pela linha de comando, chame o `bethstudio.exe` e não o `wezterm` do `PATH`.

## O Beth Studio é o WezTerm com outro nome?

Não. Ele é um derivado do WezTerm: reaproveita o motor de terminal, o multiplexador e o host, mas tem interface própria e uma série de mudanças documentadas. Tudo está na [Relação com o WezTerm](Relacao-com-o-WezTerm). O WezTerm é MIT, o Beth Studio também.

## Como reporto um defeito ou uma falha de segurança?

- **Defeito comum:** abra uma issue no repositório do GitHub. Para algo maior, abra a issue antes de enviar um pull request. Inclua os passos para reproduzir e a versão. Se um terminal sumiu, anexe as linhas relevantes de `%APPDATA%\bethstudio\host-life.log`.
- **Defeito do núcleo do WezTerm** que também existe lá: reporte em [wezterm/wezterm](https://github.com/wezterm/wezterm).
- **Falha de segurança:** não abra issue pública. Use o relato privado de vulnerabilidades do GitHub (Security, Advisories, Report a vulnerability). O projeto procura responder em até 3 dias úteis.

Veja também [Compilar do código](Compilar-do-codigo) se quiser contribuir com uma correção.
