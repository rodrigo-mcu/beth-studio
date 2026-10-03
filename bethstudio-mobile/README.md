# bethstudio-mobile

App Android/iOS (Expo + TypeScript) para ver — e, se liberado, usar — os
terminais do Beth Studio pelo mesmo protocolo WebSocket do `bethstudio-web`
(ponte `bethstudio cli bridge`, patch 0171).

**Esqueleto.** O acesso remoto ainda não existe no PC: veja
[`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md).

## Telas

- **Conexões** — servidores salvos (nome, endereço, token no cofre do
  aparelho), adicionar por QR code ou manualmente, "Somente leitura" por
  conexão (ligado por padrão).
- **Terminais** — Janela → Aba → terminal, puxar para atualizar.
- **Terminal** — xterm.js num WebView (arquivos locais, sem CDN), fonte
  ajustada ao grid do host (o pane do host nunca é redimensionado),
  arrastar rola o histórico, "Voltar ao fim", barra com Esc, Tab, Ctrl,
  setas, Ctrl+C, colar e teclado.

## Rodar

```powershell
npm install                 # gera src/terminal/xtermAssets.generated.ts
npm run mock                # servidor falso em ws://127.0.0.1:8787/ws (imprime o token)
npx expo start              # abrir no Expo Go (Android/iOS)
```

Com o celular na mesma rede, suba o mock fora do loopback (dados falsos):
`node tools/mock-server/index.js --host 0.0.0.0` e use
`ws://<IP-do-PC>:8787/ws` no app.

Contra o `bethstudio-web` real (somente leitura!), sem expor nada na rede:
Android no USB, `adb reverse tcp:<porta> tcp:<porta>` e
`ws://127.0.0.1:<porta>/ws` com o token da URL do bethstudio-web.

## Verificar

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (eslint-config-expo)
npm test            # jest: protocolo, somente leitura, rolagem, página do xterm, mock server
```

## Estrutura

```
app/                       rotas (expo-router)
  index.tsx                Conexões
  connection.tsx           adicionar/editar (também recebe o QR)
  scan.tsx                 leitura do QR
  c/[connId]/index.tsx     Terminais
  c/[connId]/[paneId].tsx  Terminal
src/protocol/              cliente WS, parse/validação, URL, QR, teclas, agrupamento
src/storage/connections.ts conexões (AsyncStorage) + token (SecureStore)
src/state/                 um cliente por conexão, ciclo de vida com o app
src/terminal/              WebView + xterm, barra de teclas, rolagem
src/ui/                    paleta escura e componentes
tools/mock-server/         servidor falso do protocolo (dev e testes)
tools/build-xterm-assets.js embute o xterm.js no bundle
docs/REMOTE_ACCESS.md      proposta de modo remoto no bethstudio-web
```
