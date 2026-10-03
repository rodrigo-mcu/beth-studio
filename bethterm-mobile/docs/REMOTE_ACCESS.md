# Acesso remoto ao bethterm-web — proposta (para revisão)

**Status:** proposta, 2026-09-25. Nada disto está implementado no PC.
O app `bethterm-mobile` já fala o protocolo WS de hoje e troca de
transporte só pela URL (`ws://` em desenvolvimento, `wss://` no modo remoto).

## 1. Situação atual

O `bethterm-web` (Go) foi feito para uso **local**:

- escuta só em `127.0.0.1:<porta aleatória>`;
- token aleatório por execução, aceito em `?t=`, no header
  `X-BethTerm-Token` ou num cookie HttpOnly por porta;
- recusa `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>`
  (proteção contra DNS rebinding) e `Origin` diferente da própria origem;
- WS exige `Origin`; `send`/`paste` recusados com `--read-only` (global);
- sem TLS, sem noção de "aparelho", sem log de auditoria.

Quem tem o token e alcança a porta **digita em todos os terminais do
host**, incluindo agentes de IA com permissões e sessões WSL com root.
Expor isso na rede é expor um shell.

## 2. Ameaças que a proposta cobre

| Ameaça | Exemplo | Defesa |
|---|---|---|
| Alguém na mesma rede (Wi-Fi de hotel, visita) | varre portas e acha o WS | não escutar na LAN aberta; TLS + token por aparelho |
| Token vazado | print de tela, log de proxy, histórico | token nunca em URL; só hash no PC; revogação imediata |
| Celular perdido/roubado | app aberto com sessão | token no Keychain/Keystore com `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; revogação pelo PC; somente leitura por padrão |
| Man-in-the-middle | Wi-Fi falso | TLS com CA pública (Tailscale) ou pin da chave (LAN) |
| Força bruta no pareamento | tentar códigos | código de uso único, 2 min, rate limit, aprovação no PC |
| Terceiro no caminho vendo a tela | túnel que termina TLS | preferir túnel ponta a ponta (WireGuard) |
| Comando perigoso enviado sem querer | colar várias linhas | somente leitura por padrão; confirmação de colagem no app |

## 3. Opções

### A. LAN com TLS + pareamento

`bethterm-web` abre um **segundo** listener só para o modo remoto, no IP da
LAN, com certificado autoassinado (ECDSA P-256 gerado no primeiro uso,
guardado em `%APPDATA%\bethterm\web\remote-cert.pem`). O QR leva o pin
SHA-256 da chave pública (SPKI).

- Prós: sem terceiros, funciona sem internet.
- Contras: só dentro de casa/escritório; **o WebSocket do React Native
  recusa certificado autoassinado** — exige um módulo nativo de pinning
  (OkHttp `CertificatePinner` no Android, delegate do `NSURLSession`/
  SocketRocket no iOS) e, portanto, um *dev build* (não roda no Expo Go);
  a porta fica visível para todo mundo na rede.

### B. Tailscale / WireGuard (recomendado)

O PC e o celular entram na mesma tailnet. O `bethterm-web` escuta **só no
IP da tailnet** (`100.x.y.z`), ou fica em loopback e o `tailscale serve`
publica `https://<pc>.<tailnet>.ts.net` só para a tailnet.

- Prós: criptografia ponta a ponta (WireGuard) — nenhum terceiro vê a tela;
  a porta não existe fora da tailnet; certificado de CA pública via
  `tailscale cert` (o app não precisa de pinning, roda no Expo Go);
  funciona de qualquer lugar; ACL da tailnet limita quais aparelhos
  alcançam a porta.
- Contras: depende da conta Tailscale (ou de um Headscale próprio); o app
  Tailscale precisa estar ligado no celular.
- **Nunca** usar `tailscale funnel` (publica na internet).

### C. Cloudflare Tunnel + Cloudflare Access

`cloudflared` publica `https://bethterm.<domínio>` com login do Access na
frente.

