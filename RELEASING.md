# Como fazer um release

Roteiro para publicar uma versão do Beth Studio com binários que qualquer pessoa baixa e usa. Dois caminhos: **pelo GitHub Actions** (recomendado) ou **na sua máquina**. Os dois usam o mesmo `release.ps1`.

O que sai em cada release (página **Releases** do GitHub):

| Arquivo | Para quem |
| --- | --- |
| `BethStudio-Setup.exe` | A maioria: um arquivo, dois cliques, instala numa pasta visível |
| `BethStudio-<versão>-windows-x64.zip` | Quem prefere portátil: descompacta e abre `bethstudio-web.exe` |
| `BethStudio-ui-<versão>.zip` | Só a interface. Dentro, `ui.json` traz a versão, `requires_api` e o SHA-256 de cada arquivo. O Studio confere o zip com `SHA256SUMS.txt` antes de trocar a interface, sem reiniciar o host |
| `SHA256SUMS.txt` | Conferir o download |

Cada pacote já leva `LICENSE.md`, `NOTICE.md`, `THIRD-PARTY-NOTICES.md` e os textos de licença das dependências (exigência da MIT/BSD/LGPL).

## 0. Antes de começar (uma vez)

- Remote do GitHub configurado: `git remote add origin https://github.com/<usuario>/<repositorio>.git`.
- Ferramentas na máquina (só para o caminho local): Rust nightly + MSVC + Strawberry Perl, Go 1.24+, Node.js 24 (os testes em TypeScript exigem 22.18 ou mais) + pnpm, Python 3.
- Em **Settings > Actions > General** do repositório, deixe **Workflow permissions** em *Read and write* (o release usa `contents: write`).

## 1. Preparar a versão

1. Escolha a versão (`MAJOR.MINOR.PATCH`, ex. `0.2.0`; pré-lançamento: `0.2.0-rc.1`).
2. Em `CHANGELOG.md`, renomeie `## [Unreleased]` para `## [0.2.0] - AAAA-MM-DD` e crie um novo `## [Unreleased]` vazio acima. O texto desse bloco vira as notas do release.
3. Se a API entre o Studio (Go) e a interface (React) mudou de forma que quebra interfaces antigas, suba `apiLevel` em `bethstudio-web/uiroot.go`.
4. Confira que `git status` está limpo e que o CI da `main` está verde.
5. Commit: `git commit -am "Release 0.2.0"`.

## 2a. Pelo GitHub Actions (recomendado)

```powershell
git tag -a v0.2.0 -m "Beth Studio 0.2.0"
git push origin main v0.2.0
```

O workflow `Release` roda os testes, compila tudo e cria um **release em rascunho** com os arquivos. Leva de 30 a 60 minutos (o Rust é o mais lento). Se a mensagem do commit para o qual a tag aponta tiver `[publicar]`, o release já sai **publicado** (sem rascunho). Uma versão com hífen, como `0.3.0-rc.1`, sai marcada como pré-lançamento.

## 2b. Na sua máquina

```powershell
.\release.ps1 -Version 0.2.0 -Tag          # build + testes + pacotes em dist\release\
```

Opções: `-SkipHost` reaproveita o host/CLI já compilados; `-SkipTests` pula os testes (não recomendado). O script **não envia nada**. Para publicar o que ele gerou:

```powershell
git push origin main v0.2.0                # e crie o release em github.com/<usuario>/<repositorio>/releases/new
# ou, com o GitHub CLI:
gh release create v0.2.0 dist\release\BethStudio-Setup.exe dist\release\BethStudio-0.2.0-windows-x64.zip dist\release\BethStudio-ui-0.2.0.zip dist\release\SHA256SUMS.txt --draft --title "Beth Studio 0.2.0" --notes-file dist\release\RELEASE_NOTES.md
```

## 3. Testar o que vai ser publicado (obrigatório)

Em uma pasta limpa, **sem encostar na instalação que você usa**:

1. Baixe o rascunho (ou use `dist\release\`) e confira `SHA256SUMS.txt`: `Get-FileHash BethStudio-Setup.exe`.
2. Descompacte o zip portátil numa pasta curta (`C:\bstest`), defina `APPDATA` para outra pasta curta e rode `bethstudio-web.exe`. Confira em **Configurações > Sobre** a versão e que a interface carrega.
3. Teste o instalador numa pasta diferente da instalação real. Não marque *Encerrar tudo*.
4. Nunca pare o `bethstudio-host.exe` de quem está em uso (veja `AGENTS.md`).

## 4. Publicar

No GitHub, abra o rascunho, revise as notas e clique em **Publish release**. Anuncie o link da página de Releases (não o do arquivo), porque ela mostra sempre a versão mais nova.

## 5. Depois

- `git push` da wiki, se mudou (`docs/WIKI-PUBLICAR.md`).
- Atualização para quem já usa: o instalador mantém o host rodando; só marque *Encerrar tudo* se o release mudou o host (isso está nas notas).

## Problemas comuns

- **`pnpm`/`corepack` não encontrado**: `corepack enable` (Node 20+).
- **O build do Rust pede `perl`/`nmake`**: abra o *x64 Native Tools Command Prompt* do Visual Studio ou ponha o Strawberry Perl no `PATH`.
- **`collect-licenses` falha com "SEM ARQUIVO DE LICENÇA"**: uma dependência nova não traz licença; veja `docs/THIRD-PARTY-NOTICES.md`, seção *Adding a new third-party dependency*.
- **A tag já existe**: `git tag -d v0.2.0` (local) antes de refazer; se já foi enviada, use outra versão.
