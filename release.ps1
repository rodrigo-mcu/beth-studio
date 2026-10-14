# release.ps1 - gera os arquivos de um release do Beth Studio (Windows x64).
#
#   .\release.ps1 -Version 0.2.0                 # build completo + testes + pacotes em dist\release\
#   .\release.ps1 -Version 0.2.0 -SkipHost       # reaproveita bethstudio.exe / bethstudio-host.exe ja' compilados
#   .\release.ps1 -Version 0.2.0 -SkipTests      # (nao recomendado)
#   .\release.ps1 -Version 0.2.0 -Tag            # tambem cria a tag git v0.2.0 (local, nao envia)
#
# Saida em dist\release\:
#   BethStudio-Setup.exe                    instalador de um arquivo so' (o que a maioria baixa)
#   BethStudio-<ver>-windows-x64.zip        versao portatil: descompacte e use
#   BethStudio-ui-<ver>.zip                 so' a interface (para o deploy-ui.ps1 / atualizacao sem reiniciar)
#   SHA256SUMS.txt                          somas de verificacao
#   RELEASE_NOTES.md                        texto do release (a partir do CHANGELOG.md)
#
# Nada aqui envia coisa para a internet. Publicar e' o passo final do RELEASING.md.
# Roda em prioridade BelowNormal para nao travar a maquina.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$SkipHost,
    [switch]$SkipTests,
    [switch]$AllowDirty,
    [switch]$Tag
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = $PSScriptRoot
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}

function Step([string]$m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Run([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what falhou (exit $LASTEXITCODE)" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Versao '$Version' invalida: use 0.2.0 ou 0.2.0-rc.1" }

Step "Conferindo o repositorio"
$dirty = git -C $Root status --porcelain
if ($dirty -and -not $AllowDirty) { throw "Ha alteracoes nao commitadas. Commite (ou use -AllowDirty para um teste):`n$dirty" }
# No GitHub Actions o build e' disparado pela propria tag: ela precisa existir.
if (-not $env:GITHUB_ACTIONS -and (git -C $Root tag --list "v$Version")) { throw "A tag v$Version ja' existe." }
$commit = (git -C $Root rev-parse --short HEAD).Trim()

$perl = 'C:\Strawberry\perl\bin'
if (Test-Path $perl) { $env:PATH = "$perl;" + $env:PATH }

$dist = Join-Path $Root 'upstream-wezterm\target\release'
$web = Join-Path $Root 'bethstudio-web'
$out = Join-Path $Root 'dist\release'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $SkipTests) {
    Step "Testes"
    Push-Location $web
    try { Run 'go test' { go test -count=1 ./... } } finally { Pop-Location }
    Push-Location (Join-Path $web 'frontend')
    try {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) { Run 'pnpm install' { pnpm install --frozen-lockfile }; Run 'pnpm test' { pnpm test } }
        else { Run 'pnpm install' { corepack pnpm install --frozen-lockfile }; Run 'pnpm test' { corepack pnpm test } }
    } finally { Pop-Location }
    Push-Location (Join-Path $Root 'upstream-wezterm')
    try { Run 'cargo test wtinator' { cargo +nightly test -p wtinator --lib } } finally { Pop-Location }
}

if (-not $SkipHost) {
    Step "Compilando host e CLI (Rust, demora)"
    Push-Location (Join-Path $Root 'upstream-wezterm')
    try { Run 'cargo build' { cargo +nightly build --release -p wezterm -p wezterm-mux-server } } finally { Pop-Location }
}
foreach ($n in 'bethstudio.exe', 'bethstudio-host.exe') {
    if (-not (Test-Path (Join-Path $dist $n))) { throw "Falta $dist\$n (compile sem -SkipHost)." }
}

Step "Compilando o Studio (Go + React) versao $Version"
Push-Location $web
try { Run 'build.ps1' { powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -Version $Version } } finally { Pop-Location }

