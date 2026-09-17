# Personal-assistant foreground window sampler (managed child process, file-backed).
# Appends one JSON sample per interval to <DSH_SAMPLE_DIR>/<yyyy-MM-dd>.jsonl
# Sample: {"ts":<unix-ms>,"pid":N,"proc":"name","title":"text","idleMs":N}
# Without title authorization (DSH_SAMPLE_TITLES=0): {"ts":<unix-ms>,"pid":N,"proc":"name","idleMs":N}
# Idle sample when no foreground window: {"ts":<unix-ms>,"idle":true,"idleMs":N}

$dir = $env:DSH_SAMPLE_DIR
if (-not $dir) { exit 1 }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$interval = 5000
if ($env:DSH_SAMPLE_INTERVAL_MS) {
    $interval = [int]$env:DSH_SAMPLE_INTERVAL_MS
}
if ($interval -lt 1000) { $interval = 1000 }

# Title capture is graded authorization, not a filter: when it is off we never call
# GetWindowText at all, so unauthorized text never reaches the JSONL file in the first place.
$captureTitles = $true
if ($env:DSH_SAMPLE_TITLES -eq '0') { $captureTitles = $false }

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@

# Milliseconds since last keyboard/mouse input. A bare number, no window or app identity:
# it powers the proactive-reminder idle threshold (design.md section 2.7) and nothing else.
function Get-IdleMs {
    $info = New-Object DshWin32+LASTINPUTINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin32+LASTINPUTINFO])
    $ok = [DshWin32]::GetLastInputInfo([ref]$info)
    if (-not $ok) { return $null }
    $tick = [int64][Environment]::TickCount
    $diff = $tick - [int64]$info.dwTime
    if ($diff -lt 0) { $diff += 4294967296 }
    return [int]$diff
}

$utf8 = New-Object System.Text.UTF8Encoding($false)

# Publish own pid so the plugin can manage this process.
try {
    [System.IO.File]::WriteAllText((Join-Path $dir 'sampler.pid'), "$PID", $utf8)
} catch { }

while ($true) {
    try {
        $idleMs = Get-IdleMs
        $hwnd = [DshWin32]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) {
            $line = '{"ts":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"idle":true'
            if ($null -ne $idleMs) { $line += ',"idleMs":' + $idleMs }
            $line += '}'
        } else {
            $procId = [uint32]0
            [void][DshWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
            $procName = 'unknown'
            try {
                $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName
            } catch { }
            $obj = @{
                ts   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                pid  = $procId
                proc = $procName
            }
            if ($null -ne $idleMs) { $obj['idleMs'] = $idleMs }
            if ($captureTitles) {
                $sb = New-Object System.Text.StringBuilder 1024
                [void][DshWin32]::GetWindowText($hwnd, $sb, 1024)
                $obj['title'] = $sb.ToString()
            }
            $line = $obj | ConvertTo-Json -Compress
        }
        $date = Get-Date -Format 'yyyy-MM-dd'
        $file = Join-Path $dir ($date + '.jsonl')
        [System.IO.File]::AppendAllText($file, $line + "`n", $utf8)
    } catch {
        # Skip a failed single sample and keep sampling.
    }
    Start-Sleep -Milliseconds $interval
}
