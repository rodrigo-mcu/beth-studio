# deploy-ui.ps1 - empacota e instala SO a interface do Beth Studio (React),
# sem tocar em bethstudio-host.exe nem no exe do Studio.
#
#   deploy-ui.ps1                  # compila a UI e instala em <dados>\ui\current
#   deploy-ui.ps1 -SkipBuild       # reaproveita frontend\dist ja' compilado
#   deploy-ui.ps1 -Publish         # tambem commita no branch orfao "release" + tag ui-<versao>
#   deploy-ui.ps1 -Rollback        # volta <dados>\ui\previous para current
#   deploy-ui.ps1 -DataDir <pasta> # instala em outra pasta de dados (testes)
#
# Depois de instalar, a UI nova aparece com "Recarregar interface"
# (Configuracoes > Sobre) ou F5: o Studio nao reinicia e o host nem e' notado.
# Se o pacote pedir um Studio mais novo (requires_api), o Studio ignora o
# pacote e segue com a UI embutida.
param(
    [switch]$SkipBuild,
    [switch]$Publish,
    [switch]$Rollback,
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$repo = Split-Path $root -Parent

try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}

function Get-DataDir {
    if ($DataDir) { return $DataDir }
    if ($env:BETHSTUDIO_DATA_DIR) { return $env:BETHSTUDIO_DATA_DIR }
    $d = Join-Path $env:APPDATA 'bethstudio'
    $legacy = Join-Path $env:APPDATA 'wezterminator'
    if (-not (Test-Path $d) -and (Test-Path $legacy)) { return $legacy }
    return $d
}

$uiRoot = Join-Path (Get-DataDir) 'ui'
$current = Join-Path $uiRoot 'current'
$previous = Join-Path $uiRoot 'previous'

if ($Rollback) {
    if (-not (Test-Path $previous)) { throw "Nao ha versao anterior em $previous" }
    $tmp = Join-Path $uiRoot 'swap'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    if (Test-Path $current) { Rename-Item $current 'swap' }
    Rename-Item $previous 'current'
    if (Test-Path $tmp) { Rename-Item $tmp 'previous' }
    $m = Get-Content (Join-Path $current 'ui.json') -Raw | ConvertFrom-Json
    Write-Host "OK: voltou para a interface $($m.version). Recarregue a interface no Studio."
    return
}

# --- compila ------------------------------------------------------------
$dist = Join-Path $root 'frontend\dist'
if (-not $SkipBuild) {
    Push-Location (Join-Path $root 'frontend')
    try {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm install --frozen-lockfile; if ($LASTEXITCODE) { throw 'pnpm install falhou' }; pnpm build }
        else { corepack pnpm install --frozen-lockfile; if ($LASTEXITCODE) { throw 'pnpm install falhou' }; corepack pnpm build }
        if ($LASTEXITCODE) { throw 'pnpm build falhou' }
    } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $dist 'index.html'))) { throw "frontend\dist\index.html ausente: rode sem -SkipBuild" }

# requires_api: o nivel de API deste codigo (const apiLevel em uiroot.go).
$m = Select-String -Path (Join-Path $root 'uiroot.go') -Pattern '^const apiLevel = (\d+)' | Select-Object -First 1
if (-not $m) { throw 'nao achei "const apiLevel" em uiroot.go' }
$requiresApi = [int]$m.Matches[0].Groups[1].Value

$version = Get-Date -Format 'yyyy.MM.dd-HHmm'
try { $sha = (git -C $repo rev-parse --short HEAD).Trim() } catch { $sha = '' }
$dirty = $false
try { $dirty = [bool](git -C $repo status --porcelain -- bethstudio-web/frontend) } catch {}

# --- monta o pacote (staging) ---------------------------------------------
New-Item -ItemType Directory -Force $uiRoot | Out-Null
$staging = Join-Path $uiRoot "staging-$version"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory $staging | Out-Null
Copy-Item -Recurse -Force (Join-Path $dist '*') $staging

# hashes de tudo (menos o proprio ui.json), para conferir antes de aplicar
$files = [ordered]@{}
Get-ChildItem -Recurse -File $staging | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
    $files[$rel] = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower()
}
$manifest = [ordered]@{
    version      = $version
    requires_api = $requiresApi
    commit       = $sha
    dirty        = $dirty
    files        = $files
}
# ui.json por ultimo: o Studio so' considera o pacote valido quando ele existe.
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $staging 'ui.json')

# --- troca atomica: current -> previous, staging -> current ----------------
if (Test-Path $previous) { Remove-Item -Recurse -Force $previous }
if (Test-Path $current) { Rename-Item $current 'previous' }
Rename-Item $staging 'current'
Write-Host "OK: interface $version instalada em $current (requires_api=$requiresApi)."
Write-Host "    No Studio: Configuracoes > Sobre > Recarregar interface (ou F5). Host e Studio nao foram tocados."
if ($dirty) { Write-Warning 'frontend com alteracoes nao commitadas: o pacote nao corresponde a nenhum commit.' }

# --- publica no branch "release" (so' git local; o push e' decisao sua) ------
if ($Publish) {
    if ($dirty) { throw 'Publicar com frontend sujo: commite antes.' }
    $wt = Join-Path ([IO.Path]::GetTempPath()) "beth-release-$version"
    $exists = git -C $repo show-ref --verify --quiet refs/heads/release; $has = ($LASTEXITCODE -eq 0)
    if ($has) { git -C $repo worktree add $wt release | Out-Null }
    else { git -C $repo worktree add --detach $wt | Out-Null; git -C $wt checkout --orphan release | Out-Null; git -C $wt rm -rf . | Out-Null }
    try {
        Get-ChildItem -Force $wt | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
        $dest = Join-Path $wt 'ui'
        New-Item -ItemType Directory $dest | Out-Null
        Copy-Item -Recurse -Force (Join-Path $current '*') $dest
        # manifesto de release (o que o Studio consulta; ver docs/superpowers/specs/2026-10-08-*)
        [ordered]@{ release = $version; ui = [ordered]@{ version = $version; requires_api = $requiresApi; dir = 'ui' } } |
            ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $wt 'manifest.json')
        git -C $wt add -A | Out-Null
        git -C $wt commit -q -m "ui $version (commit $sha)"
        git -C $wt tag "ui-$version"
        Write-Host "OK: branch release atualizado, tag ui-$version. Nada foi enviado (git push quando quiser)."
    } finally {
        git -C $repo worktree remove --force $wt
    }
}
