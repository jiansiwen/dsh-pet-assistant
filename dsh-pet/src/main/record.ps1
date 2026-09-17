# Fallback dictation recorder: record mono wav via MCI (winmm).
# Render-side getUserMedia is the primary path; this covers environments where
# the Web Audio pipeline is unavailable. Fixed 12 s window - the main process
# trims silence and normalizes to 16-bit before recognition.
#
# MCI command order is "command alias params" (record dicrec), not the reverse:
# the wrong order fails with MCIERR 261 and saves an empty 44-byte header.
# bitspersample/bytespersample switches are rejected by most drivers (282/259),
# so recording stays 8-bit - the main process normalizes it to 16-bit PCM.
#
# Deliberately synchronous, no event callbacks (they crash PowerShell 5.1).

param([string]$OutPath, [int]$MaxMs = 12000)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);' | Out-Null

function Send-Mci([string]$command) {
    $buffer = New-Object System.Text.StringBuilder 256
    [void][WinMM.MCI]::mciSendString($command, $buffer, 256, [System.IntPtr]::Zero)
    return $buffer.ToString()
}

$null = Send-Mci 'open new type waveaudio alias dicrec'
# 单独设采样率多数驱动接受；失败就保持设备默认（11025Hz），识别端按 wav 头如实处理。
$null = Send-Mci 'set dicrec samplespersec 16000'
$null = Send-Mci 'record dicrec'
Start-Sleep -Milliseconds $MaxMs
$null = Send-Mci 'stop dicrec'
$null = Send-Mci ('save dicrec "' + $OutPath + '"')
$null = Send-Mci 'close dicrec'

if ((Test-Path $OutPath) -and ((Get-Item $OutPath).Length -gt 44)) { exit 0 }
exit 1
