# Beth Studio completo pelo navegador (acesso remoto)

Data: 2026-09-30. Pedido: abrir o Studio inteiro no notebook, longe do PC,
para acompanhar agentes rodando. Sem parar o `bethterm-host.exe`.

## Caminho

Notebook → HTTPS → proxy HTTPS do servidor → `bethstudio-proxy`
(127.0.0.1) → túnel que o PC abre (o mesmo do celular, `phonelink`) →
`bethterm-web.exe`.

O Studio fica em `https://<domínio>/studio/`. O app do celular continua em
`/`. O front do Studio já é `base: "./"`; em `/studio/` os assets ficam em
`/studio/assets/` e a API em `/studio/api/...`, `/studio/ws`. O cookie do
Studio remoto tem `Path=/studio`, então nunca vai nos pedidos do celular, e
o cookie do celular nunca abre o Studio.

## Entrada

- Desligado por padrão. Liga em Configurações → Celular → "Studio completo
  pelo navegador". Liga só com o segundo fator configurado.
- Login: senha do celular + código TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s,
  ±1 passo; um código não vale duas vezes). Página de login sem JavaScript
  (formulário POST).
- Sessão: token aleatório de 32 bytes; no disco só o SHA-256
  (`remote-sessions.json`). Fecha após 12 h sem uso e após 7 dias.
- Trocar a senha, trocar o segundo fator ou desligar o acesso encerra todas
  as sessões remotas.
- Tentativas: por IP, 5 erros → espera que dobra (1 min até 15 min); geral,
  30 erros em 10 min → recusa todos até a janela passar (o Studio no PC não
  é afetado). O mesmo limitador vale para o login do celular.
- IP real: o `bethstudio-proxy` só aceita `X-Real-IP` / `X-Forwarded-For`
  quando quem conecta é local (o proxy HTTPS da máquina) e repassa em
  `X-BethStudio-Client`.
- `remote-access.log` no `%APPDATA%\bethterm`: login, erro de senha/código,
  bloqueio, saída, sessão encerrada.

## O que só existe no PC

Nunca pelo túnel: `/api/phone/setup`, `/api/remote/*` (liga/desliga, segundo
fator, sessões), e o que abre algo na tela do PC: escolher pasta, Abrir,
Salvar como, Mostrar no Explorer, abrir com o programa padrão, abrir link no
navegador do PC, janelas nativas de Banco e SFTP, salvar histórico/print por
diálogo, abrir chaves/preços de voz. O servidor responde 403
"Disponível só no PC"; a interface esconde ou troca:

- links abrem no navegador do notebook (`window.open`);
- Banco e SFTP abrem em outra aba (`/studio/?mode=db`, `?mode=sftp&host=`);
- "Salvar como" do arquivo vira download.

## Tamanho dos terminais

O Studio remoto não muda o tamanho dos terminais no host (o `resize` é
recusado no servidor para conexões remotas, e a interface fica no modo
"tamanho do host", com escala para caber). A janela nativa e o Studio no PC
não mudam quando o notebook abre.

## Checagens do pedido remoto

`Host` igual ao domínio (o proxy já confere), `Origin` igual a
`https://<domínio>` em POST e WebSocket, CSP `connect-src 'self'`,
`X-Frame-Options: DENY`, cookie `HttpOnly; Secure; SameSite=Strict`.

`Referrer-Policy: same-origin` (no celular também). Com `no-referrer`, o
navegador manda `Origin: null` nos POSTs da própria página (formulário e
`fetch`), e a checagem de origem recusaria o login e o envio de imagem e
voz do celular.

No nginx do servidor: `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;` (o `bethstudio-proxy` usa o último endereço
dessa lista). Sem isso, todos os pedidos parecem vir do mesmo IP e o limite
por IP vira limite geral.

## No PC

Configurações → Celular mostra: liga/desliga, QR e chave do segundo fator,
sessões abertas (IP, navegador, último uso) com Encerrar e Encerrar todas.
Enquanto houver Studio remoto conectado, um selo no canto do Studio no PC
avisa ("Studio remoto conectado"); clicar abre essa tela.

## Fora desta etapa

Editar o layout ao mesmo tempo nos dois Studios (a última gravação vence).

Feito depois (2026-09-30): navegador de pastas dentro da página
(`FolderBrowser.tsx`) no lugar de "Procurar…" e de "Abrir arquivo" no
Studio remoto.
