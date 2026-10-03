<#
  e2e-restore.ps1 — teste de ponta a ponta do Studio supervisor + restauração.

  Roda TUDO isolado: um host de teste com id próprio (BETHTERM_HOST_ID), um
  APPDATA temporário e processos que moram em -WorkDir. Nunca toca num host,
  Studio ou GUI que já estejam rodando na máquina, e só encerra processos cujo
  caminho está dentro de -WorkDir.

  Cenário
    1. Receita pré-gravada (pane-specs.json) de um host que "já caiu" + layout
       do Studio (web-settings.json) apontando para os ids antigos.
    2. Studio de teste (--no-window --supervise) sobe o host de teste, vê que
       está vazio e recria os terminais.
    3. Confere: terminais recriados, pastas, layout/nomes/aparência remapeados,
       terminal WSL com pasta ausente abre na home.
    4. Mata SÓ o host de teste: o Studio o reinicia e restaura de novo.
    5. Reinicia SÓ o Studio de teste (mesmo host, terminais vivos): nada é restaurado de novo.

  Uso:  powershell -ExecutionPolicy Bypass -File e2e-restore.ps1 -AppDir C:\bs-test\app
  AppDir precisa de: bethterm-web.exe, bethterm.exe, bethterm-host.exe, conpty.dll, OpenConsole.exe
#>
param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [string]$WorkDir = 'C:\bs-e2e',
    [string]$Distro = '',
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
$id = 'e2e' + (Get-Random -Maximum 99999)
$results = New-Object System.Collections.ArrayList
function Check([string]$name, $ok, [string]$detail = '') {
    if ($ok -is [array]) { $ok = ($ok.Count -gt 0) }
    $ok = [bool]$ok
    [void]$results.Add([pscustomobject]@{ Teste = $name; Resultado = $(if ($ok) { 'OK' } else { 'FALHOU' }); Detalhe = $detail })
    Write-Host ("[{0}] {1} {2}" -f $(if ($ok) { 'OK    ' } else { 'FALHOU' }), $name, $detail)
}

