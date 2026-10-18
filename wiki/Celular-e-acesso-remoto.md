# Celular e acesso remoto

O Beth Studio pode ser usado longe do PC de duas formas: um app web para o celular, feito para conversar com agentes, e o Studio completo aberto no navegador de outro computador. As duas passam por um programa Linux chamado `bethstudio-proxy`, que fica num servidor que você já tem.

Tudo isso é opcional e vem desligado. Sem configurar nada, o Beth Studio só escuta em `127.0.0.1` (veja [Segurança e privacidade](Seguranca-e-privacidade)).

## Como funciona

A arquitetura de rede, em termos genéricos:

```
celular ──HTTPS──> bethstudio-proxy (no servidor) ─────────────────────┐
                   (obtém o certificado sozinho)                      │ túnel
notebook ─HTTPS──> (mesmo caminho, em /studio/)                       │ aberto
                                                                      │ pelo PC
                                    Beth Studio no PC <───────────────┘
```

- **PC.** O Beth Studio continua só em `127.0.0.1`, sem tela de login. Quando a ligação está configurada, ele mesmo liga para fora, em `wss://meu-dominio.exemplo`, e reconecta se a conexão cair. Ninguém precisa abrir porta no roteador de casa.
- **Servidor.** O `bethstudio-proxy` recebe o celular e o túnel do PC. Há dois modos. No **modo HTTPS próprio** (`-tls`, o que o assistente instala) ele mesmo atende as portas 443 e 80 e cuida do certificado Let's Encrypt: nenhum outro programa no servidor. No **modo atrás de proxy** (`-listen`) ele escuta só localmente e o proxy HTTPS que você já tem termina o TLS e encaminha o domínio (inclusive WebSocket) para a porta TCP ou o socket Unix.
- **Celular ou notebook.** Abrem `https://meu-dominio.exemplo` (app do celular) ou `https://meu-dominio.exemplo/studio/` (Studio completo).

No modo HTTPS próprio, o cadeado do navegador é o certificado do próprio `bethstudio-proxy`. No modo atrás de proxy, é o do proxy HTTPS do servidor, e entre ele e o `bethstudio-proxy` o tráfego fica na própria máquina. A ligação do PC até o domínio é autenticada por um segredo que vai dentro da "linha do servidor" (veja abaixo).

## Como usar

### Opção A: o assistente "Instalar servidor" (VPS limpo, sem terminal)

Para um VPS Linux **novo e só para isso** (Debian 11/12/13 ou Ubuntu 22.04/24.04/26.04, amd64 ou arm64). Em **Configurações → Celular → Instalar servidor**:

1. **Cloudflare.** Cole um token de API com as permissões **Zone → DNS → Edit** e **Zone → Zone → Read** (só na zona que vai usar). O assistente lista as zonas; escolha a zona e o subdomínio (por exemplo `agentes.exemplo.com`).
   O registro é sempre **somente DNS (nuvem cinza)**: o servidor pede o certificado à Let's Encrypt sozinho e isso exige que a internet chegue direto nele. A nuvem laranja da Cloudflare não é oferecida porque fica no meio desse desafio (o desafio por TLS-ALPN, na porta 443, não passa por ela, e o desafio HTTP depende de ajustes da zona, como *Always Use HTTPS* e regras de WAF, que o assistente não controla).
2. **Servidor.** IP (ou nome), porta SSH, usuário e senha **ou** chave privada (cole o texto ou escolha o arquivo; passphrase opcional). Se o usuário não for root, ele precisa de sudo (informe a senha dele).
3. **Impressão digital.** O assistente mostra o SHA256 da chave do servidor. Compare com o painel do seu provedor e confirme. Se ela já foi confirmada antes, avisa; se **mudou**, bloqueia até você confirmar de propósito (normal só se o servidor foi reinstalado).
4. **Opções e "Ver o que será feito".** Senha do celular e atualizações de segurança automáticas. O botão lista cada passo e cada comando que será executado no servidor.
5. **Instalar.** O progresso aparece passo a passo: conexão, verificação (se o servidor **não** estiver limpo, para e explica, sem apagar nada), DNS, `bethstudio-proxy`, firewall, atualizações, certificado HTTPS, pareamento e teste de ponta a ponta. No fim: o endereço, um **QR code** e o estado da ligação.

