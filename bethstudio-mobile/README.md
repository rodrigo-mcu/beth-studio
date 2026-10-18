# bethstudio-mobile

App Android/iOS (Expo + TypeScript) do celular do Beth Studio. É uma **casca
fina**: abre o web app do celular (`bethstudio-web/frontend/src/phone/`) do
seu próprio domínio dentro de um WebView e acrescenta o que o navegador não
resolve:

- microfone com permissão pedida **uma vez**;
- gravação **direto em arquivo** no aparelho (em trechos fechados), com fila
  persistente de envio e nova tentativa (2, 4, 8, 15, 30 s; 6 tentativas) e
  os botões **Tentar de novo / Baixar / Descartar**;
- reconexão rápida ao voltar para o app e quando a rede volta;
- domínio e senha do celular guardados no cofre do aparelho.

Notificações com o celular bloqueado ficaram para a fase 2 (precisam de um
envio de push no PC). Por que casca fina e o desenho completo:
[`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). Como gerar os builds e publicar
na loja corporativa: [`docs/PUBLICACAO.md`](docs/PUBLICACAO.md).

> Estado: a lógica tem testes e o bundle gera para os dois sistemas, mas o app
> **ainda não foi compilado nem rodado num aparelho**. Veja o checklist em
> `docs/PUBLICACAO.md`.
>
> `docs/REMOTE_ACCESS.md` é uma proposta antiga (Tailscale) e **não** é o que
> roda.

## Como funciona

1. Primeira abertura: pede o endereço do servidor (o domínio do
   `bethstudio-proxy`) e a senha do celular, testa o login e guarda tudo no
   `expo-secure-store`. Só HTTPS.
2. Depois abre `https://<domínio>/` no WebView e entra sozinho.
3. Barra nativa no topo: botão de microfone (grava/para), lista de áudios e
   textos (com contador) e o aviso passageiro.
4. O texto transcrito é colocado no campo "Mensagem para o terminal" do web
   app; o envio ao terminal continua sendo o **Enviar** de lá.

## Rodar

O app usa módulos nativos (`expo-audio`, `expo-secure-store`,
`react-native-webview`). Para testar de verdade (permissões do `app.json`,
gravação em segundo plano) use uma build de desenvolvimento
(`npx expo run:android` com o Android SDK, ou uma build do EAS), não o Expo Go;
no Expo Go, nada disso foi tentado.

```powershell
npm install
npm run verify              # typecheck + lint + jest
npx expo start              # com uma development build instalada
```

## Verificar

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (eslint-config-expo), sem avisos
npm test            # jest: lógica pura
npx expo-doctor
```

## Estrutura

```
app/index.tsx            Setup (primeira vez) ou Shell
src/ui/                  Setup, Shell (WebView + barra), TakesPanel, tema
src/storage/secrets.ts   domínio e senha no cofre
src/config/domain.ts     validação do domínio (só HTTPS)
src/voice/
  retry.ts               política 2/4/8/15/30 s, 6 tentativas, ApiError
  queue.ts               estados da fila, recuperação, persistência (puro)
  sender.ts              envia uma gravação trecho a trecho (puro)
  segmented.ts           gravação em trechos de 2 min (gravador injetado)
  recordedFile.ts        escolha do arquivo gravado, silêncio, medidor
  api.ts                 login por cookie, /api/voice/*, 401 -> entra de novo
  http.ts                fetch e File.upload de verdade
  describe.ts            texto e botões de cada cartão da lista
  service.ts             liga tudo ao aparelho (permissão, disco, timers)
src/web/inject.ts        scripts injetados no web app, navegação permitida
eas.json                 perfis de build (APK, AAB, iOS interno, enterprise, loja)
docs/                    ARQUITETURA, PUBLICACAO, REMOTE_ACCESS (antigo)
```
