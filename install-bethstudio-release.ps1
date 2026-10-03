[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Beth Studio'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = Join-Path $PSScriptRoot 'upstream-wezterm\target\release'
$packageFiles = @(
    'bethstudio.exe',
    'bethstudio-host.exe',
    'OpenConsole.exe',
    'conpty.dll'
)

function Get-RunningTargetProcess {
    param([string]$InstallPath)

    $prefix = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\') + '\'
    @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                $_
            }
        } catch {
            # Some protected processes do not expose Path. They cannot be a
            # process launched from this user-owned install directory.
        }
    })
}

Write-Host 'Beth Studio release installer'
Write-Host "Source:      $source"
Write-Host "Destination: $Destination"

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Release directory not found: $source. Build the Windows release first."
}

foreach ($name in $packageFiles) {
    $path = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required release artifact not found: $path"
    }
}

$running = @(Get-RunningTargetProcess -InstallPath $Destination)
$blocking = @($running | Where-Object {
    $_.ProcessName -in @('bethstudio', 'bethstudio-web', 'bethterm-gui', 'wtinator-config')
})
$hostRunning = @($running | Where-Object { $_.ProcessName -eq 'bethstudio-host' }).Count -gt 0
# Patch 0141: files the running host keeps locked. They are staged as
# <name>.new and applied by the next host start (wtinator::host).
$hostLockedFiles = @('bethstudio-host.exe', 'OpenConsole.exe', 'conpty.dll')
if ($blocking.Count -gt 0) {
    Write-Error ('Close the Beth Studio GUI/CLI and run this installer again. ' +
        'The PTY host can stay up. Running: ' +
        (($blocking | ForEach-Object { "{0} (PID {1})" -f $_.ProcessName, $_.Id }) -join ', '))
    exit 2
}

if ($DryRun) {
    Write-Host 'Dry run: no files were changed.' -ForegroundColor Yellow
    foreach ($name in $packageFiles) {
        Write-Host "Would install: $name"
    }
    exit 0
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $Destination ".install-backup\$stamp"
$backedUp = [System.Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)
$installed = [System.Collections.Generic.List[string]]::new()

try {
    foreach ($name in $packageFiles) {
        $sourceFile = Join-Path $source $name
        $destinationFile = Join-Path $Destination $name
        # Patch 0141: an identical file is left alone (it may be locked).
        if (Test-Path -LiteralPath $destinationFile -PathType Leaf) {
            $srcHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
            $dstHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
            if ($srcHash -eq $dstHash) {
                Write-Host "Unchanged: $name"
                continue
            }
        }
        if ($hostRunning -and ($hostLockedFiles -contains $name)) {
            $destinationFile = Join-Path $Destination "$name.new"
            Write-Host "Host is running; staging $name.new for the next host start."
        }
        $temporaryFile = "$destinationFile.new-$PID"

        if (Test-Path -LiteralPath $destinationFile -PathType Leaf) {
            New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
            Copy-Item -LiteralPath $destinationFile -Destination (Join-Path $backupRoot $name) -Force
            [void]$backedUp.Add($name)
        }

        Copy-Item -LiteralPath $sourceFile -Destination $temporaryFile -Force
        Move-Item -LiteralPath $temporaryFile -Destination $destinationFile -Force
        $installed.Add($name)

        $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
        if ($sourceHash -ne $destinationHash) {
            throw "Hash verification failed for $name"
        }
        Write-Host "Installed: $name"
    }
} catch {
    Write-Warning "Installation failed; restoring the previous files. $($_.Exception.Message)"
    foreach ($name in $installed) {
        $destinationFile = Join-Path $Destination $name
        $backupFile = Join-Path $backupRoot $name
        if ($backedUp.Contains($name) -and (Test-Path -LiteralPath $backupFile)) {
            Copy-Item -LiteralPath $backupFile -Destination $destinationFile -Force
        } elseif (Test-Path -LiteralPath $destinationFile) {
            Remove-Item -LiteralPath $destinationFile -Force
        }
    }
    throw
}

Write-Host ''
Write-Host 'Installation completed successfully.' -ForegroundColor Green
if ($backedUp.Count -gt 0) {
    Write-Host "Previous binaries were backed up to: $backupRoot"
}
Write-Host 'Existing extra files and WebView2 data were preserved.'
