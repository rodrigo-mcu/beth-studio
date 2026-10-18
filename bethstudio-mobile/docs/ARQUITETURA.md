# Arquitetura do app nativo do celular

Decisão registrada em 2026-10-18.

## Decisão: casca fina

O app nativo **não reimplementa** o celular. Ele abre o web app do celular
(`bethstudio-web/frontend/src/phone/`, servido pelo domínio do servidor da
pessoa) dentro de um `WebView` e acrescenta, em volta, só o que o navegador
não resolve:

| Problema no navegador/PWA | O que o app nativo faz |
| --- | --- |
| iOS pergunta o microfone toda hora | Permissão nativa (`expo-audio`), pedida uma vez; o WebView recebe `mediaCapturePermissionGrantType="grant"` |
| Gravação longa se perde se o app é suspenso ou o envio falha | Gravação direto em arquivo, em trechos fechados, fila persistente com nova tentativa |
| Conexão cai em segundo plano | Ao voltar ao app e quando a rede volta: fila reenviada na hora, página recarregada se falhou, vigia do web app acordado |
| Notificações | Fase 2 (veja abaixo) |

### Por que não o esqueleto anterior

O esqueleto que existia (cliente WebSocket próprio do protocolo + xterm.js em
WebView local, telas de conexões/QR/terminais) foi **removido**. Motivos:

1. Duplicava o protocolo e toda a interface que já existem e já são
   mantidos no web app (lista de agentes, terminal com rolagem, teclas rápidas,
   anexos de imagem, temas, rascunhos). Cada mudança do celular exigiria duas
   implementações.
2. Falava o protocolo do **Studio no PC** (token por URL, `bethstudio cli
   bridge`), não o caminho que roda de verdade: domínio público +
   `bethstudio-proxy` + login por senha + cookie. Para usá-lo seria preciso
   reabrir o PC na rede (a proposta antiga do `REMOTE_ACCESS.md`, que não é o
   que roda).
3. Menos código para manter: a casca tem menos de 2.000 linhas (contando
   telas e estilos), com a lógica pura coberta por cerca de 870 linhas de
   teste.

O esqueleto continua no histórico do repositório (último commit com ele:
`349c55a`). `docs/REMOTE_ACCESS.md` foi mantido só como registro da proposta
antiga.

## Peças

```
app/index.tsx           decide: Setup (sem domínio/senha) ou Shell
src/ui/Setup.tsx        domínio + senha; testa o login antes de guardar
src/ui/Shell.tsx        WebView + barra nativa (microfone, lista, aviso)
src/ui/TakesPanel.tsx   lista de áudios/textos: Tentar de novo / Baixar / Descartar
src/storage/secrets.ts  domínio e senha no cofre (expo-secure-store)
src/config/domain.ts    valida o domínio (só HTTPS)
src/voice/              gravação, fila e envio (veja abaixo)
src/web/inject.ts       scripts injetados no web app + navegação permitida
```

### Fluxo de voz

```
mic (Shell) -> VoiceService.startRecording
   permissão (1x) -> SegmentedRecorder (expo-audio, .m4a mono 16 kHz AAC 32 kbps)
   cada trecho de 2 min: caminho gravado na fila ANTES de gravar; ao fechar, vira áudio completo
parar -> arquivo oco/silêncio é descartado -> Take "pending" na fila (AsyncStorage)
pump -> processTake: para cada trecho, POST /api/voice/transcribe (arquivo do disco)
   falha repetível -> espera 2, 4, 8, 15, 30 s (6 tentativas) -> "failed"
   falha de senha / 4xx -> "failed" na hora
   tudo transcrito -> "ready" com o texto
ready -> deliverTextScript no WebView -> campo "Mensagem para o terminal"
   ack ok -> apaga a fila e os arquivos; ack falso -> fica na lista (Colocar no campo / Copiar)
```

Regras que valem sempre:

- O áudio só é apagado depois que o texto entrou no campo, ou por
  **Descartar**.
- Se o app morrer gravando ou enviando, ao abrir a fila é recarregada
  (`recoverInterrupted`) e o envio recomeça, trecho a trecho (trecho já
  transcrito não é reenviado).
- A política de nova tentativa é a de `bethstudio-web/frontend/src/phone/retry.ts`.

### Por que gravar em trechos de 2 minutos

