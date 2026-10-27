# 常驻播放进程：启动时把 MCI 编译一次，之后只按行接收"播哪条"，播完回报。
#
# 为什么需要它：play.ps1 每唤醒一次就要新起一个 PowerShell，实测播放 0.4 秒的音频总耗时
# 2.5 秒（首次 5 秒）—— 其中 2 秒以上是冷启动与 Add-Type 编译，用户听到的就是"喊完一两秒
# 才回话"。常驻进程把这笔开销挪到启动预热阶段，唤醒时只剩 open/play 两条 MCI 命令。
#
# 协议（全部 ASCII，避免管道编码问题）：
#   stdin   <id> <base64(utf8 文件路径)>  或 quit
#   stdout  ready / ok <id> / err <id>
# 路径用 base64 传：临时目录、用户名都可能含中文或空格，直接拼一行会被拆开。
# 播放仍然阻塞到自然结束（轮询 status mode），与 play.ps1 的行为一致。
param()

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

function Send-Mci([string]$command) {
    $buffer = New-Object System.Text.StringBuilder 256
    $code = [WinMM.MCI]::mciSendString($command, $buffer, 256, [System.IntPtr]::Zero)
    if ($code -ne 0) { throw "MCI 命令失败：$code" }
    return $buffer.ToString()
}

try {
    Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, System.IntPtr hwndCallback);' | Out-Null
} catch {
    # 编译失败（策略限制 / 组件缺失）就退出：调用方会回退到一次性 spawn 的 play.ps1。
    exit 2
}

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

$counter = 0
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'quit') { break }

    $id = $line
    $payload = ''
    $space = $line.IndexOf(' ')
    if ($space -gt 0) {
        $id = $line.Substring(0, $space)
        $payload = $line.Substring($space + 1)
    }

    $counter++
    $alias = 'ph' + $counter.ToString()
    $ok = $false
    try {
        $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($payload))
        if ([string]::IsNullOrWhiteSpace($path) -or $path.Contains('"')) { throw '音频路径无效' }
        $type = 'mpegvideo'
        if ([System.IO.Path]::GetExtension($path).ToLowerInvariant() -eq '.wav') { $type = 'waveaudio' }
        $null = Send-Mci ('open "' + $path + '" type ' + $type + ' alias ' + $alias)
        try {
            $null = Send-Mci ('play ' + $alias)
            while ($true) {
                Start-Sleep -Milliseconds 50
                $mode = Send-Mci ('status ' + $alias + ' mode')
                if ($mode -eq 'stopped') { break }
                if ($mode -ne 'playing') { throw '音频设备未正常播放' }
            }
            $ok = $true
        } finally {
            try { $null = Send-Mci ('close ' + $alias) } catch { $ok = $false }
        }
    } catch {
        $ok = $false
        # 打开失败时 alias 可能根本没建起来；close 失败可以忽略，不能让它打断循环。
        try { $null = Send-Mci ('close ' + $alias) } catch { }
    }

    if ($ok) { [Console]::Out.WriteLine('ok ' + $id) } else { [Console]::Out.WriteLine('err ' + $id) }
    [Console]::Out.Flush()
}