Se algo falhar, a tela diz o passo, o erro e o que fazer. É só rodar de novo: o assistente confere o que já existe e continua, sem duplicar. Depois da instalação a mesma tela oferece **Atualizar o servidor** (envia o programa embutido neste Studio), **Ver estado** e **Ver logs**, **Trocar senha do celular** e **Remover o servidor** (para o serviço, apaga o programa, os dados com os certificados, o usuário de serviço `bethstudio` e **só** os registros DNS que o próprio assistente criou; não desinstala pacotes e não fecha portas).

O que ele instala: **só o `bethstudio-proxy`**, como serviço systemd. Ele atende HTTPS sozinho (portas 443 e 80), com certificado Let's Encrypt obtido e renovado automaticamente, redirecionamento HTTP→HTTPS, WebSocket, HSTS e `nosniff`. Roda como o usuário `bethstudio` (sem shell, não root), com permissão apenas de abrir as portas 80 e 443. Não há Caddy, nginx, repositório apt extra nem chave GPG. O `ufw` libera só SSH, 80 e 443 (a porta do SSH é liberada **antes** de ligar o firewall). Se o seu provedor tem firewall próprio no painel, libere 80 e 443 lá também.

Segurança: a senha SSH, a chave, a passphrase e o token da Cloudflare ficam só na memória durante o assistente (nunca em disco nem em log); por isso Atualizar, Ver estado e Remover pedem as credenciais de novo. Fica salvo no PC apenas `vps-server.json` (servidor, domínio, ids dos registros, impressão digital) e `vps-hostkeys.json`, sem segredos. O programa do servidor vem **dentro do Studio** (conferido por SHA-256 antes de usar e de novo no servidor depois do envio), então funciona offline e sem baixar nada sem checksum. As rotas do assistente só respondem à janela do Studio no PC: o celular e o Studio remoto não as alcançam.

Roteiro para testar com um VPS e uma conta Cloudflare reais: `bethstudio-web/docs/INSTALADOR-VPS-teste-manual.md`.

### Opção B: instalar à mão atrás do proxy que você já tem

### B1. Instalar o `bethstudio-proxy` no servidor

O programa é escrito em Go, neste projeto, e é compilado para Linux (`GOOS=linux GOARCH=amd64 go build -o bethstudio-proxy ./cmd/bethstudio-proxy`, dentro de `bethstudio-web/`). Veja [Compilar do código](Compilar-do-codigo).

Rodando o programa num terminal, ele pergunta o que fazer: instalar, iniciar, parar, reiniciar ou remover o serviço. Na instalação você escolhe:

- a pasta onde ele guarda a configuração e o segredo da ligação;
- o domínio que ele aceita (um `Host` diferente é recusado);
- como o celular chega: `host:porta` (por exemplo `127.0.0.1:8787`) ou um socket Unix (`unix:/caminho/do.sock`) atrás do seu proxy HTTPS, **ou** HTTPS direto (`-tls`, que atende 443 e 80 e obtém o certificado).

Com as opções completas na linha de comando ele não pergunta nada, para o systemd poder subir sozinho:

```
bethstudio-proxy -listen 127.0.0.1:8787 -domain meu-dominio.exemplo -data /var/lib/bethstudio-proxy
bethstudio-proxy -listen unix:/run/bethstudio-proxy.sock -domain meu-dominio.exemplo -data /var/lib/bethstudio-proxy
bethstudio-proxy -tls -domain meu-dominio.exemplo -data /var/lib/bethstudio-proxy [-acme-email eu@exemplo.com] [-acme-staging]
```

O **modo `-tls`** pede o certificado à Let's Encrypt para o domínio (e só para ele), guarda em `<pasta de dados>/certs` (permissão 0700) e renova sozinho. Exige que o domínio aponte para o servidor e que as portas 80 e 443 estejam livres e abertas. Fala TLS 1.2 ou 1.3, redireciona HTTP para HTTPS, envia HSTS (180 dias, sem subdomínios) e `nosniff`, e não usa HTTP/2 (o WebSocket do celular e do PC precisa de HTTP/1.1). O IP do cliente, usado no limite de tentativas, é o da conexão; `X-Forwarded-For` enviado pelo cliente nunca vale. `-acme-staging` usa a Let's Encrypt de testes (sem o limite de pedidos; o navegador não confia no certificado e o HSTS não é enviado). Com `-service` e `-tls`, a unit roda como o usuário `bethstudio` (criado se faltar), com `CAP_NET_BIND_SERVICE` e `ProtectSystem=strict`. Os modos `-listen` continuam como antes (unit como root).

