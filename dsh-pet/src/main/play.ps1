# 单次阻塞播放；仅自然播完返回 0，任何打开、播放、查询或关闭失败都返回非 0。
# 保持标准输出安静。强制结束进程时由系统释放设备，正常与异常路径都显式关闭。
# 使用同步轮询，避免 PowerShell 5.1 的异步回调问题。
param([string]$Path)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Mci([string]$command) {
    $buffer = New-Object System.Text.StringBuilder 256
    $code = [WinMM.MCI]::mciSendString($command, $buffer, 256, [System.IntPtr]::Zero)
    if ($code -ne 0) { throw "音频设备命令失败：$code" }
    return $buffer.ToString()
}

$opened = $false
$exitCode = 0
$alias = 'ttsseg'
try {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains('"')) { throw '音频路径无效' }
    Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);' | Out-Null

    $type = 'mpegvideo'
    if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -eq '.wav') { $type = 'waveaudio' }
    $null = Send-Mci ('open "' + $Path + '" type ' + $type + ' alias ' + $alias)
    $opened = $true
    $null = Send-Mci ('play ' + $alias)
    while ($true) {
        Start-Sleep -Milliseconds 100
        $mode = Send-Mci ('status ' + $alias + ' mode')
        if ($mode -eq 'stopped') { break }
        if ($mode -ne 'playing') { throw '音频设备未正常播放' }
    }
} catch {
    $exitCode = 1
} finally {
    if ($opened) {
        try { $null = Send-Mci ('close ' + $alias) } catch { $exitCode = 1 }
    }
}
exit $exitCode