Step "Juntando as licencas das dependencias"
$lic = Join-Path $out 'licenses'
Run 'collect-licenses' { python -I (Join-Path $Root 'tools\collect-licenses.py') $lic }
Copy-Item (Join-Path $lic 'THIRD-PARTY-LICENSES.txt') (Join-Path $dist 'THIRD-PARTY-LICENSES.txt') -Force

Step "Empacotando o instalador"
Run 'pack' { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'pack-bethstudio-setup.ps1') }
Copy-Item (Join-Path $Root 'dist\BethStudio-Setup.exe') (Join-Path $out 'BethStudio-Setup.exe')

Step "Montando o zip portatil"
$stage = Join-Path $out "BethStudio-$Version"
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($n in 'bethstudio.exe', 'bethstudio-host.exe', 'bethstudio-web.exe', 'bethstudio-tool.exe', 'OpenConsole.exe', 'conpty.dll') {
    $p = Join-Path $dist $n
    if (-not (Test-Path $p)) { throw "Falta $p" }
    Copy-Item $p $stage
}
foreach ($n in 'LICENSE.md', 'NOTICE.md') { Copy-Item (Join-Path $Root $n) $stage }
Copy-Item (Join-Path $Root 'docs\THIRD-PARTY-NOTICES.md') $stage
Copy-Item -Recurse $lic (Join-Path $stage 'licenses')
Compress-Archive -Path $stage -DestinationPath (Join-Path $out "BethStudio-$Version-windows-x64.zip") -CompressionLevel Optimal
Remove-Item -Recurse -Force $stage

Step "Pacote so' da interface"
$uiStage = Join-Path $out 'ui-stage'
New-Item -ItemType Directory -Force $uiStage | Out-Null
Copy-Item -Recurse (Join-Path $web 'frontend\dist\*') $uiStage
$apiLevel = [int](Select-String -Path (Join-Path $web 'uiroot.go') -Pattern '^const apiLevel = (\d+)').Matches[0].Groups[1].Value
[ordered]@{ version = $Version; requires_api = $apiLevel; commit = $commit } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $uiStage 'ui.json')
Compress-Archive -Path (Join-Path $uiStage '*') -DestinationPath (Join-Path $out "BethStudio-ui-$Version.zip") -CompressionLevel Optimal
Remove-Item -Recurse -Force $uiStage

Step "Notas e somas de verificacao"
$cl = Get-Content (Join-Path $Root 'CHANGELOG.md') -Raw
$m = [regex]::Match($cl, "(?ms)^## \[(?:$([regex]::Escape($Version))|Unreleased)\][^\n]*\n(.*?)(?=^## \[|\z)")
$body = if ($m.Success) { $m.Groups[1].Value.Trim() } else { '(sem notas no CHANGELOG.md)' }
@"
# Beth Studio $Version

$body

## Como instalar

Baixe **BethStudio-Setup.exe**, execute e clique em *Instalar*. Prefere sem instalador? Use o zip ``BethStudio-$Version-windows-x64.zip``: descompacte e abra ``bethstudio-web.exe``.
Requer Windows 10/11 com o Microsoft Edge WebView2 Runtime (ja' vem no Windows atual).

Confira os arquivos com ``SHA256SUMS.txt``. Os avisos de licenca de terceiros estao em ``THIRD-PARTY-NOTICES.md`` e na pasta ``licenses``.
"@ | Set-Content -Encoding UTF8 (Join-Path $out 'RELEASE_NOTES.md')

$sums = Get-ChildItem $out -File | Where-Object { $_.Name -match '\.(exe|zip)$' } | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name
}
$sums | Set-Content -Encoding ASCII (Join-Path $out 'SHA256SUMS.txt')

if ($Tag) {
    git -C $Root tag -a "v$Version" -m "Beth Studio $Version"
    Write-Host "Tag v$Version criada (local)."
}

Write-Host "`nPronto: $out" -ForegroundColor Green
Get-ChildItem $out -File | ForEach-Object { '  {0,-45} {1,10:N1} MB' -f $_.Name, ($_.Length / 1MB) }
Write-Host "`nProximo passo: RELEASING.md (testar o instalador numa pasta limpa e publicar)."
