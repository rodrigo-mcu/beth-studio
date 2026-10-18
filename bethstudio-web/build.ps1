# build.ps1 - compila o frontend React (Vite) e o bethstudio-web.exe (Go, windowsgui).
#
#   powershell -ExecutionPolicy Bypass -File build.ps1            # tudo
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipFrontend
#
# Pipeline (sub-pacote com //go:embed):
#   1. pnpm build (Vite)            -> frontend\dist
#   2. copia frontend\dist\*        -> webui\dist
#   3. go build com //go:embed dist -> bethstudio-web.exe
param(
    [switch]$SkipFrontend,
    [string]$Version = ''   # carimba a versão no exe (ex. 0.2.0); vazio = a do código
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Build em prioridade baixa e com no maximo metade dos nucleos, para nao
# travar o PC (os filhos herdam BelowNormal; esbuild/go respeitam GOMAXPROCS).
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
$half = [Math]::Max(1, [int]([Environment]::ProcessorCount / 2))
if (-not $env:GOMAXPROCS) { $env:GOMAXPROCS = "$half" }
$goP = [Math]::Min(8, $half)
$verFlag = ''
if ($Version) { $verFlag = " -X main.appVersion=$Version" }

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what falhou (exit $LASTEXITCODE)" }
}

if (-not $SkipFrontend) {
    Push-Location (Join-Path $root 'frontend')
    try {
        $usePnpm = [bool](Get-Command pnpm -ErrorAction SilentlyContinue)
        if (Test-Path 'pnpm-lock.yaml') { $installArgs = @('install', '--frozen-lockfile') } else { $installArgs = @('install') }
        if ($usePnpm) {
            Invoke-Checked 'pnpm install' { pnpm @installArgs }
            Invoke-Checked 'pnpm build' { pnpm build }
        } else {
            Invoke-Checked 'pnpm install (corepack)' { corepack pnpm @installArgs }
            Invoke-Checked 'pnpm build (corepack)' { corepack pnpm build }
        }
    } finally {
        Pop-Location
    }

    $dst = Join-Path $root 'webui\dist'
    Get-ChildItem -Force $dst | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force
    Copy-Item -Recurse -Force (Join-Path $root 'frontend\dist\*') $dst
}

Push-Location $root
try {
    # Icone + versao do exe (recurso #1 = icone do Beth Studio, o mesmo de
    # upstream-wezterm\assets\windows\terminal.ico). O .syso gerado fica no
    # repositorio; so' e' refeito se o go-winres existir e winres\ mudou.
    $syso = Join-Path $root 'rsrc_windows_amd64.syso'
    $winres = Join-Path (go env GOPATH) 'bin\go-winres.exe'
    $newest = (Get-ChildItem (Join-Path $root 'winres') | Measure-Object LastWriteTime -Maximum).Maximum
    if ((Test-Path $winres) -and (-not (Test-Path $syso) -or (Get-Item $syso).LastWriteTime -lt $newest)) {
        Invoke-Checked 'go-winres' { & $winres make --in winres\winres.json --arch amd64 --out rsrc }
    } elseif (-not (Test-Path $syso)) {
        Write-Warning 'rsrc_windows_amd64.syso ausente e go-winres nao instalado (go install github.com/tc-hib/go-winres@latest): exe sem icone'
    }
    # Audio de exemplo do "Testar tudo" (voz TTS pt-BR do Windows), embutido no exe.
    if (-not (Test-Path (Join-Path $root 'voicesample\sample.wav'))) {
        Invoke-Checked 'makesample' { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\makesample.ps1') }
    }
    # bethstudio-proxy para Linux (amd64 e arm64), embutido no Studio pelo
    # assistente "Instalar servidor" (vpsinstall\bins). O assistente confere o
    # SHA-256 deste arquivo antes de usar e de novo no servidor, depois do envio.
    $bins = Join-Path $root 'vpsinstall\bins'
    New-Item -ItemType Directory -Force $bins | Out-Null
    $sums = @()
    foreach ($arch in 'amd64', 'arm64') {
        $name = "bethstudio-proxy-linux-$arch"
        $out = Join-Path $bins $name
        $env:CGO_ENABLED = '0'; $env:GOOS = 'linux'; $env:GOARCH = $arch
        try {
            Invoke-Checked "go build proxy $arch" { go build -p $goP -trimpath -ldflags "-s -w" -o $out ./cmd/bethstudio-proxy }
        } finally {
            Remove-Item Env:\CGO_ENABLED, Env:\GOOS, Env:\GOARCH -ErrorAction SilentlyContinue
        }
        $sums += ('{0}  {1}' -f (Get-FileHash $out -Algorithm SHA256).Hash.ToLower(), $name)
    }
    [IO.File]::WriteAllText((Join-Path $bins 'SHA256SUMS'), (($sums -join "`n") + "`n"))
    Invoke-Checked 'go vet' { go vet -p $goP -unsafeptr=false ./... }
    Invoke-Checked 'go build' { go build -p $goP -trimpath -ldflags "-H windowsgui -s -w -X main.buildTime=$(Get-Date -Format s)$verFlag" -o bethstudio-web.exe . }
    # bethstudio-tool.exe: o mesmo pacote como programa de CONSOLE (sem
    # -H windowsgui), para os terminais de ferramenta (--ssh / --serial) que o
    # host cria; vai na mesma pasta do bethstudio.exe.
    Invoke-Checked 'go build (tool)' { go build -p $goP -trimpath -ldflags "-s -w -X main.buildTime=$(Get-Date -Format s)$verFlag" -o bethstudio-tool.exe . }
} finally {
    Pop-Location
}

$exe = Get-Item (Join-Path $root 'bethstudio-web.exe')
Write-Host ("OK: {0} ({1:N1} MB)" -f $exe.FullName, ($exe.Length / 1MB))
$tool = Get-Item (Join-Path $root 'bethstudio-tool.exe')
Write-Host ("OK: {0} ({1:N1} MB)" -f $tool.FullName, ($tool.Length / 1MB))