- Prós: nada de porta aberta; login com SSO/2FA.
- Contras: a Cloudflare termina o TLS e **vê a tela e o que é digitado em
  texto claro**; exige domínio; o WebSocket de um app nativo não passa pelo
  login do Access sem *service token* ou mTLS (mais segredos no celular);
  fica exposto à internet inteira — um erro de configuração no Access e o
  shell está público.

### Comparação

| | A. LAN+TLS | B. Tailscale | C. Cloudflare |
|---|---|---|---|
| Fora de casa | não | sim | sim |
| Terceiro vê o tráfego | não | não | **sim** |
| Exposto à internet | não | não | sim (atrás do Access) |
| Pinning no app | obrigatório (nativo) | desnecessário | opcional |
| Roda no Expo Go | não | sim | sim (com service token) |
| Esforço no PC | médio | baixo | médio |

## 4. Recomendação

**Padrão: B (Tailscale), com autenticação própria por aparelho em cima.**
A tailnet decide *quem alcança a porta*; o `bethterm-web` continua decidindo
*quem pode ver e digitar*. As duas camadas são obrigatórias — a tailnet
sozinha não basta (todo aparelho da tailnet alcançaria o shell).

A opção A fica como segunda fase (uso sem internet), já com o pin no QR.
A opção C só se houver um motivo forte, e nunca como padrão.

## 5. Desenho do modo remoto no bethterm-web

### 5.1 Listener separado, desligado por padrão

- O listener local de hoje (`127.0.0.1`, token por execução, WebView2)
  **não muda**.
- Um segundo listener, `--remote` / opção "Acesso pelo celular" na UI,
  com endereço **explícito** (IP da tailnet ou da LAN). O servidor
  **se recusa a subir** se o endereço for `0.0.0.0`/`::` ou um IP público,
  ou se não houver TLS.
- No modo `tailscale serve` o listener remoto fica em loopback, numa porta
  própria, e aceita só `Host` = `<pc>.<tailnet>.ts.net`.
- Só as rotas `/ws` e `/pair` existem no listener remoto (nada de
  `/api/settings`, arquivos estáticos ou temas).

### 5.2 Pareamento por QR

1. No PC, a pessoa clica **"Parear celular"** na UI local.
2. O servidor cria um **código de pareamento**: 128 bits aleatórios,
   uso único, validade de 2 minutos.
3. A UI mostra o QR:
   `bethterm://pair?v=2&url=wss://pc.tailnet.ts.net/ws&code=<código>&name=<PC>&pin=<spki-sha256>`
   (`pin` só na opção A).
4. O app abre `wss://…/pair`, manda `{code, device_name, platform}`.
5. **O PC pede confirmação**: "Novo aparelho: iPhone da Ana — permitir?"
   Sem o clique no PC, nada é liberado.
6. Aprovado, o servidor gera o **token do aparelho** (256 bits,
   base64url), devolve uma única vez e guarda **só o SHA-256** em
   `%APPDATA%\bethterm\web\devices.json`:
   `{id, name, platform, created, last_seen, last_ip, read_only: true, token_sha256}`.
7. O app guarda o token no Keychain/Keystore (`expo-secure-store`,
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) — já implementado.

O app de hoje lê o QR **v1** (`token=` direto no QR), útil só para o mock e
para testes em LAN. O v2 (`code=` + troca em `/pair`) é o formato proposto
para produção; o código do app para ele está na lista de pendências.

### 5.3 Autenticação nas conexões

- Token do aparelho **só no header** (`X-BethTerm-Token` ou
  `Authorization: Bearer`). O listener remoto **recusa `?t=`** e não usa
  cookie.
- Comparação em tempo constante do SHA-256; aparelho desconhecido ou
  revogado → 401 sem detalhes.
- `Origin` obrigatório e igual à origem pública configurada (o WebSocket do
  React Native manda `Origin` derivado da URL; o app também o define).
- `Host` só o nome/IP configurado.

### 5.4 Somente leitura por padrão — aplicado no servidor

- Todo aparelho novo nasce `read_only: true`. `send`/`paste` recusados pelo
  servidor, não só pelo app.
- Liberar escrita é uma ação **na UI do PC**, por aparelho. O celular não
  consegue se promover.
