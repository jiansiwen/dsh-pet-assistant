# Offline fallback for one utterance: System.Speech synthesizes a wav, then
# MCI-plays it, blocking until playback finishes. Killed process = interrupted.
# Input text arrives base64-encoded so the file can stay pure ASCII
# (PowerShell 5.1 parses BOM-less UTF-8 as GBK).

param([string]$B64, [string]$OutPath)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Speech
Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);' | Out-Null

function Send-Mci([string]$command) {
    $buffer = New-Object System.Text.StringBuilder 256
    [void][WinMM.MCI]::mciSendString($command, $buffer, 256, [System.IntPtr]::Zero)
    return $buffer.ToString()
}

$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile($OutPath)
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()

$null = Send-Mci ('open "' + $OutPath + '" type waveaudio alias ttsseg')
$null = Send-Mci ('ttsseg play')
while ($true) {
    Start-Sleep -Milliseconds 100
    $mode = Send-Mci ('ttsseg status mode')
    if ($mode -ne 'playing') { break }
}
$null = Send-Mci ('ttsseg close')
exit 0
