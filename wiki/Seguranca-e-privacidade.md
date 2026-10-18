# Segurança e privacidade

O Beth Studio é um programa local. Por padrão ele só conversa com o próprio computador, não coleta dados sobre você e não tem telemetria. O que sai da máquina sai porque você ligou um recurso que precisa disso, e esta página lista cada um.

## Como funciona

### Modelo de ameaça, em resumo

O Beth Studio foi pensado para um computador pessoal com uma pessoa usando. Ele protege contra:

- outros sites abertos no seu navegador tentando falar com o Studio;
- outros programas ou usuários da rede tentando alcançar o Studio;
- alguém que descubra o endereço do acesso remoto, quando você o liga.

Ele **não** protege contra: um atacante que já está rodando como o seu usuário do Windows (ele lê seus arquivos de qualquer jeito); dependências comprometidas na hora de compilar; você colar no terminal um texto malicioso; ou rodar um arquivo de configuração hostil. O documento `docs/SECURITY.md` do repositório descreve esse modelo, e o ponto de partida dele é o mesmo: uma ameaça local com a mesma conta de usuário não é algo que o programa consiga impedir.

### Acesso local do Studio

O Studio (`bethstudio-web`) funciona como uma página que roda dentro do WebView2, servida pelo próprio programa:

- **Escuta só em `127.0.0.1`**, numa porta aleatória a cada execução. Nada fica visível na rede local.
- **Token aleatório por execução**, exigido em toda requisição HTTP e WebSocket. Ele pode vir na primeira URL, no cabeçalho `X-BethStudio-Token` ou no cookie da própria porta (`HttpOnly`, `SameSite=Strict`). A comparação é em tempo constante.
- **Origem obrigatória no WebSocket.** Uma conexão WebSocket sem o cabeçalho `Origin` é recusada. Qualquer requisição com `Origin` precisa ser a do próprio Studio (`http://127.0.0.1:<porta>` ou `localhost` na mesma porta).
- **Verificação de `Host`.** Só `127.0.0.1:<porta>` e `localhost:<porta>` são aceitos, para impedir DNS rebinding.
- **Política de conteúdo (CSP)** restrita e `frame-ancestors 'none'`. O navegador não fala com provedores externos: todas as chamadas de rede saem do programa em Go.
- **Operações com arquivos** exigem caminho absoluto, sem `..`. Prévia e gravação só aceitam extensão de texto ou imagem, com limite de tamanho; a escrita usa arquivo temporário e renomeação. Abrir no programa padrão vale para qualquer arquivo que exista e não seja programa ou script; esses só são mostrados na pasta, sem execução.

### Cofre de segredos

As chaves e senhas ficam cifradas com a **DPAPI do Windows** (escopo do usuário), em `secrets.dat` na pasta de dados do Beth Studio. Isso inclui chaves de provedores de IA, tokens de conta, senhas de conexões de banco e SSH e, no acesso remoto, a linha do servidor, o hash da senha do celular e o segredo do segundo fator. A interface mostra só uma máscara (por exemplo `••••1234`), nunca a chave. Esses valores não vão para `web-settings.json`.

Limite honesto: a DPAPI do usuário protege contra outros usuários e contra quem copia só o arquivo para outra máquina. Não protege contra um programa rodando como você no mesmo Windows, que pode pedir ao sistema para decifrar.

### O que sai do computador

Nada, por padrão. Estas são as exceções, todas por ação sua:

| Recurso | O que sai | Para onde |
|---|---|---|
| Voz e correção por IA | Áudio gravado (transcrição) e o texto (correção opcional) | O provedor que você escolheu e configurou. O áudio e o texto não são guardados pelo Beth Studio; fica só o custo de cada chamada em `ai-usage.jsonl`. Na primeira gravação o Studio avisa para onde o áudio vai e pede confirmação (**Entendi, gravar**). |
| Lista de modelos e preços | Pedido de catálogo, sem dados seus | Páginas públicas de provedores, ao consultar modelos |
| Login de conta (Grok Build, Codex) | Fluxo OAuth de dispositivo | Servidores de autenticação do provedor |
| Temas | Nada: o Studio não baixa temas, só lê os arquivos da pasta `%APPDATA%\bethstudio\themes` | Não sai do seu computador |
| SSH, serial, banco de dados | O tráfego da conexão que você configurou | O host ou banco que você escolheu |
| Acesso remoto (celular e Studio no navegador) | O conteúdo dos terminais e o que você digita, pelo túnel | O seu servidor e o domínio que você configurou; ver abaixo |
| Verificar atualização | Nada seu: um pedido anônimo, sem conta, só quando você clica em **Configurações → Sobre → Verificar atualização** | A API pública de releases do repositório do Beth Studio no GitHub. O Studio não consulta sozinho |

A verificação de atualização não é automática e não é telemetria. No modo somente leitura e no Studio aberto pelo navegador, a tela só avisa que há versão nova. A página do celular não tem esse botão.

### Telemetria

**Não há telemetria.** Nenhum evento de uso, relatório de falha ou estatística anônima é enviado. A política em `docs/PRIVACY.md` diz o mesmo, herdando a postura do WezTerm. Nos arquivos de log, nenhum nível inclui o conteúdo do que você digita ou da área de transferência. A área de transferência é local e não é sincronizada com outro aparelho.

### Acesso remoto, quando ligado

O acesso pelo celular e pelo navegador (veja [Celular e acesso remoto](Celular-e-acesso-remoto)) é o único recurso que expõe o Beth Studio fora do PC. Ele vem desligado. O PC continua escutando só em `127.0.0.1`: é ele que liga para fora, no seu servidor.

- **Rotas separadas.** O app do celular só lê agentes e manda texto, voz e imagem. Banco, SSH, SFTP, arquivos e configurações não têm rota pelo túnel do celular.
- **Senha do celular.** Mínimo de 8 caracteres, guardada só como hash (bcrypt) no PC. O proxy no servidor não a conhece. Continua valendo como alternativa ao QR code.
- **QR code / link de pareamento.** Token aleatório de 256 bits, uso único, vale 5 minutos, vai no fragmento (`#`) da URL (nunca na query string) e é trocado por uma sessão com um POST. No disco fica só o SHA-256; a comparação é em tempo constante; nunca vai para o log. Gerar, listar, renomear e revogar aparelhos só existe na interface do Studio no PC: nem o celular nem o Studio remoto alcançam essas rotas.
- **Aparelhos.** Cada celular tem sessão própria (token de 256 bits, só o SHA-256 no disco), 90 dias sem uso ou 365 no máximo. Revogar derruba a sessão e o WebSocket aberto na hora. Trocar a senha não revoga aparelhos; **Revogar todos** faz isso.
- **Segundo fator para o Studio completo.** Senha mais código TOTP de 6 dígitos (um código não vale duas vezes). O Studio completo só liga com o segundo fator configurado.
- **Cookies** `HttpOnly`, `Secure`, `SameSite=Strict`. O cookie do celular não abre o Studio completo, e o do Studio completo vale só em `/studio`.
- **Sessões.** Celular: por aparelho, 90 dias sem uso. Studio completo: 12 horas sem uso e 7 dias no máximo; só o SHA-256 do token fica no disco. Trocar a senha, trocar o segundo fator ou desligar o acesso encerra as sessões do Studio completo. Há botões **Encerrar** e **Encerrar todas**.
- **Limite de tentativas.** Por IP: 5 erros seguidos travam esse IP por 1 minuto, com espera que dobra até 15 minutos. Geral: 30 erros em 10 minutos recusam todo o login pelo túnel até a janela passar. O Studio do PC não é afetado.
- **Proxy.** O `bethstudio-proxy` limita a 20 tentativas por minuto e por IP nas rotas de entrada, e sobrescreve o IP do cliente que repassa ao Studio. A página pública de "desconectado" mostra apenas a hora da última vez que o PC foi visto.
- **Origem e host.** O proxy só aceita o domínio configurado, e pedidos que alteram algo e o WebSocket precisam de `Origin` igual a `https://<domínio>`.
- **Operações presas ao PC.** O que abriria algo na tela do PC (escolher pasta, Explorer, janelas de Banco e SFTP, abrir link) responde 403 pelo túnel.
- **Registro** em `remote-access.log`: entradas, erros, bloqueios e sessões encerradas.
- **Aviso.** Enquanto alguém usa o Studio completo, o Studio do PC mostra **Studio remoto conectado**.