A opção `-service` instala e inicia como serviço do systemd (`bethstudio-proxy.service`, com reinício automático em caso de falha). Em seguida, aponte o domínio do seu proxy HTTPS para essa porta ou socket. Se o seu proxy usa `X-Forwarded-For`, mantenha `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (exemplo de nginx): o `bethstudio-proxy` usa o último endereço dessa lista como IP do cliente. Sem isso, todos os pedidos parecem vir do mesmo IP e o limite por IP vira limite geral.

No fim, o programa imprime uma linha que começa com `bethstudio://link`. Ela contém o domínio e o segredo da ligação. Trate-a como uma senha: quem tem essa linha pode conectar um PC no seu proxy.

### B2. Ligar o PC ao proxy (a Opção A já faz isto sozinha)

1. No Beth Studio, abra **Configurações → Celular**.
2. Cole a linha em **Linha do servidor**.
3. Digite a **Senha do celular** (mínimo de 8 caracteres). Para manter a senha atual depois, deixe o campo em branco.
4. Clique em **Salvar**.

A mesma tela mostra o estado da ligação: **Conectado**, **Conectando…** ou **Desconectado** (com o motivo, quando há). Ela também mostra o endereço para abrir no celular. Se a ligação cair, o computador tenta de novo sozinho.

> Captura sugerida: Configurações → Celular com a linha colada, a senha preenchida e o indicador "Conectado".

### 3. Usar no celular

**Pelo QR code (recomendado).**

1. No PC, abra **Configurações → Celular → Aparelhos conectados** e clique em **Conectar um celular**.
2. Aponte a câmera do celular para o QR code (ou copie o link e mande para o celular).
3. O app abre já logado. Pronto: sem domínio e sem senha.

O link vale **5 minutos** e **uma única vez**. Gerar outro invalida o anterior. Se o celular mostrar "Link inválido ou expirado", gere um novo.

**Pela senha (alternativa).**

1. No celular, abra `https://meu-dominio.exemplo`.
2. Entre com a senha do celular. A tela de entrada diz: "Entre com a senha do celular que você criou no PC, em Configurações → Celular."

Depois, escolha o agente na lista e responda.

O app pode ser instalado na tela inicial (manifesto, ícones e service worker). Se o PC estiver offline, o app abre e avisa que o computador está desconectado, com **"Visto pela última vez às HH:MM de dd/mm"** e uma nova tentativa automática a cada 15 segundos. O service worker guarda só o app, nunca `/api` nem `/ws`.

### Aparelhos conectados

Cada celular que entra (pelo QR ou pela senha) vira um **aparelho**, com nome sugerido pelo navegador (por exemplo "iPhone — Safari"), data de entrada, último uso e último IP. Em **Configurações → Celular → Aparelhos conectados** dá para:

- **Renomear** um aparelho;
- **Revogar** um aparelho: a sessão cai na hora, inclusive a conexão aberta, e o celular volta à tela de entrada;
- **Revogar todos**.

A sessão de um aparelho expira após **90 dias sem uso** (e, em qualquer caso, 365 dias após a entrada). **Trocar a senha do celular não revoga os aparelhos já conectados**; para derrubá-los use Revogar. As sessões do Studio remoto continuam sendo encerradas ao trocar a senha.

> Captura sugerida: lista de terminais no celular, com um agente esperando resposta no topo.

## O app do celular

É um app web separado do Studio (`phone.html`, build própria). O domínio do celular não serve nenhum arquivo do Studio do PC. O app em si é público porque não traz dado nenhum; o que mostra terminais e voz vem por `/api` e `/ws`, que exigem a sessão.

O que ele faz:

