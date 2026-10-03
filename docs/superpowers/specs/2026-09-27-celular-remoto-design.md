# Celular remoto — desenho

Data: 2026-09-27. O objetivo é interagir com os agentes pelo celular, de forma simples: ler o que o agente escreveu e responder com texto ou áudio, para o trabalho continuar longe do PC.

O agente vive num terminal. A página mostra esses terminais, um por vez, sem copiar o resto do Beth Studio. Banco, SSH, SFTP, arquivos locais e configurações não entram. O Studio neste PC não muda.

## O que a pessoa faz

1. Compila `bethstudio-proxy` para Linux e instala no servidor que já tem, na pasta que escolher.
2. Sobe o serviço escolhendo o domínio e onde ele ouve: uma porta TCP ou um unix socket.
3. No proxy que já existe nesse servidor, aponta esse domínio para essa porta ou socket. O certificado continua nesse proxy.
4. O `bethstudio-proxy` imprime uma linha que começa com `bethstudio://link`. A pessoa cola essa linha uma vez em Configurações → Celular e cria a senha do celular neste PC. A mesma tela mostra se este computador está conectado, conectando ou desconectado.
5. No celular, abre `https://domínio`, entra com a senha, escolhe o agente e responde. O texto é colado no terminal e o Enter é apertado, para o agente seguir sozinho. O áudio vira texto neste PC e segue o mesmo caminho.

## Peças

**`bethstudio-proxy`, no servidor Linux.** Programa em Go deste projeto, compilado para Linux. Não abre as portas 80 e 443 e não pede certificado. Na instalação a pessoa escolhe:

- a pasta onde ele fica, com a configuração e o segredo da ligação
- o domínio que ele aceita (`Host` diferente desse domínio é recusado)
- onde escuta: `host:porta` ou um unix socket

O proxy que já está no servidor termina o HTTPS e encaminha esse domínio, inclusive o WebSocket, para essa porta ou socket. Sem a ligação do Beth Studio, a página diz que o computador está desconectado e nada é encaminhado.

Rodar o programa num terminal pergunta o que fazer: instalar, iniciar, parar, reiniciar ou remover o serviço. Com as opções completas na linha de comando, não pergunta nada, para o systemd subir sozinho. No fim da instalação, o texto diz para colar a linha no Beth Studio e abrir `https://domínio` no celular.

**Beth Studio, neste PC.** Continua só em `127.0.0.1`, com o token de sempre, sem tela de login. Quando a linha está configurada, liga para fora em `wss://domínio` e reconecta se a ligação cair. Uma ligação nova com a mesma linha substitui a anterior.

**Página do celular.** O celular também entra por `https://domínio`. O proxy já existente encaminha até o `bethstudio-proxy`, e de lá a ligação chega nesta página.

O cadeado do celular é o do proxy que já existe no servidor. Entre esse proxy e o `bethstudio-proxy` o tráfego fica na máquina, pela porta local ou pelo socket. A ligação do PC até o domínio é autenticada pelo segredo que vai dentro da linha.

## O que atravessa a ligação

Só o necessário para ler o agente e responder:

- a página do celular e os arquivos dela
- login e sessão
- lista, leitura e rolagem
- envio de texto (colar e apertar Enter)
- o áudio gravado no celular, que sobe para este PC. A transcrição e a correção acontecem no Beth Studio. O celular não recebe o endereço nem a chave do provedor, e não chama essa API.

Não há rota para banco, SSH, SFTP, arquivos, escolha de pasta, temas, fontes nem configurações.

## Login

A senha é criada neste PC. O proxy não a guarda. Aqui fica só o hash. Mínimo de 8 caracteres.

Antes da senha certa, o domínio mostra a tela de login. Nenhum terminal aparece. A sessão vai num cookie `HttpOnly`, `Secure`, `SameSite=Strict`, por 30 dias. A lista tem um botão de sair. Trocar a senha neste PC encerra as sessões.

Cinco senhas erradas seguidas, no mesmo endereço, esperam um minuto antes da próxima tentativa.

A linha do servidor não é essa senha. Ela só autoriza este PC a ligar no servidor. Fica guardada nos segredos locais do Beth Studio.

## Lista no celular

Um item por terminal em execução, porque é ali que o agente está. A identidade é esse terminal, não o lugar em que o Studio o desenha. Aba, barra lateral ou divisão lado a lado não criam uma segunda entrada.

Dois agentes diferentes, mesmo lado a lado no Studio, são dois itens. Abrir um ocupa a página inteira: o texto do agente em letras grandes, a resposta embaixo. Voltar retorna à lista. Não há duas colunas.

Ordem: agente esperando resposta primeiro, o mais antigo no topo; o resto pelo título.

## Fora desta entrega

App nativo, notificação com o celular bloqueado, várias pessoas no mesmo proxy, banco, SSH, arquivos e qualquer tela que não seja essa conversa com o agente.

## Revisão de 2026-09-27 (noite): web-app próprio

- A página do celular deixou de ser o Studio com `?mode=phone`. É uma build separada (`frontend/phone.html`, `src/phone/`, `dist/phone`), e o domínio do celular não serve nenhum arquivo do Studio no PC.
- O app (HTML, JS, CSS, manifesto, ícones, service worker) é público porque não traz dado nenhum; a tela de login é parte dele. `/api` e `/ws` continuam exigindo a sessão. `GET /api/phone/me` diz se a sessão vale.
- Instalável na tela inicial. O service worker guarda só o app, nunca `/api` nem `/ws`.
- Microfone: no iPhone o MediaRecorder entregou 1392 bytes para 8,3 s de fala (só o cabeçalho do MP4). O celular agora grava em paralelo PCM pelo Web Audio e sobe WAV 16 kHz quando o arquivo do MediaRecorder vem oco; silêncio total não sobe. O medidor de nível mostra o som real enquanto grava. O microfone escolhido no PC não é mais enviado ao celular.
- O texto ditado sempre cai no campo para revisão. A correção por IA chega em streaming no próprio campo (antes era descartada: o celular lia NDJSON como JSON). Nada vai ao terminal antes de Enviar.