- O botão do app continua existindo (camada extra: o app não manda nada
  mesmo que o servidor permita).
- Opcional: escrita liberada expira (ex.: 8 h) e volta a somente leitura.

### 5.5 Revogação e controle

- UI local lista os aparelhos (nome, último acesso, IP, leitura/escrita)
  com **"Revogar"**: apaga o hash e derruba na hora as conexões vivas
  daquele aparelho.
- Aparelho sem uso por 30 dias é revogado sozinho.
- **"Encerrar acesso remoto agora"** (kill switch) fecha o listener remoto
  e todas as sessões.
- Aviso na bandeja do BethTerm quando um aparelho remoto conecta.

### 5.6 Limites (rate limiting)

- `/pair`: 5 tentativas/min por IP; após 20 falhas o pareamento desliga até
  a pessoa reabrir no PC.
- Falhas de token: atraso exponencial por IP (1 s → 60 s).
- Por conexão: até 200 mensagens/s, `send`/`paste` até 64 KiB/s,
  `watch` até 16 panes (já existe), 2 conexões simultâneas por aparelho.
- Payload de `send`/`paste` limitado a 4 MiB (já existe).

### 5.7 Log de auditoria

`%APPDATA%\bethterm\web-audit.log` (JSON por linha, com rotação), no mesmo
espírito do `host-life.log` (patch 0168):

- pareamento pedido / aprovado / recusado / expirado;
- conexão e desconexão (aparelho, IP, versão do TLS);
- cada `send`/`paste`: horário, aparelho, `pane_id`, número de bytes —
  **nunca o conteúdo** (pode ter senha);
- mudança leitura/escrita, revogação, kill switch;
- falhas de autenticação e bloqueios por limite.

### 5.8 O que nunca fazer

- Escutar em `0.0.0.0`/`::` ou IP público sem TLS **e** token por aparelho
  (o servidor deve se recusar a subir).
- Token em URL, query string, cookie do listener remoto ou log de acesso
  (redigir `?t=` e headers de autenticação em qualquer log).
- `tailscale funnel`, port-forward no roteador, UPnP.
- Liberar escrita a partir do celular.
- Guardar o token em claro (AsyncStorage, arquivo, `devices.json` sem
  hash).
- Reaproveitar o token por execução do listener local no modo remoto.
- Logar o texto de `send`/`paste` ou das telas.
- Parar, reiniciar ou sinalizar o `bethterm-host.exe` a partir do modo
  remoto: ele continua sendo só um cliente da ponte (patch 0171).

## 6. Impacto no app (já preparado)

- Transporte = URL: `ws://` (mock/LAN de teste) ou `wss://` (remoto). O app
  deriva o `Origin` da URL e manda o token no header.
- Aviso na tela quando a URL é `ws://` fora do loopback.
- Somente leitura ligado por padrão em toda conexão nova; o servidor em
  somente leitura também bloqueia o envio no app.
- Pendente no app: QR v2 (`code` + `/pair`), pinning nativo para a opção A
  (exige dev build), aviso de "escrita liberada" mais visível.

## 7. Ordem sugerida de implementação no PC

1. Listener remoto separado + recusa de endereço inseguro + TLS
   (`tailscale cert`) + `Host`/`Origin` configuráveis.
2. `devices.json` com hash, token no header, somente leitura no servidor.
3. `/pair` com código de uso único + aprovação na UI + QR.
4. Revogação, kill switch, aviso na bandeja.
5. Rate limiting e `web-audit.log`.
6. (Fase 2) Opção A: certificado autoassinado + pin no QR.

## 8. Como testar sem risco

- Desenvolvimento do app: `npm run mock` (servidor falso, nenhum terminal
  real).
- Contra o `bethterm-web` real **de hoje**, sem expor nada: celular Android
  no USB com `adb reverse tcp:<porta> tcp:<porta>` e URL
  `ws://127.0.0.1:<porta>/ws` — o celular fala com o loopback do PC, os
  checks de `Host`/`Origin` passam, e a conexão fica em **somente leitura**
  (só `list`/`watch`/`scroll`).