Um `.m4a` só é um arquivo válido quando o gravador o fecha. Se o app for morto
no meio de uma gravação única, ela se perde por inteiro. Com trechos, só o
trecho em andamento (no máximo 2 min) pode ficar inválido; os anteriores já
estão fechados no disco. O próximo gravador é preparado antes de fechar o
atual, para a troca ser curta. **Isso não foi medido em aparelho**: pode haver
uma pequena falha de áudio (centenas de ms) na troca. Se atrapalhar, aumente
`SEGMENT_MS` em `src/voice/service.ts` (trade-off: perde mais se o app morrer).

### Rede e login

- Login: `POST /api/phone/login` com `Origin: https://<domínio>` (o Go exige
  Origin). O cookie `bethstudio_phone` vem no `Set-Cookie`, é lido pelo app e
  mandado explicitamente no cabeçalho `Cookie` (`credentials: "omit"`), sem
  depender do jar do sistema.
- No WebView, o login é refeito **dentro da página** (script injetado depois do
  carregamento, só se a URL for do domínio configurado e `/api/phone/me` der
  401), porque o cookie HttpOnly precisa nascer no WebView.
- Transcrição: `POST /api/voice/transcribe`, corpo = arquivo, `Content-Type:
  audio/mp4`, `X-Audio-Ms`. 401 -> entra de novo uma vez.
- O servidor limita 25 MB por envio (~10 min no formato antigo); a 32 kbps o
  limite é de mais de uma hora por trecho, muito acima dos 2 min.

### Segurança

- Senha e domínio só no `expo-secure-store`
  (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: lido depois do primeiro desbloqueio,
  para reenviar áudio com a tela bloqueada; não migra para outro aparelho).
  Nenhum log escreve senha.
- Só HTTPS: `normalizeDomain` recusa `http://`, IP e esquemas; o WebView só
  navega dentro do domínio (`isAllowedNavigation`); links externos abrem no
  navegador do sistema.
- O web app **não ganhou ponte** para o nativo: a única mensagem aceita de
  volta é o `ack` de entrega de texto, com formato fixo (`parseAck`). Não há
  `window.Beth...` exposto à página.
- O script de login leva a senha como literal JS escapado (testado com aspas,
  barra invertida, `</script>` e U+2028).

## O que o web app NÃO faz no app nativo (diferenças)

- A **correção por IA** do texto (`/api/voice/correct`, streaming) não é
  chamada: o texto entra como veio da transcrição. O prefixo de voz
  (`prefix_text`) também só é aplicado pelo web quando o texto é marcado como
  ditado; o texto injetado conta como digitado. Para igualar, a solução limpa é
  um gancho pequeno no `Composer.tsx` (evento `beth-native-text` que chama
  `setDraft({ voice: true })`), em vez do campo ser preenchido por injeção.
- A gravação do botão de microfone **do próprio web app** continua existindo
  (com `getUserMedia`); com `mediaCapturePermissionGrantType="grant"` o iOS não
  pergunta de novo, mas a gravação do web continua sendo a de navegador. O
  caminho seguro é o botão da barra nativa.
- A barra nativa ocupa ~44 pt no topo.

## Fase 2: notificações com o celular bloqueado

Não entrou, por exigir backend novo. Desenho possível, sem servidor próprio:

1. O app pede permissão de notificação e obtém um token de push (Expo Push
   Service/APNs/FCM; exige `expo-notifications`, credenciais APNs e
   `google-services.json`).
2. O token é enviado ao PC por uma rota nova em `phone_gate.go`
   (`POST /api/phone/push`), guardada em `settings`.
3. O Go, quando um agente termina ou pede permissão (os mesmos eventos que o
   Studio já detecta para o alerta de aba), chama a API de push de saída (o PC
   já tem internet).

Sem isso, o que existe hoje é o que o web app já faz com a página aberta.
Notificações locais (app vivo) não resolvem o caso do celular bloqueado e por
isso não foram feitas.

## Testes

`npm run verify` = `tsc --noEmit` + `eslint --max-warnings 0` + `jest`. Os
testes cobrem a lógica pura: domínio, política de nova tentativa, fila
(estados, atrasos, recuperação), envio por trechos, escolha do arquivo gravado,
gravação em trechos (gravador falso), cliente HTTP (login, cookie, 401,
tradução de erros), texto dos cartões e scripts injetados (executados num
navegador falso). **Nada disso substitui testar num aparelho** (veja
`PUBLICACAO.md`).
