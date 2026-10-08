# Atualização por camadas (interface / Studio / host)

Data: 2026-10-08. Estado: **plano, nada implementado**.

## Problema

A interface do Beth Studio (React) fica embutida em `bethstudio-web.exe`
(`//go:embed all:dist`, `bethstudio-web/webui/embed.go`). Qualquer correção de
tela exige trocar o exe do Studio, e o único caminho de instalação que existe
(`pack-bethterm-setup.ps1` / `install-bethterm-release.ps1`) é um instalador
completo que mexe no `bethstudio-host.exe`. O host guarda os PTYs do usuário;
pará-lo perde terminais (ver "Live Terminals Rule" no `AGENTS.md`). A maior
parte das mudanças é só de frontend, então o custo de atualizar é
desproporcional.

## Objetivo

1. Atualizar **só a interface** com o host rodando, sem reiniciar nada.
2. Atualizar o **Studio** (Go) reiniciando apenas o Studio, nunca o host.
3. Atualização de **host/GUI**: apenas **avisar**; o usuário escolhe quando.
4. Usar o git como trilha de publicação (histórico, tag, reversão).

## Três camadas, três regras

| Camada | O que é | Como atualiza | Reinicia o quê |
|---|---|---|---|
| **UI** | `frontend/dist` (HTML/JS/CSS) | Pasta de override lida pelo Studio | Nada. A página recarrega (F5 / botão) |
| **Studio** | `bethstudio-web.exe`, `bethterm-tool.exe` | Troca do exe + relançar | Só o Studio (e a ponte `cli bridge`) |
| **Host/GUI** | `bethstudio-host.exe`, `bethstudio-gui.exe`, `bethstudio.exe` | Instalador atual | Tudo. **Só com ordem do usuário** |

Regra dura: nenhum caminho automático encosta em `bethstudio-host.exe` /
`bethstudio-gui.exe` (patches 0167/0168 e o `AGENTS.md`).

## Camada UI: pasta de override

O Studio passa a servir os arquivos da UI de duas fontes, nesta ordem:

