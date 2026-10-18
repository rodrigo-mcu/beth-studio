# Publicação do app nativo (Android e iOS)

Guia para gerar os builds e distribuir internamente, sem custo para o usuário
final. Escrito em 2026-10-18.

> **Leia primeiro: o que não foi testado.** Este código foi escrito e validado
> numa máquina Windows, sem Mac, sem aparelho e sem emulador. O que rodou de
> verdade está em [O que foi validado](#o-que-foi-validado). Nenhum build
> Android ou iOS foi gerado e nada foi instalado num celular. Os passos de
> EAS, Intune, Apple Business Manager e TestFlight abaixo seguem a
> documentação dessas ferramentas **como eu a conheço**; as telas e os nomes de
> menu mudam, então confira cada passo na documentação oficial na hora.
> Confirmar também as regras e preços atuais da Apple e do Google.

## 1. O que você (Rodrigo) precisa trocar e fornecer

| Item | Onde | O que fazer |
| --- | --- | --- |
| Identificador iOS | `app.json` -> `expo.ios.bundleIdentifier` (hoje `com.exemplo.bethstudio`) | Trocar pelo identificador da sua empresa (ex. `br.com.suaempresa.bethstudio`). Tem de ser igual ao App ID registrado na Apple. |
| Identificador Android | `app.json` -> `expo.android.package` (hoje `com.exemplo.bethstudio`) | Trocar. **Depois de publicado, não muda mais.** |
| Nome e ícone | `app.json` -> `name`; adicionar `icon` (1024x1024 PNG), `android.adaptiveIcon` e splash | Não há imagens no repositório; sem elas o app usa o ícone padrão do Expo. |
| Conta Expo (EAS) | `npx eas-cli login` e `npx eas-cli init` | `init` grava `extra.eas.projectId` e `owner` no `app.json`. O plano gratuito do EAS tem fila e cota mensal de builds; confira. |
| Conta Apple | EAS pede o login Apple na primeira build iOS | Tem de ser a conta da organização que vai distribuir (veja o item de iOS abaixo). |
| `ascAppId` | `eas.json` -> `submit.ios-store.ios.ascAppId` | ID numérico do app no App Store Connect (só para TestFlight/App Store). |
| Chave de serviço do Google Play | `eas.json` -> `submit.android-aab`, arquivo `play-service-account.json` | Só se for publicar pelo Play (privado). **Nunca** commitar; já está no `.gitignore`. |
| Keystore Android | gerada e guardada pelo EAS | Faça **backup** (`npx eas-cli credentials`). Perder a chave impede atualizar o app instalado (fora do Play App Signing). |
| Certificados/perfis iOS | gerados pelo EAS (ou os seus) | Veja os pré-requisitos por opção. |
| Domínio e senha do celular | **não vão no build** | Cada pessoa digita na primeira abertura. O domínio é o do `bethstudio-proxy` (Configurações -> Celular no Studio). |

Os perfis de `eas.json` não têm segredos. O `.gitignore` bloqueia
`*.jks`, `*.p12`, `*.mobileprovision`, `credentials.json` e
`play-service-account.json`.

## 2. Preparar a máquina

Qualquer sistema serve para **iniciar** os builds, porque eles rodam na
nuvem do EAS (o iOS não precisa de Mac nesse caminho).

```powershell
cd bethstudio-mobile
npm install
npm run verify                  # typecheck + lint + jest (precisa estar verde)
npx expo-doctor                 # 21 verificações
npx eas-cli login
npx eas-cli init                # uma vez; grava o projectId no app.json
```

`appVersionSource` está como `remote` e os perfis de loja têm
`autoIncrement`: o EAS cuida do `buildNumber`/`versionCode`. A versão exibida
(`version` no `app.json`) acompanha a do Beth Studio; mude à mão.

## 3. Android

### 3.1 Gerar

```powershell
# APK: instala direto (sideload, Intune "aplicativo de linha de negócios", link)
npx eas-cli build --platform android --profile android-apk

# AAB: para Google Play (inclusive app privado / Managed Google Play)
npx eas-cli build --platform android --profile android-aab
```

Na primeira vez o EAS oferece **gerar a keystore** (aceite) e a guarda. Faça
`npx eas-cli credentials` -> Android -> baixar um backup.

### 3.2 Distribuir

Opções reais, da mais simples para a mais gerenciada:

1. **Link do EAS (distribuição interna).** O perfil `android-apk` tem
   `distribution: internal`; o fim do build mostra um link/QR. A pessoa abre no
   celular e instala (precisa permitir "instalar apps desconhecidos" para o
   navegador). Sem custo, sem MDM.
2. **Intune (ou outro MDM) com o APK.** Intune -> Apps -> Android -> Adicionar
   -> "Aplicativo de linha de negócios" -> enviar o `.apk`. Atribuir a grupos.
   Funciona em dispositivos gerenciados; o app tem de ter o mesmo `package` e
   ser assinado com a mesma chave a cada versão.
3. **Managed Google Play, aplicativo privado.** Exige conta de desenvolvedor do
   Google Play (taxa única, em geral US$25 - confira) e que a organização use
   Google Workspace/Android Enterprise. Enviar o **AAB**
   (`npx eas-cli submit --platform android --profile android-aab` com a chave de
   serviço, ou pelo console, faixa interna), publicar como app privado e aprovar
   no Managed Google Play. Os aparelhos recebem pela "loja corporativa" e
   atualizam sozinhos. **É a opção que mais se parece com loja corporativa.**
   Não há cobrança por usuário.

Permissões declaradas (`npx expo prebuild --platform android` foi executado e
o manifesto conferido): `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MICROPHONE`, `MODIFY_AUDIO_SETTINGS`, `POST_NOTIFICATIONS`
(notificação do serviço de gravação), `INTERNET`, `VIBRATE`. Foram bloqueadas
`SYSTEM_ALERT_WINDOW` e `READ/WRITE_EXTERNAL_STORAGE`. Em release o Android
não aceita HTTP em texto puro por padrão (`usesCleartextTraffic` só nas builds
de desenvolvimento).

## 4. iOS

### 4.1 Qual programa da Apple você tem?

O texto abaixo separa o que depende do **tipo** de conta. "Já tenho conta
Apple Developer" costuma ser o **Apple Developer Program** padrão (individual
ou organização). O **Apple Developer Enterprise Program** é outro programa,
com aprovação própria; se não aprovou, é a padrão.

