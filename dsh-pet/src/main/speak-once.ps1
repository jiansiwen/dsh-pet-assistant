# 单句离线回退：先合成到文件，再复用播放器，任何阶段失败都返回非 0。
# 文本通过 Base64 传入；文件保留 UTF-8 BOM，兼容 PowerShell 5.1。
param([string]$B64, [string]$OutPath)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$exitCode = 0
try {
    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $synth.SetOutputToWaveFile($OutPath)
        $synth.Speak($text)
        $synth.SetOutputToNull()
    } finally {
        $synth.Dispose()
    }

    # 共享正确的 MCI 命令、返回码检查和设备释放逻辑，不再维护第二份播放器。
    & (Join-Path $PSScriptRoot 'play.ps1') -Path $OutPath
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 1
}
exit $exitCode