1. `%APPDATA%\bethterm\ui\current\` (se existir e for válida);
2. o `dist` embutido (fallback, sempre presente).

Efeitos:

- Atualizar a UI = gravar arquivos novos numa pasta e recarregar a página. O
  processo do Studio, a ponte e o host continuam como estão. Os terminais
  abertos no Studio reconectam sozinhos no reload.
- A pasta é trocada de forma atômica: baixa/extrai em `ui\staging-<versão>\`,
  valida (hashes do manifesto), renomeia `current` → `previous` e
  `staging-<versão>` → `current`. **Reverter** = voltar `previous`.
- Se `current` estiver corrompida ou o `index.html` não carregar, o Studio
  cai no embutido. A UI nunca fica "quebrada sem saída".
- O mesmo vale para a página do celular (`dist/phone`) quando for servida
  pelo Studio local; o proxy Linux continua com o próprio deploy
  (`bethstudio-proxy-deploy`).

### Compatibilidade UI ↔ Studio

A UI nova só roda se a API do Studio entende o que ela chama. Cada pacote de
UI declara no manifesto `requires_api` (inteiro) e o Studio expõe `api_level`
em `/api/version`. Se `requires_api` > `api_level`, a UI **não** é aplicada e o
aviso passa a ser "precisa atualizar o Studio" (camada 2). O embutido sempre
bate com o seu próprio exe.

## Manifesto de publicação

`manifest.json` na raiz de cada release:

```json
{
  "release": "2026.10.08-1",
  "ui":     { "version": "2026.10.08-1", "requires_api": 12, "files": { "index.html": "sha256…" } },
  "studio": { "version": "2026.10.05-3", "api_level": 12, "sha256": "…" },
  "host":   { "version": "0197", "changed_since": "0195", "notes": "…" }
}
```

O Studio compara cada bloco com o que está rodando. O bloco `host` só diz se
o host publicado é mais novo que o instalado; **nunca** dispara nada.

## Git como canal

Duas peças, ambas só git:

- **Publicação (máquina de desenvolvimento).** `deploy-ui.ps1`: roda
  `build.ps1`, copia `frontend/dist` + `manifest.json` para uma worktree do
  branch órfão `release` e faz commit + tag `ui-<release>` (e `studio-…` /
  `host-…` quando esses mudarem). O histórico do branch `release` é o
  histórico de deploys; reverter = apontar a tag anterior.
- **Consumo (Studio).** Botão "Verificar atualizações" em Configurações
  (e uma checagem leve ao abrir): lê `manifest.json` do branch `release`
  (`git ls-remote` + download do arquivo da tag, ou `git archive`/zip da tag
  quando não houver `git` instalado). Sem polling em segundo plano.

Decisão pendente: onde mora o remoto do branch `release` (ver "Perguntas").

## Avisos e controle do usuário (mouse primeiro)

No Studio, um indicador discreto na barra, sem diálogo bloqueante:

- **Interface nova** → "Aplicar agora" (recarrega a página) / "Depois".
  Sem confirmação extra: não perde nada (terminais continuam no host). O texto
  de uma transcrição em andamento é preservado antes do reload; se houver
  painel de voz aberto, o botão fica desabilitado com a razão.
- **Studio novo** → "Reiniciar o Studio para atualizar". Avisa que os
  terminais **continuam rodando** no host.
- **Host novo** → "Há atualização do host/terminal nativo. Atualizar reinicia
  seus terminais." com **Ver o que mudou** e **Escolher quando**, sem aplicar
  nada. O usuário roda o instalador quando quiser.

## Troca do exe do Studio sem tocar no host

O Windows permite **renomear** um exe em execução. Sequência do atualizador
(`bethstudio-web.exe --apply-update`, ou um helper pequeno):

1. baixa `bethstudio-web.exe` novo para `bethstudio-web.exe.new` e confere o sha256;
2. renomeia o exe atual para `.old` e o `.new` para o nome final;
3. relança o Studio e sai; o novo processo faz a ponte `cli bridge` de novo
   contra o **mesmo** `host.sock`.

Antes de implementar, confirmar com teste isolado (`APPDATA` temporário, host
próprio de teste) que sair do Studio não encerra o host. Hoje o
`bethstudio-host.exe` aparece como filho do processo do Studio, e o código não
usa job object, mas isso precisa ser **provado**, não presumido.

## Pontos abertos

- **Nomes instalados.** O que está em `C:\Users\Public\BethStudio\` se chama
  `bethstudio-*.exe`, e os scripts do repositório ainda geram `bethterm-*`.
  Preciso saber qual comando gera esse layout antes de mexer em
  empacotamento, para o atualizador mirar os nomes certos.
- **Primeira vez (bootstrap).** O Studio instalado hoje não tem a pasta de
  override. Uma única troca do exe do Studio (camada 2) é necessária;
  depois disso a UI passa a atualizar a quente.
- **Segurança.** Sem assinatura, quem controla o remoto controla o código que
  roda. Mínimo: sha256 no manifesto + tag assinada (`git tag -s`) verificada
  quando houver chave; só `https`/`ssh`. O Studio só escreve em
  `%APPDATA%\bethterm\ui` e no próprio diretório de instalação.

## Fases

1. **Override de UI no Studio** (pasta + fallback embutido + `/api/version`
   com `api_level`) e botão "Recarregar interface". Teste Go + Vitest.
2. **`deploy-ui.ps1` + branch `release` + manifesto** (publicação local, sem
   rede ainda). Instala a UI de uma pasta para validar o fluxo.
3. **Consumo remoto** (verificar, baixar, validar, aplicar, reverter) e os
   avisos no Studio, incluindo o aviso de host sem ação.
4. **Atualizador do Studio** (troca do exe com rename), só depois do teste de
   isolamento que prova que o host sobrevive.

Cada fase atualiza `FEATURES.md` (a parte visível ao usuário) e, se tocar em
arquivo upstream, `upstream-wezterm/PATCHES.md`. As fases 1 a 4 ficam em
`bethstudio-web/` e não exigem patch em arquivo upstream.

## Perguntas

1. Onde fica o remoto do branch `release`: repositório privado seu agora,
   GitHub (já pensando no open source) ou os dois?
2. A UI nova deve ser **aplicada sozinha** ao abrir o Studio, ou sempre
   perguntar? (Recomendado: perguntar, com "Aplicar agora".)