| Opção | Conta | Pré-requisitos | Limites / observações |
| --- | --- | --- | --- |
| **A. TestFlight** | Developer Program padrão | App registrado no App Store Connect (`bundleIdentifier`); build `ios-store`; `ascAppId` | Testadores internos (membros da equipe do App Store Connect, até 100) recebem o build sem revisão da Apple; externos exigem revisão de beta. Cada build expira em 90 dias. Os usuários instalam o app **TestFlight**. Boa para começar. |
| **B. Ad hoc (EAS "internal")** | Developer Program padrão | Registrar o UDID de cada aparelho (`npx eas-cli device:create`); perfil `ios-internal` | Até 100 aparelhos por tipo de dispositivo por ano de assinatura. O perfil vence em 1 ano. Instala por link/QR do EAS ou por MDM. Cada aparelho novo exige regenerar o perfil. |
| **C. App Personalizado (Custom App) no Apple Business Manager** | Developer Program padrão + organização no Apple Business Manager | Organização registrada no ABM (com D-U-N-S); o app enviado ao App Store Connect com distribuição "App personalizado" para o ID da organização; passa pela **revisão da App Review**; MDM integrado ao ABM | É a "loja corporativa" legítima para a conta padrão. Sem limite de aparelhos e sem expirar como TestFlight. Pelo MDM (Intune) entra como app comprado/atribuído. Depende da aprovação da Apple. |
| **D. Enterprise (in-house)** | **Apple Developer Enterprise Program** (conta separada, aprovação da Apple; a Apple pede, entre outros, organização com porte e D-U-N-S) | Certificado de distribuição Enterprise; perfil "in-house"; perfil `ios-enterprise` (`enterpriseProvisioning: universal`) | Sem limite de UDID e sem App Review. A Apple restringe o uso a **funcionários da própria empresa**; uso fora disso põe a conta em risco. Instala por link `itms-services` (HTTPS) ou MDM. Certificados vencem e exigem renovação. |