- **Lista** cada terminal em execução uma vez só (aba, barra lateral e divisões lado a lado não duplicam a entrada). Agentes esperando resposta aparecem primeiro, com o tempo de espera; o terminal aberto por último no celular vem no topo do resto.
- **Busca** em **Procurar terminal** (nome, pasta, tipo, host; sem diferenciar acentos) e chips de tipo (Agentes, WSL, PowerShell, cmd, Git Bash, SSH), mostrando só os tipos que existem.
- **Um terminal por vez**, em letras grandes, com rolagem do histórico, tamanho do texto e quebra de linha. As linhas `───` dos agentes viram divisores finos.
- **Teclas rápidas** que enviam 1, 2, 3, seta para cima, seta para baixo, Enter e Esc, para menus de agentes.
- **Enviar** cola o texto no terminal e aperta Enter, para o agente seguir sozinho. Rascunhos sobrevivem a sair e voltar.
- **Falar** grava com medidor de nível. O áudio sobe para o PC e é transcrito lá; a correção por IA chega em streaming no próprio campo. O texto cai no campo para revisão, com **Voltar ao que foi transcrito** e **Apagar**. Nada vai ao terminal antes de **Enviar**. No iPhone, quando o gravador do Safari entrega um arquivo vazio, o celular envia um WAV gravado em paralelo.
- **Anexar imagem ou print** salva a imagem no PC (fotos grandes são reduzidas para JPEG antes) e coloca o link no texto; só vai ao terminal com **Enviar**. O limite é 25 MB.
- **Temas**: Automático (segue o celular), Claro, Escuro, Grafite, Nord, Dracula, Solarized escuro, Solarized claro e Alto contraste.
- **Sair deste celular** encerra a sessão do aparelho.

O que o celular **não** acessa: banco de dados, SSH, SFTP, arquivos, escolha de pasta, temas e fontes do Studio e configurações. Pelo túnel do celular só passam as operações listar, acompanhar, rolar, enviar texto e colar, mais os pedidos de voz e imagem. O celular nunca recebe o endereço nem a chave do provedor de voz: a transcrição e a correção acontecem no PC.

Veja também [Agentes e voz](Agentes-e-voz).

## Studio completo pelo navegador

O mesmo túnel serve o Studio inteiro em `https://meu-dominio.exemplo/studio/`, para acompanhar agentes de um notebook, por exemplo. Vem **desligado**.

### Ligar

1. Em **Configurações → Celular**, role até **Studio completo pelo navegador**.
2. Clique em **Configurar o segundo fator**. A tela mostra um QR (leia com um app autenticador, como Google Authenticator, Microsoft Authenticator, 1Password ou Aegis) e a chave em texto, para quem não tem câmera.
3. Digite o código de 6 dígitos e clique em **Confirmar**.
4. Marque a caixa de ligar o Studio remoto. Ela só liga com o segundo fator configurado.

> Captura sugerida: seção "Studio completo pelo navegador" com o QR do segundo fator.

### Entrar

A página de entrada pede **Senha** (a mesma do celular) e **Código** (TOTP: SHA-1, 6 dígitos, 30 segundos, aceita um passo para trás e um para frente; o mesmo código não vale duas vezes). A página não usa JavaScript. A mensagem de erro não diz qual dos dois estava errado.

### Sessões

- A sessão fecha após 12 horas sem uso e após 7 dias, mesmo em uso.
- No disco fica só o SHA-256 do token (`remote-sessions.json`).
- A seção **Sessões abertas** lista navegador, IP e último uso, com **Encerrar** e **Encerrar todas**.
- Trocar a senha, trocar o segundo fator ou desligar o acesso encerra todas as sessões remotas.
- Enquanto houver alguém conectado, o Studio do PC mostra um selo no canto, **Studio remoto conectado**. Clicar nele abre a tela de sessões.

### O que muda no Studio remoto

O Studio remoto dá controle amplo: quem entra mexe nos terminais, arquivos, bancos e SSH deste PC, como se estivesse sentado nele. Por isso tem dois fatores. O que abriria algo na tela do PC não está disponível pelo túnel (o servidor responde "Disponível só no PC"):

- escolher pasta, Abrir, Salvar como, Mostrar no Explorer e abrir com o programa padrão;
- abrir link no navegador do PC (no remoto, links abrem no navegador de quem usa);
- janelas nativas de Banco de dados e SFTP (no remoto abrem em outra aba);
- salvar histórico ou captura por diálogo.

Em vez disso, o remoto usa um navegador de pastas dentro da página, "Salvar uma cópia" vira download, e **Destacar em janela** não existe. O Studio remoto nunca muda o tamanho dos terminais no host: a interface mostra o tamanho do host, com escala para caber. A janela nativa e o Studio do PC não mudam quando o notebook abre. Também ficam só no PC as telas de configurar o acesso (`/api/phone/setup`, `/api/remote*`).

## Detalhes e limites