O que o acesso remoto **não** faz: não cifra de ponta a ponta além do TLS do proxy HTTPS do seu servidor. Quem controla esse servidor consegue ver o tráfego. E o Studio completo dá controle amplo sobre o PC (terminais, arquivos, bancos, SSH): proteja a senha e o aplicativo autenticador como protegeria o acesso ao próprio computador.

### Modo somente leitura

Se o `bethstudio-web` for iniciado com `--read-only`, ele recusa enviar texto, colar, encerrar, redimensionar, abrir ou separar terminais e as chamadas pagas de voz, e conexões de banco ficam só para leitura. É uma opção de linha de comando, pensada para testes e demonstrações; não há botão para ligá-la na interface. O app do celular avisa "O PC está em somente leitura" quando esse modo está ativo. Cada conexão de banco também pode ser marcada como somente leitura (veja [Banco de dados](Banco-de-dados)).

### Terminais que você não quer perder

Segurança também é não perder trabalho. O Studio nunca encerra o host por conta própria: só **Encerrar tudo**, na bandeja, depois de uma confirmação que diz quantos terminais serão fechados. Veja [Bandeja e supervisão](Bandeja-e-supervisao) e [Host persistente e restauração](Host-persistente-e-restauracao).

## Detalhes e limites

- **Arquivos de dados** ficam em `%APPDATA%\bethstudio\` (sessão, temas, configurações, `secrets.dat`) e `%LOCALAPPDATA%\bethstudio-web\` (logs). Nada disso é enviado. Em **Configurações → Sobre** aparecem os caminhos de cada um.
- **Documentos antigos.** O `docs/SECURITY.md` e o `docs/PRIVACY.md` foram escritos antes do acesso remoto e descrevem o Beth Studio como puramente local, com o download de temas como única saída para a rede. O acesso remoto, a voz e a IA são opcionais e estão descritos aqui. Em caso de divergência, vale o que esta página descreve a partir do código atual.
- **O token local não é uma senha de usuário.** Ele protege contra páginas e programas que não conhecem o token, não contra quem já roda como você.
- **Servidor próprio.** O `bethstudio-proxy` precisa de um servidor seu, com HTTPS já resolvido. Mantenha-o atualizado e o acesso a ele restrito.
- **Segredos nunca devem ir para tickets e capturas.** A linha `bethstudio://link` e o QR do segundo fator são credenciais.

### Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use os relatos privados de vulnerabilidade do GitHub neste repositório: **Security → Advisories → Report a vulnerability**. Inclua:

- a descrição do problema;
- os passos para reproduzir;
- a versão afetada;
- sua avaliação do impacto;
- opcionalmente, uma sugestão de correção.

A meta é confirmar o recebimento em até 3 dias úteis. O projeto se compromete a não tomar medidas legais contra quem agir de boa-fé, a manter você informado sobre o prazo da correção e a creditar você nas notas de versão (a menos que prefira anonimato). Não há programa pago de recompensa nem prazo garantido para problemas não críticos. Está coberta a versão lançada mais recente; a `main` em desenvolvimento tem suporte "no melhor esforço". Problemas no WezTerm sem modificação ficam fora do escopo e devem ir para o projeto original (veja [Relação com o WezTerm](Relacao-com-o-WezTerm)).

Veja também [Arquitetura](Arquitetura) e [Instalação](Instalacao).