**Recomendação**: comece com **A (TestFlight)** para validar no aparelho. Para
uso permanente na empresa com a conta que você tem, **C (App Personalizado)**
via Intune; use **B** como ponte. **D** só se a empresa tiver (ou obtiver) o
programa Enterprise.

### 4.2 Gerar

```powershell
# TestFlight / App Personalizado (distribution: store)
npx eas-cli build --platform ios --profile ios-store
npx eas-cli submit --platform ios --profile ios-store   # envia ao App Store Connect

# Ad hoc: registrar aparelhos primeiro
npx eas-cli device:create
npx eas-cli build --platform ios --profile ios-internal

# Enterprise
npx eas-cli build --platform ios --profile ios-enterprise
```

O EAS pede o login Apple e cria certificado e perfil de provisionamento. Se a
conta tem 2FA, vai pedir o código. As credenciais ficam no EAS; para exportar,
`npx eas-cli credentials`.

Confirme o campo `ios.enterpriseProvisioning` de `eas.json` com
`npx eas-cli build:configure` ou na documentação do EAS Build: foi escrito de
memória, a build deve avisar se não existir.

### 4.3 Distribuir pela loja corporativa / MDM (Intune)

- **A.** Convidar os testadores no App Store Connect (TestFlight); eles
  instalam pelo app TestFlight.
- **B / D.** Pelo link do EAS, ou no Intune: Apps -> iOS/iPadOS -> Adicionar ->
  "Aplicativo de linha de negócios" -> enviar o `.ipa` (precisa ser assinado
  com o perfil que cobre o aparelho/organização). Atribuir a grupos.
- **C.** No App Store Connect: pagamentos/preço "gratuito", distribuição
  "App personalizado", informar o ID da organização no ABM. No ABM, aceitar o
  app em "Apps e Livros" e atribuir licenças ao MDM; no Intune, sincronizar o
  token do ABM e atribuir o app.

## 5. Primeira abertura no aparelho (para o usuário)

1. Abrir o app. Digitar o **endereço do servidor** (ex.
   `beth.suaempresa.com.br`) e a **senha do celular**. O app testa o login
   antes de guardar.
2. Tocar no microfone da barra de cima. O sistema pergunta o microfone **uma
   vez**. O app mostra o aviso de privacidade do PC (a mesma confirmação do web
   app) na primeira gravação.
3. Falar, tocar no quadrado. O texto entra no campo "Mensagem para o terminal"
   do terminal aberto; confira e toque em Enviar (no web app).
4. Sem rede/PC desligado: o áudio fica na lista (botão de lista com contador)
   e é reenviado sozinho. Falhou 6 vezes: **Tentar de novo / Baixar /
   Descartar**.

## 6. Checklist para testar no aparelho (nada disso foi feito ainda)

Faça num Android e num iPhone, build `android-apk` / TestFlight:

- [ ] Primeira abertura: domínio inválido (`http://`, IP) é recusado; senha
  errada mostra erro; senha certa abre o web app já logado.
- [ ] Microfone: o sistema pergunta uma vez; fechar e abrir o app **não**
  pergunta de novo. Botão de microfone do **web app** não pergunta de novo no
  iOS (`mediaCapturePermissionGrantType="grant"`).