**Senha do celular.** Criada no PC, mínimo de 8 caracteres. No PC fica só o hash (bcrypt), nos segredos cifrados do Windows. O `bethstudio-proxy` não guarda a senha. A sessão de cada aparelho dura 90 dias sem uso (365 no máximo), num cookie `HttpOnly`, `Secure` e `SameSite=Strict`; no PC fica só o SHA-256 do token. O login do celular pede só a senha; o segundo fator vale apenas para o Studio remoto. O cookie do celular nunca abre o Studio remoto (o cookie do Studio remoto tem `Path=/studio`).

**A linha do servidor não é a senha.** Ela só autoriza este PC a ligar no seu proxy, e fica guardada nos segredos locais do Beth Studio. Uma ligação nova com a mesma linha substitui a anterior.

**Limite de tentativas.** Vale para o login do celular e do Studio remoto:

- por IP: 5 erros seguidos travam esse IP por 1 minuto; cada nova trava dobra, até 15 minutos; o contador volta a zero após 1 hora sem erro;
- geral: 30 erros em 10 minutos, somando todos os IPs, recusam o login pelo túnel até a janela passar. O Studio no PC não é afetado.
- o link do QR code conta igual: um link errado, vencido ou já usado é uma tentativa errada;
- o `bethstudio-proxy` ainda limita a 20 tentativas por minuto e por IP em `/api/phone/login` e `/api/phone/pair` (resposta 429), só para poupar o PC.

O IP vem do proxy (que sobrescreve o cabeçalho `X-BethStudio-Client`), então trocar cabeçalhos no celular não contorna o limite.

**Verificações em cada pedido pelo túnel.** O `Host` precisa ser o domínio configurado. Pedidos que alteram algo e o WebSocket precisam de `Origin` igual a `https://meu-dominio.exemplo`. Há política de conteúdo (CSP) restrita, `X-Frame-Options: DENY` e `Referrer-Policy: same-origin`.

**Registro.** Entradas, erros de senha ou código, bloqueios e sessões encerradas vão para `remote-access.log` (em `%LOCALAPPDATA%\bethstudio-web`). Em **Configurações → Sobre** aparece o caminho do arquivo.

**Modo somente leitura.** Se o Beth Studio foi iniciado com `--read-only` (opção de linha de comando, pensada para testes), o celular mostra "O PC está em somente leitura" no campo de mensagem e recusa enviar, colar, voz e imagem. Não há botão para isso na interface.

**Confiança no servidor.** O TLS termina no proxy HTTPS do servidor, então quem controla esse servidor consegue ver o tráfego que passa por ele (texto dos terminais, o que você digita). Para entrar, essa pessoa ainda precisaria da senha (e do código, no Studio remoto), mas o conteúdo não é cifrado ponta a ponta além do TLS do proxy. Use um servidor seu e de confiança.

**QR do celular.** O QR de **Conectar um celular** leva a `https://meu-dominio.exemplo/#pair=<token>`. O token fica depois do `#`, que o navegador não envia ao servidor (não aparece em log do proxy nem em `Referer`); o app o lê, apaga da barra de endereço e o troca por uma sessão com um POST. Não confunda com o QR do segundo fator do Studio remoto (app autenticador).

**Última vez visto.** O `bethstudio-proxy` grava a hora em que o PC esteve ligado (ao ligar, a cada 30 segundos e ao cair) no arquivo `last-seen` da pasta de dados dele, então a informação sobrevive a um reinício do proxy. A página pública de "computador desconectado" mostra só essa hora, nada mais. Precisa da versão nova do `bethstudio-proxy` no servidor.

**Fora do escopo.** App nativo com notificação, várias pessoas num mesmo proxy e edição simultânea do layout nos dois Studios (vale a última gravação).

## App Expo `bethstudio-mobile` (esqueleto)

A pasta `bethstudio-mobile/` tem um app Android/iOS em Expo e TypeScript. **É um esqueleto, não o caminho que funciona hoje.** Ele tem telas de conexões (com "Somente leitura" por conexão, ligado por padrão), de terminais e de terminal com xterm.js, e roda contra um servidor de testes. O acesso remoto ainda não está ligado nele: o caminho para o celular que funciona é o app web descrito acima, com o `bethstudio-proxy`. O documento `bethstudio-mobile/docs/REMOTE_ACCESS.md` é uma proposta antiga e não é o que roda.

Para saber como o restante se encaixa, veja [Arquitetura](Arquitetura), [Bandeja e supervisão](Bandeja-e-supervisao) e [Host persistente e restauração](Host-persistente-e-restauracao).
