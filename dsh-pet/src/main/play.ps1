# One-shot audio player: play an mp3/wav and block until it finishes.
# stdout/stderr stay silent; exit 0 on natural completion.
# Killed process = interrupted playback (MCI device is released by the OS on exit).
#
# Deliberately synchronous: MCI status polling on the main thread. No event
# callbacks (the async pattern crashes PowerShell 5.1, see asr.ps1/wake.ps1).

param([string]$Path)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);' | Out-Null

function Send-Mci([string]$command) {
    $buffer = New-Object System.Text.StringBuilder 256
    [void][WinMM.MCI]::mciSendString($command, $buffer, 256, [System.IntPtr]::Zero)
    return $buffer.ToString()
}

$ext = [System.IO.Path]::GetExtension($Path).ToLower()
$type = 'mpegvideo'
if ($ext -eq '.wav') { $type = 'waveaudio' }

$alias = 'ttsseg'
$null = Send-Mci ('open "' + $Path + '" type ' + $type + ' alias ' + $alias)
$null = Send-Mci ($alias + ' play')

while ($true) {
    Start-Sleep -Milliseconds 100
    $mode = Send-Mci ($alias + ' status mode')
    if ($mode -ne 'playing') { break }
}

$null = Send-Mci ($alias + ' close')
exit 0
