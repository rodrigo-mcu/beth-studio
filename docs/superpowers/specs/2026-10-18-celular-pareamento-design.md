# Celular: pareamento por QR, aparelhos, PC offline e proteção de senha

Data: 2026-10-18. Estado: implementado neste branch.

## Problema

Para entrar no web app do celular é preciso digitar domínio e senha, a senha
é única para todos os celulares, não há como derrubar um celular perdido sem
trocar a senha, a tela "PC desconectado" não diz desde quando, e a proteção
de senha existe só para a senha (não para o novo fluxo).

## Decisões

### 1. Link mágico / QR (uso único)

- Studio do PC: Configurações > Celular > "Conectar um celular" gera um token
  de 32 bytes aleatórios (`crypto/rand`, 256 bits), mostrado como QR code e
  como link `https://<domínio>/#pair=<token>`.
- O token vai no **fragmento (#)**: o navegador não o envia ao servidor, então
  não aparece em log de proxy, nem em `Referer`. O web app lê o fragmento,
  apaga-o da barra (`history.replaceState`) e faz `POST /api/phone/pair`
  `{token}`. A resposta define o cookie de sessão.
- Validade: **5 minutos** e **uma única vez**. Só existe um link pendente por vez: gerar outro invalida o anterior. No disco só fica o SHA-256 do
  token (`phone-devices.json`). A comparação percorre os pendentes com
  `subtle.ConstantTimeCompare`. O consumo acontece sob um mutex: dois usos
  simultâneos, só um vale. Token errado, usado ou expirado dão a mesma
  mensagem ("link inválido ou expirado").
- Cada falha conta no limitador de tentativas (item 4). Nunca se registra o
  token no log.

### 2. Aparelhos

- Cada entrada (link mágico ou senha) cria um **aparelho**: id público,
  nome (sugerido do user-agent, ex. "iPhone — Safari", editável), criado em,
  último uso, último IP. A sessão é um token aleatório de 256 bits no cookie
  `bethstudio_phone` (`HttpOnly; Secure; SameSite=Strict`); no disco fica só o
  SHA-256.
- Expiração: **90 dias sem uso** (deslizante; o cookie é renovado em
  `/api/phone/me`) e **365 dias no máximo** desde a criação.
- Revogar um aparelho (ou todos) remove a sessão e **fecha na hora os
  WebSockets** dele (`hub.dropPhone`); o WS também se confere a cada ping.
- **Senha antiga**: continua valendo e continua obrigatória para salvar a
  configuração do servidor (o Studio remoto usa a mesma senha). Entrar com
  ela também cria um aparelho (aparece na lista). **Trocar a senha NÃO revoga
  aparelhos já pareados** (antes derrubava as sessões do celular); existe o
  botão separado "Revogar todos". O Studio remoto continua sendo derrubado ao
  trocar a senha, como antes.
- Migração: sessões do `phone-sessions.json` antigo viram aparelhos
  "Aparelho anterior" na primeira carga e o arquivo antigo é apagado.
- Rotas de gestão (`/api/phone/devices`, `/pairing`, `/rename`, `/revoke`,
  `/revoke-all`) existem só na interface local do Studio (token do Studio).
  Não existem em `servePhonePublic` (404 mesmo com sessão do celular) e estão
  em `remoteOnlyOnPC` (o Studio remoto também não as alcança).

### 3. PC offline

- `phonelink.Proxy` guarda quando o PC foi visto pela última vez (em memória
  e em `last-seen` na pasta de dados do proxy): ao ligar, a cada 30 s
  enquanto ligado e ao cair. Sobrevive a reinício do proxy.
- A página offline pública mostra só "Visto pela última vez às HH:MM de
  dd/mm" (convertida para o fuso do navegador por um script inline; sem
  script, mostra em UTC) e recarrega sozinha a cada 20 s. Para `/api/*` o
  proxy responde 503 em JSON `{"offline":true,"last_seen":"<RFC3339>"}`, que
  o web app usa na tela "O computador está desconectado", com nova tentativa
  automática a cada 15 s. Nada além da hora é exposto.

### 4. Proteção contra tentativas

- O Studio já tinha `loginLimiter` por IP (5 erros = 1 min, dobrando até 15
  min; 30 erros em 10 min no total). Passa a valer também para o resgate de
  token de pareamento. O IP vem de `X-BethStudio-Client`, que o proxy
  **sobrescreve** a partir da conexão/`X-Forwarded-For` do proxy HTTPS (o
  Studio só recebe pedidos pelo túnel do proxy), logo o cliente não forja.
- No `bethstudio-proxy`: teto de 20 POSTs/min por IP em `/api/phone/login` e
  `/api/phone/pair` (429 com `Retry-After`), para não martelar o PC.
- Log (`remote-access.log`): IP e resultado, nunca senha nem token.

## Compatibilidade

- UI nova + Studio antigo: a seção de aparelhos recebe 404 e se esconde.
  Não precisa subir `apiLevel`.
- Studio novo + proxy antigo: tudo funciona, menos a hora da última vez.
- Atualizar o proxy exige trocar o binário no servidor.
