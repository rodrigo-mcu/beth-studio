# Build the native Win32 installer and embed BethTerm.pkg.zst inside it.
[CmdletBinding()]
param(
    [string]$Dist = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($Dist)) {
    $Dist = Join-Path $Root 'upstream-wezterm\target\release'
}

$env:PATH = 'C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;' + $env:PATH
$env:BETHTERM_DIST = (Resolve-Path -LiteralPath $Dist).Path

foreach ($name in @('bethterm.exe', 'bethterm-host.exe')) {
    $p = Join-Path $env:BETHTERM_DIST $name
    if (-not (Test-Path -LiteralPath $p)) {
        throw "Missing $p. Build wezterm + wezterm-mux-server first."
    }
}

$webDir = Join-Path $Root 'bethterm-web'
foreach ($name in @('bethterm-web.exe', 'bethterm-tool.exe')) {
    $src = Join-Path $webDir $name
    if (-not (Test-Path -LiteralPath $src)) {
        throw "Missing $src. Build Beth Studio first (bethterm-web\build.ps1)."
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $env:BETHTERM_DIST $name) -Force
}

Set-Location (Join-Path $Root 'upstream-wezterm')
cargo +nightly build --release -p bethterm-setup
if ($LASTEXITCODE -ne 0) { throw 'cargo build -p bethterm-setup failed' }

$outDir = Join-Path $Root 'dist'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$stub = Join-Path $env:BETHTERM_DIST 'bethterm-setup.exe'
$pkgPath = Join-Path $env:BETHTERM_DIST 'BethTerm.pkg.zst'
$setupPath = Join-Path $outDir 'BethTerm-Setup.exe'
if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "Missing $pkgPath (build.rs should have written the zstd payload)."
}

# Always start from the cargo stub so a second pack does not nest payloads.
Copy-Item $stub $setupPath -Force
$sidecar = Join-Path $outDir 'BethTerm.pkg.zst'
if (Test-Path -LiteralPath $sidecar) {
    Remove-Item -LiteralPath $sidecar -Force
}

$pkg = Get-Item -LiteralPath $pkgPath
$pkgLen = [uint64]$pkg.Length
$out = [IO.File]::Open($setupPath, [IO.FileMode]::Append, [IO.FileAccess]::Write)
try {
    $in = [IO.File]::OpenRead($pkgPath)
    try {
        $in.CopyTo($out)
    } finally {
        $in.Close()
    }
    $out.Write([BitConverter]::GetBytes($pkgLen), 0, 8)
    $out.Write([System.Text.Encoding]::ASCII.GetBytes('BTZSTPKG'), 0, 8)
} finally {
    $out.Close()
}

$setup = Get-Item -LiteralPath $setupPath
$stubLen = (Get-Item -LiteralPath $stub).Length
$expected = $stubLen + [int64]$pkgLen + 16
if ($setup.Length -ne $expected) {
    throw "Embedded setup size $($setup.Length) != expected $expected"
}

$fs = [IO.File]::OpenRead($setupPath)
try {
    [void]$fs.Seek(-8, [IO.SeekOrigin]::End)
    $magicBuf = New-Object byte[] 8
    [void]$fs.Read($magicBuf, 0, 8)
    $magic = [System.Text.Encoding]::ASCII.GetString($magicBuf)
    if ($magic -ne 'BTZSTPKG') {
        throw "Missing BTZSTPKG trailer (got '$magic')"
    }
} finally {
    $fs.Close()
}

Write-Host ("Setup (GUI nativa + zstd embutido): {0:N0} bytes" -f $setup.Length)
Write-Host ("  stub:    {0:N0} bytes" -f $stubLen)
Write-Host ("  payload: {0:N0} bytes" -f $pkgLen)
Write-Host "Single file: copy only BethTerm-Setup.exe."
