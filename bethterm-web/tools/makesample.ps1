# makesample.ps1 - gera voicesample\sample.wav (audio de exemplo do "Testar tudo")
# com a voz TTS pt-BR do Windows (System.Speech/SAPI). Sem voz pt-BR, usa a
# primeira voz instalada e avisa (sample.json registra qual foi).
param([string]$Out = (Join-Path $PSScriptRoot '..\voicesample'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = 'Abre o BethTerm no PowerShell e roda o arquivo main ponto go no WSL.'
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$v = $voices | Where-Object { $_.Culture.Name -eq 'pt-BR' } | Select-Object -First 1
$warn = ''
if (-not $v) {
    $v = $voices | Select-Object -First 1
    $warn = "sem voz pt-BR instalada: usada a voz $($v.Name) ($($v.Culture.Name))"
    Write-Warning $warn
}
$s.SelectVoice($v.Name)
$s.Rate = 0
New-Item -ItemType Directory -Force $Out | Out-Null
$wav = Join-Path $Out 'sample.wav'
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($wav, $fmt)
$s.Speak($text)
$s.Dispose()
@{ text = $text; voice = $v.Name; culture = $v.Culture.Name; warning = $warn } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Out 'sample.json')
Write-Host "OK: $wav ($((Get-Item $wav).Length) bytes, voz $($v.Name))"
