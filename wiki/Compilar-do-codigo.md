# Compilar do código

Esta página mostra como compilar o host e a CLI (Rust), o Studio (Go + React), empacotar o instalador e rodar os testes. Só há compilação para Windows.

## Pré-requisitos

| Ferramenta | Para quê |
| --- | --- |
| Rust **nightly** (`rustup toolchain install nightly`) | O WezTerm usa `edition = 2024`, que ainda não é estável. |
| Toolchain **MSVC** (Visual Studio 2022 Build Tools, carga "Desktop development with C++") | Compilador e `nmake`. |
| **Strawberry Perl** | O `openssl-sys` precisa dele para compilar o OpenSSL. O perl do MSYS2 não serve. |
| **Go 1.24+** | Backend do Studio. |
| **Node.js** com **pnpm** | Frontend React (Vite). |
| WebView2 Runtime | Para abrir a janela do Studio. |

O Perl e o MSVC precisam estar no `PATH`. Ajuste a versão do MSVC à sua:

```powershell
$env:PATH = 'C:\Strawberry\perl\bin;' + $env:PATH
```

## 1. Host e CLI (Rust)

```powershell
git clone <este-repositorio>
cd beth-studio\upstream-wezterm
cargo +nightly build --release -p wezterm -p wezterm-mux-server
```

Isso gera `bethstudio.exe` (CLI e ponte) e `bethstudio-host.exe` (host). Os pacotes do Cargo ainda se chamam `wezterm` e `wezterm-mux-server`. Para checar sem gerar binários:

```powershell
cargo +nightly check -p wezterm -p wezterm-mux-server
```

Atualizar só a CLI não basta quando você muda o comportamento do host: compile os dois.

## 2. Studio e frontend (Go + React)

```powershell
cd beth-studio\bethstudio-web
.\build.ps1
```

O `build.ps1` faz, em ordem:

1. `pnpm install` e `pnpm build` no `frontend\` (Vite). Gera a página do Studio e a do celular.
2. Copia `frontend\dist\*` para `webui\dist` (embutido no Go com `//go:embed`).
3. Gera os recursos do executável (ícone e versão) se o `go-winres` estiver instalado.
4. `go vet` e `go build`, produzindo `bethstudio-web.exe` (sem console) e `bethstudio-tool.exe` (console, para os terminais SSH e serial).

Para pular o frontend quando ele não mudou: `.\build.ps1 -SkipFrontend`.

O `bethstudio-web.exe` fala com o host por meio do `bethstudio.exe cli bridge`. Deixe os dois na mesma pasta ou use `--bethstudio <caminho>` (veja [Referência da CLI e da API](Referencia-da-CLI-e-API)).

Para abrir o checkout atual, na raiz do repositório:

```cmd
run-bethstudio.cmd
```

O `run-bethstudio.cmd` inicia o `bethstudio-web.exe` de `bethstudio-web\`. O Studio sobe e vigia o host. Use o `run-bethstudio-debug.cmd` só para ter logs detalhados.

## 3. Empacotar o instalador

Compile antes o Rust (passo 1) e o Studio (passo 2). Depois, na raiz:

```cmd
pack-bethstudio-setup.cmd
```

ou `powershell -File pack-bethstudio-setup.ps1`. O script:

1. Confere se `bethstudio.exe` e `bethstudio-host.exe` existem em `upstream-wezterm\target\release` (ou na pasta passada em `-Dist`).
2. Copia para lá o `bethstudio-web.exe`, o `bethstudio-tool.exe`, o `OpenConsole.exe` e o `conpty.dll`.
3. Compila o `bethstudio-setup`, que gera o `BethStudio.pkg.zst` (zstd).
4. Anexa o pacote ao executável do instalador e confere o rodapé `BTZSTPKG`.

O resultado é `dist\BethStudio-Setup.exe`, um arquivo único. Os passos de uso estão em [Instalação](Instalacao).

## 4. Rodar os testes

| O quê | Comando | Onde |
| --- | --- | --- |
| Módulos do host e da ponte (`wtinator`) | `cargo +nightly test -p wtinator` | `upstream-wezterm\` |
| Backend do Studio | `go test ./...` | `bethstudio-web\` |
| Frontend | `npm test` (ou `pnpm test`) | `bethstudio-web\frontend\` |

Observações:

- O CI roda só `cargo test -p wtinator --lib`, em Linux, mais uma checagem de que os arquivos obrigatórios (`NOTICE.md`, `LICENSE.md` e outros) existem. Compilar o instalador e a janela do Studio fica por sua conta, em Windows.
- Os testes do supervisor do Studio nunca devem rodar contra o host real. Defina `BETHSTUDIO_HOST_ID=<id único>` para isolá-los (mutex, evento de saída e arquivos próprios).

## 5. Teste de ponta a ponta: restauração

O script `bethstudio-web\tools\e2e-restore.ps1` testa o supervisor e a restauração de terminais depois de uma queda. Ele roda tudo isolado: um host de teste com id próprio, um `APPDATA` temporário e processos que moram em `-WorkDir`. Ele só encerra processos cujo caminho está dentro de `-WorkDir`.

O cenário:

1. Uma receita pré-gravada de um host que "já caiu".
2. O Studio de teste (`--no-window --supervise`) sobe o host de teste, vê que está vazio e recria os terminais.
3. Confere terminais, pastas, layout, nomes e aparência remapeados.
4. Mata só o host de teste: o Studio o reinicia e restaura de novo.
5. Reinicia só o Studio de teste (host e terminais vivos): nada é restaurado outra vez.

```powershell
powershell -ExecutionPolicy Bypass -File bethstudio-web\tools\e2e-restore.ps1 -AppDir C:\bs-test\app
```

O `-AppDir` precisa ter `bethstudio-web.exe`, `bethstudio.exe`, `bethstudio-host.exe`, `conpty.dll` e `OpenConsole.exe`. O `-WorkDir` padrão é `C:\bs-e2e` e não pode existir antes. Escolha um caminho curto: o socket do host precisa ter menos de 108 caracteres. Opções: `-Distro` (distro WSL para os casos WSL) e `-KeepFiles`.

## Dicas

- **Prioridade baixa.** O `build.ps1` já roda com prioridade `BelowNormal` e usa no máximo metade dos núcleos. Para o Cargo, rode em prioridade baixa e limite os jobs (por exemplo `cargo build -j 8`), senão o computador pode travar durante a compilação completa.
- **`CARGO_TARGET_DIR` fora do repositório.** Aponte para uma pasta fora do checkout se não quiser a pasta `target\` dentro dele. Os scripts da raiz (`pack-bethstudio-setup.ps1`, `install-bethstudio-release.ps1`) esperam os binários em `upstream-wezterm\target\release`; ao mudar o destino, passe `-Dist` ao empacotador.
- **A primeira compilação demora.** Compilar o WezTerm inteiro leva de 10 a 30 minutos. As seguintes são incrementais. Para mexer só nos módulos do host, `cargo +nightly build -p wtinator` basta.
- **Não instale por cima de um host em uso.** Os terminais vivem no host. Para testar, rode o build de `target\release` com `APPDATA` apontando para uma pasta temporária curta e encerre só os processos que você iniciou.
- **Formatação.** Rode `cargo fmt` antes de cada commit. Mais regras em `CONTRIBUTING.md`.

## Veja também

- [Arquitetura](Arquitetura)
- [Relação com o WezTerm](Relacao-com-o-WezTerm)
- [Instalação](Instalacao)
