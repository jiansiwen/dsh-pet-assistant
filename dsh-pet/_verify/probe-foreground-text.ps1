# 探测：前台窗口文本读取（read-foreground-text）
#
# 这个脚本用一次，确认新增的 UIA 操作真的能跑通 —— 光看代码不算验证过，
# 尤其是这种依赖真实桌面窗口的东西。
#
# 要点：win-actions.ts 把一条请求编码成 **base64(UTF-8 JSON) 一行**送进 stdin
# （中文、空格、引号都在 base64 里，与管道编码无关）。所以探测也必须按这个格式发，
# 直接发裸 JSON 会被脚本当成二进制声明去解 base64 并失败。

$ErrorActionPreference = 'Stop'
$script = 'D:\work\dsh-pet\src\main\win-uia.ps1'

$request = @{
    id = 'probe-1'
    op = 'read-foreground-text'
    authorized = $true
    maxChars = 400
    ownerPid = $PID
} | ConvertTo-Json -Compress

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request))

$lines = @()
try {
    $lines = $encoded | & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script 2>&1 |
        ForEach-Object { "$_" }
} catch {
    $lines = @("launch-failed: $($_.Exception.Message)")
}

# 回应同样是 base64（DSH: 前缀），在这里先解开，好让读文件的人直接看懂。
$decoded = @()
foreach ($line in $lines) {
    $text = [string]$line
    if ($text.StartsWith('DSH:')) {
        try {
            $decoded += [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text.Substring(4)))
        } catch {
            $decoded += "decode-failed: $text"
        }
    } else {
        $decoded += $text
    }
}

$payload = @{
    request = $request
    rawLines = $lines
    decoded = $decoded
    exitCode = $LASTEXITCODE
} | ConvertTo-Json -Depth 6

$payload | Out-File -FilePath 'D:\work\dsh-pet\_verify\_fg_probe.json' -Encoding UTF8
Write-Output 'written'