foreach ($f in 'bethterm-web.exe', 'bethterm.exe', 'bethterm-host.exe', 'conpty.dll', 'OpenConsole.exe') {
    if (-not (Test-Path (Join-Path $AppDir $f))) { throw "falta $f em $AppDir" }
}
$AppDir = (Resolve-Path $AppDir).Path
$WorkDir = [IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
if (Test-Path $WorkDir) { throw "$WorkDir já existe; apague-o ou use outro -WorkDir" }
if (($WorkDir + '\appdata\bethterm\hosts\' + $id + '.sock').Length -gt 100) { throw "WorkDir longo demais (o socket precisa de menos de 108 caracteres)" }

# distro WSL para o teste (vazio = pula os casos WSL)
if (-not $Distro) {
    try {
        # sem WSL instalado o wsl.exe só imprime a ajuda (e sai com código != 0)
        $rawList = & wsl.exe -l -q 2>$null | Out-String
        if ($LASTEXITCODE -eq 0) {
            $names = @(($rawList -replace "`0", '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9._-]{1,64}$' -and $_ -notmatch '^docker-desktop' })
            if ($names.Count -gt 0) { $Distro = $names[0] }
        }
    } catch { }
}
Write-Host "distro WSL do teste: $(if ($Distro) { $Distro } else { '(nenhuma: casos WSL pulados)' })"

$data = Join-Path $WorkDir 'appdata\bethterm'
New-Item -ItemType Directory $WorkDir, (Join-Path $WorkDir 'appdata'), $data | Out-Null

# ---- 1. receita e layout pré-gravados -------------------------------------------------
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$specList = New-Object System.Collections.ArrayList
[void]$specList.Add(@{ pane_id = 1; shell_id = 'cmd'; kind = 'cmd'; cwd = 'C:\Windows'; title = 'cmd-a'; order = 0 })
[void]$specList.Add(@{ pane_id = 2; shell_id = 'cmd'; kind = 'cmd'; cwd = 'C:\Windows\System32'; title = 'cmd-b'; order = 1 })
if ($Distro) {
    [void]$specList.Add(@{ pane_id = 3; shell_id = 'wsl.default'; kind = 'wsl'; distro = $Distro; cwd = '/tmp'; title = 'wsl-tmp'; order = 2 })
    [void]$specList.Add(@{ pane_id = 4; shell_id = 'wsl.default'; kind = 'wsl'; distro = $Distro; cwd = '/mnt/nao/existe/xyz'; title = 'wsl-sumiu'; order = 3 })
}
$specs = @{ version = 1; saved_at = $now; host_id = '999@1'; specs = $specList.ToArray() }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $data 'pane-specs.json'), ($specs | ConvertTo-Json -Depth 6), $utf8)

function Leaf($p) { @{ type = 'leaf'; pane = $p; host_id = '999@1'; title = "t$p" } }
$tabs = New-Object System.Collections.ArrayList
[void]$tabs.Add(@{ id = 'a'; name = ''; root = @{ type = 'split'; dir = 'row'; sizes = @(1, 1); children = @((Leaf 1), (Leaf 2)) } })
if ($Distro) {
    [void]$tabs.Add(@{ id = 'b'; name = 'WSL'; root = @{ type = 'split'; dir = 'row'; sizes = @(1, 1); children = @((Leaf 3), (Leaf 4)) } })
}
$panesAppearance = @{ '1' = @{ font_size = 14; host_id = '999@1'; title = 'cmd-a' } }
$names = @{}
if ($Distro) {
    $panesAppearance['3'] = @{ font_size = 16; host_id = '999@1'; title = 'wsl-tmp' }
    $names['3'] = @{ name = 'Meu WSL'; host_id = '999@1' }
}
$web = @{ version = 2; panes = $panesAppearance; pane_names = $names; layout = @{ v = 2; active = 'a'; tabs = $tabs.ToArray() } }
[IO.File]::WriteAllText((Join-Path $data 'web-settings.json'), ($web | ConvertTo-Json -Depth 10), $utf8)

# ---- ambiente isolado (só vale para este processo e filhos) ----------------------------
$env:APPDATA = Join-Path $WorkDir 'appdata'
$env:BETHTERM_HOST_ID = $id
$env:BETHTERM_IGNORE_GUI = '1'
$cli = Join-Path $AppDir 'bethterm.exe'
$expected = $specList.Count

function StartStudio {
    $out = Join-Path $WorkDir ("out-{0}.txt" -f (Get-Random)); $err = Join-Path $WorkDir ("err-{0}.txt" -f (Get-Random))
    $p = Start-Process -FilePath (Join-Path $AppDir 'bethterm-web.exe') -ArgumentList '--no-window', '--supervise', '--port', '0', '--bethterm', $cli -WorkingDirectory $AppDir -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $script:studioErr = $err; $script:studioOut = $out
    return $p
}
function StudioURL {
    for ($i = 0; $i -lt 100; $i++) {
        if (Test-Path $script:studioOut) { $l = Get-Content $script:studioOut -TotalCount 1; if ($l -match '^http') { return $l } }
        Start-Sleep -Milliseconds 100
    }
    throw 'o Studio de teste não imprimiu a URL'
}
function Api([string]$path) {
    $u = StudioURL
    $base = $u -replace '/\?t=.*', ''; $tok = $u -replace '.*t=', ''
    Invoke-RestMethod -Uri ($base + $path) -Headers @{ 'X-BethTerm-Token' = $tok }
}
function LifeLog { $f = Join-Path $data 'host-life.log'; if (Test-Path $f) { Get-Content $f } else { @() } }
function PanesNow {
    try { $j = & $cli cli list --format json 2>$null | Out-String; if ($j.Trim()) { return @($j | ConvertFrom-Json) } } catch { }
    return @()
}
function WaitFor([scriptblock]$cond, [int]$seconds) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}
function TestProcs { Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($WorkDir + '\', [StringComparison]::OrdinalIgnoreCase) } }
function Cleanup {
    foreach ($pr in @(TestProcs)) { try { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue } catch { } }
    # o host de teste e o Studio de teste estão em AppDir; filtra por pasta de dados via linha de comando seria frágil: use o caminho dos exes copiados
}

# Os exes rodam de AppDir (que pode não estar dentro de WorkDir): copia para dentro para o filtro por caminho valer.
$runDir = Join-Path $WorkDir 'run'
New-Item -ItemType Directory $runDir | Out-Null
Copy-Item (Join-Path $AppDir '*') $runDir -Recurse -Force
$AppDir = $runDir
$cli = Join-Path $AppDir 'bethterm.exe'

try {
    # ---- 2. Studio sobe o host e restaura -------------------------------------------------
    $p1 = StartStudio
    Check 'Studio de teste subiu' (WaitFor { try { (Api '/api/host/state').state -eq 'running' } catch { $false } } 40) 'estado do host = running'
    $started = (LifeLog | Where-Object { $_ -match 'studio host iniciado' }).Count -ge 1
    Check 'o Studio iniciou o host (host-life.log)' $started
    $done = WaitFor { (LifeLog | Where-Object { $_ -match 'restauração terminou' }).Count -ge 1 } 150
    Check 'a restauração terminou' $done
    $line = (LifeLog | Where-Object { $_ -match 'restauração terminou' } | Select-Object -Last 1)
    Write-Host "  $line"

    $panes = PanesNow
    Check "terminais recriados ($expected esperados)" ($panes.Count -eq $expected) "vivos: $($panes.Count)"

    # ---- 3. pastas, layout, nomes, aparência -------------------------------------------------
    foreach ($pn in $panes) {
        & $cli cli send-text --pane-id $pn.pane_id --no-paste "cd`r" 2>$null | Out-Null
    }
    Start-Sleep -Seconds 1
    $cmdPanes = @($panes | Where-Object { $_.title -match 'cmd' -or $_.cwd -match 'Windows' })
    $s = Api '/api/settings'
    $leaves = New-Object System.Collections.ArrayList
    foreach ($t in $s.layout.tabs) {
        $stack = New-Object System.Collections.Stack; $stack.Push($t.root)
        while ($stack.Count) { $n = $stack.Pop(); if ($n.type -eq 'leaf') { [void]$leaves.Add($n) } elseif ($n.children) { foreach ($c in $n.children) { $stack.Push($c) } } }
    }
    $liveIds = @($panes | ForEach-Object { [int]$_.pane_id })
    $allAlive = ($leaves.Count -eq $expected) -and (@($leaves | Where-Object { $_.gone -or ($liveIds -notcontains [int]$_.pane) }).Count -eq 0)
    Check 'layout religado aos ids novos (nenhuma folha encerrada)' $allAlive "folhas: $($leaves.Count)"
    Check 'as abas continuam abertas' ($s.layout.tabs.Count -eq $(if ($Distro) { 2 } else { 1 })) "abas: $($s.layout.tabs.Count)"
    $sizes = @($s.panes.PSObject.Properties | Where-Object { $_.Value.font_size -ge 14 })
    Check 'aparência por terminal foi para os ids novos' ($sizes.Count -ge 1) "entradas com fonte: $($sizes.Count)"
    if ($Distro) {
        $nm = @($s.pane_names.PSObject.Properties | Where-Object { $_.Value -eq 'Meu WSL' })
        Check 'nome de aba "Meu WSL" foi para o terminal restaurado' ($nm.Count -eq 1)
        $wslPanes = @($panes | Where-Object { $_.title -match 'wsl|debian|ubuntu|\$|@' -or $_.cwd -match '/tmp|/home' })
        Check 'terminais WSL recriados' ($wslPanes.Count -ge 2) "encontrados: $($wslPanes.Count)"
        $fb = (LifeLog | Where-Object { $_ -match 'abriram na home' } | Select-Object -Last 1)
        Check 'pasta ausente caiu na home (1 fallback)' ($fb -match ', 1 abriram na home') $fb
    }

    # ---- 4. mata SÓ o host de teste: o Studio reinicia e restaura de novo -----------------
    $hostProc = @(TestProcs | Where-Object { $_.ProcessName -eq 'bethterm-host' })
    Check 'achei o host de teste para derrubar' ($hostProc.Count -eq 1)
    if ($hostProc.Count -eq 1) {
        $oldHostPid = $hostProc[0].Id
        Stop-Process -Id $oldHostPid -Force
        $again = WaitFor { (@(LifeLog | Where-Object { $_ -match 'restauração terminou' })).Count -ge 2 } 150
        Check 'depois da queda do host, restaurou de novo' $again
        $newHost = @(TestProcs | Where-Object { $_.ProcessName -eq 'bethterm-host' })
        Check 'o host é outro processo' ($newHost.Count -eq 1 -and $newHost[0].Id -ne $oldHostPid)
        Check "terminais de volta ($expected)" ((PanesNow).Count -eq $expected) "vivos: $((PanesNow).Count)"
    }

    # ---- 5. reinicia SÓ o Studio: mesmo host, terminais vivos => nada de restaurar -------
    $before = (LifeLog | Where-Object { $_ -match 'restauração terminou' }).Count
    Stop-Process -Id $p1.Id -Force
    Start-Sleep -Seconds 2
    $p2 = StartStudio
    Start-Sleep -Seconds 12
    $after = (LifeLog | Where-Object { $_ -match 'restauração terminou' }).Count
    Check 'Studio reiniciado com o host vivo não restaura nada' ($after -eq $before) "restaurações antes/depois: $before/$after"
    Check 'e não duplicou terminais' ((PanesNow).Count -eq $expected) "vivos: $((PanesNow).Count)"
}
catch {
    Check 'execução do teste' $false $_.Exception.Message
}
finally {
    # só o que mora em WorkDir
    Cleanup
    Start-Sleep -Seconds 1
    $left = @(TestProcs).Count
    Check 'nenhum processo de teste ficou rodando' ($left -eq 0) "restantes: $left"
    $report = Join-Path $env:TEMP ("e2e-restore-report-{0}.txt" -f $id)
    $results | Format-Table -AutoSize | Out-String -Width 200 | Set-Content $report -Encoding UTF8
    foreach ($f in (Get-ChildItem $WorkDir -Filter 'err-*.txt' -ErrorAction SilentlyContinue)) { Add-Content $report ("`n--- {0} (últimas linhas) ---" -f $f.Name); Get-Content $f.FullName -Tail 15 | Add-Content $report }
    Add-Content $report "`n--- host-life.log do teste ---"; LifeLog | Select-Object -Last 40 | Add-Content $report
    Write-Host "`nrelatório: $report"
    Get-Content $report -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    $fails = @($results | Where-Object { $_.Resultado -ne 'OK' }).Count
    Write-Host ("`nRESUMO: {0} verificações, {1} falharam" -f $results.Count, $fails)
    if (-not $KeepFiles) { Start-Sleep -Seconds 1; Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}