- [ ] Gravar 10 s, parar: texto chega ao campo; a lista fica vazia.
- [ ] Gravar 5 min (duas trocas de trecho): conferir se o texto vem completo e
  **se há falha de áudio na troca de trecho** (risco conhecido).
- [ ] Gravar 30 s e **matar o app** (deslizar para fechar): ao reabrir, o
  trecho aparece na lista e é enviado.
- [ ] Gravar e travar a tela: a gravação continua (iOS: modo de áudio em
  segundo plano; Android: serviço em primeiro plano com notificação). **Risco**:
  não validado; a Apple pode questionar `UIBackgroundModes: audio` numa
  revisão pública (para TestFlight/App Personalizado, justifique como ditado).
- [ ] Desligar o Wi-Fi/dados, gravar, ligar de novo: reenvio imediato
  (`expedite`), contagem regressiva "tentando de novo em N s" na lista.
- [ ] PC desligado/proxy fora: página mostra "Sem conexão com o servidor" e
  recarrega sozinha quando volta.
- [ ] Bloquear 2 min e voltar: terminal reconecta rápido (vigia do web app
  acordado por `online`/`visibilitychange`).
- [ ] Forçar falha (parar o `bethstudio-web` do PC de teste, **nunca o do
  usuário em uso**): 6 tentativas, depois os três botões; **Baixar** abre a
  folha de compartilhamento com o `.m4a`.
- [ ] Texto pronto sem terminal aberto: aviso "Abra um terminal", texto na
  lista; **Colocar no campo** funciona depois.
- [ ] Servidor recusando o formato: se `/api/voice/transcribe` responder 415
  para `audio/mp4`, o `allowedAudio` do Go (`voice.go`) já lista `audio/mp4`; se
  o provedor de voz rejeitar `.m4a` de 16 kHz mono, trocar `sampleRate` em
  `src/voice/service.ts`.
- [ ] Android: o login por cookie. O app lê o `Set-Cookie` do `fetch` do React
  Native e manda o `Cookie` explicitamente. **Se o `Set-Cookie` não vier na
  resposta em algum aparelho/OS**, o envio acusa "O servidor não devolveu a
  sessão"; a alternativa é fazer o envio pelo WebView (ponte `postMessage`).

## 7. O que foi validado

Rodado em Windows, no diretório `bethstudio-mobile/`:

- `npm run verify`: `tsc --noEmit` limpo, `eslint --max-warnings 0` limpo,
  jest com 9 suítes / 77 testes verdes (lógica pura).
- `npx expo-doctor`: 21 de 21 verificações.
- `npx expo config --type public`: lê o `app.json` e os plugins.
- `npx expo export --platform android --platform ios`: o bundle JS (Hermes) de
  Android e iOS gera sem erro.
- `npx expo prebuild --platform android` (e conferência do
  `AndroidManifest.xml`): permissões e `AudioRecordingService`
  (`foregroundServiceType="microphone"`). O diretório `android/` gerado foi
  apagado (está no `.gitignore`).

**Não validado**: compilação nativa Android (Gradle) e iOS (Xcode; o prebuild
iOS não roda no Windows), execução em emulador ou aparelho, gravação real,
troca de trechos, gravação em segundo plano, upload do arquivo
(`File.upload` do `expo-file-system`), leitura do `Set-Cookie` no React Native,
o `mediaCapturePermissionGrantType` no iOS, o Intune/ABM/TestFlight, a
`enterpriseProvisioning` do EAS. Todos estão no checklist acima.

## 8. Notificações (fase 2)

Não incluídas: o celular bloqueado só recebe aviso por push (APNs/FCM) e isso
exige uma rota nova no `bethstudio-web` para guardar o token e enviar o push
quando um agente termina ou pede permissão. Desenho em
[`ARQUITETURA.md`](ARQUITETURA.md#fase-2-notificações-com-o-celular-bloqueado).
