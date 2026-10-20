# 桌面动作的 Windows 辅助脚本：UI Automation + 少量 Win32，常驻、按行收发。
#
# 协议：stdin 每行一个 base64(UTF-8 JSON) 请求，stdout 每行回一个 "DSH:" + base64(UTF-8 JSON) 响应。
# 请求里的路径、文档名一律作为数据处理，不拼进任何命令或脚本文本。
#
# 安全约束（与 desktop-actions.ts 的契约一致）：
# - 只有进程路径对得上的窗口才读标题；对不上的窗口标题不读、不输出。
# - UIA 查找限定在已核验的目标窗口子树内，有深度、节点数与时间上限。
# - 优先用 UIA 读；WPS PDF 的翻页按钮与滚动条不响应 UIA 模式（真机已验证），
#   所以翻页用导航键（Home/End/Left/Right/Up/Down/PageUp/PageDown）。
#   按键只在"前台窗口 = 目标窗口、键盘焦点 = 目标文档视图、没有按住修饰键"时发送，发送后立即复核。
# - 绝不发送字符键，绝不向任何窗口输入文本。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('DshUia.Native' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace DshUia {
public static class Native {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint size);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  public static List<IntPtr> TopWindows() {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static string Title(IntPtr h) { var s = new StringBuilder(1024); GetWindowTextW(h, s, 1024); return s.ToString(); }
  public static string ClassName(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }

  const uint QUERY_LIMITED = 0x1000;
  public static string ProcPath(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "";
    try { var s = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageNameW(h, 0, s, ref n) ? s.ToString() : ""; }
    finally { CloseHandle(h); }
  }
  public static string ProcStart(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "";
    try { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? c.ToString() : ""; }
    finally { CloseHandle(h); }
  }
  public static bool ProcAlive(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return false;
    try { uint code; return GetExitCodeProcess(h, out code) && code == 259; }
    finally { CloseHandle(h); }
  }
  public static bool ModifierHeld() {
    int[] vks = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    foreach (int vk in vks) { if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true; }
    return false;
  }
  // 只允许导航键；字符键在这里就被拒绝，不可能经由本脚本输入文本。
  static readonly ushort[] NavKeys = { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28 };
  public static uint TapNav(ushort vk) {
    if (Array.IndexOf(NavKeys, vk) < 0) throw new ArgumentException("only navigation keys are allowed");
    var a = new INPUT[2];
    ushort scan = (ushort)MapVirtualKeyW(vk, 0);
    a[0].type = 1; a[0].u.ki.wVk = vk; a[0].u.ki.wScan = scan; a[0].u.ki.dwFlags = 1u;
    a[1].type = 1; a[1].u.ki.wVk = vk; a[1].u.ki.wScan = scan; a[1].u.ki.dwFlags = 1u | 2u;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
}
'@
}
[DshUia.Native]::DpiAware()

$AE = [System.Windows.Automation.AutomationElement]
$Walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$VK = @{ PageUp = 0x21; PageDown = 0x22; End = 0x23; Home = 0x24; Left = 0x25; Up = 0x26; Right = 0x27; Down = 0x28 }

# ---------- 通用 ----------

function New-Fail([string]$code, [string]$message, [string]$detail = '') {
  $r = @{ ok = $false; code = $code; message = $message }
  if ($detail -ne '') { $r.detail = $detail }
  return $r
}

function Test-Deadline { if ([DateTime]::UtcNow -gt $script:Deadline) { throw 'DSH_TIMEOUT' } }

function Same-Path([string]$a, [string]$b) { return [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase) }

function Path-Under([string]$file, [string]$dir) {
  if ([string]::IsNullOrEmpty($dir) -or [string]::IsNullOrEmpty($file)) { return $false }
  $d = $dir.Replace('/', '\').TrimEnd('\') + '\'
  return $file.Replace('/', '\').StartsWith($d, [StringComparison]::OrdinalIgnoreCase)
}

function Has-Text([string]$hay, [string]$needle) {
  if ([string]::IsNullOrEmpty($needle)) { return $false }
  return $hay.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

# 有界的子树查找：深度、节点数、截止时间三重上限，避免长时间遍历拖慢目标应用。
function Find-ByClass($root, [string]$cls, [int]$maxDepth = 32, [int]$maxNodes = 2500) {
  $out = New-Object System.Collections.Generic.List[object]
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@($root, 0))
  $n = 0
  while ($stack.Count -gt 0 -and $n -lt $maxNodes) {
    if (($n % 50) -eq 0) { Test-Deadline }
    $pair = $stack.Pop(); $el = $pair[0]; $d = [int]$pair[1]; $n++
    try { if ($el.Current.ClassName -eq $cls) { $out.Add($el); continue } } catch { continue }
    if ($d -ge $maxDepth) { continue }
    try {
      $ch = $Walker.GetFirstChild($el)
      while ($ch -ne $null) { $stack.Push(@($ch, ($d + 1))); $ch = $Walker.GetNextSibling($ch) }
    } catch { }
  }
  return ,$out
}

function Get-Kids($el) {
  $o = New-Object System.Collections.Generic.List[object]
  try { $c = $Walker.GetFirstChild($el); while ($c -ne $null -and $o.Count -lt 200) { $o.Add($c); $c = $Walker.GetNextSibling($c) } } catch { }
  return ,$o
}

function Get-Identity([IntPtr]$h, [string]$documentName) {
  $procId = [DshUia.Native]::Pid($h)
  $id = @{
    platform = 'win32'
    pid = [int]$procId
    windowId = [string]$h.ToInt64()
    title = [DshUia.Native]::Title($h)
    processPath = [DshUia.Native]::ProcPath($procId)
    processStartedAt = [DshUia.Native]::ProcStart($procId)
    className = [DshUia.Native]::ClassName($h)
  }
  if ($documentName) {
    $id.documentName = $documentName
    # 同一个 WPS 窗口切到了别的标签时，标题是用户其他文档的名字：不带出去，只留"已不是这份文档"的事实。
    if (-not (Has-Text $id.title $documentName)) { $id.title = ''; $id.titleRedacted = $true }
  }
  return $id
}

# 前台快照：不读前台窗口标题。
function Get-Foreground([IntPtr]$target, $ownerPids) {
  $fg = [DshUia.Native]::GetForegroundWindow()
  $snap = @{ isTarget = ($fg -eq $target) }
  if ($fg -ne [IntPtr]::Zero) {
    $snap.pid = [int][DshUia.Native]::Pid($fg)
    $root = [DshUia.Native]::GetAncestor($fg, 3)
    $snap.isDialogOfTarget = (($fg -ne $target) -and ($root -eq $target))
    $snap.isOwner = ($ownerPids -contains $snap.pid)
  }
  return $snap
}

# 模态弹窗检测：主窗口被禁用，或存在可见、可用的自有弹窗。
function Get-DialogState([IntPtr]$h, $doc) {
  if (-not [DshUia.Native]::IsWindowEnabled($h)) { return 'main-disabled' }
  $popup = [DshUia.Native]::GetWindow($h, 6)
  if ($popup -ne [IntPtr]::Zero -and $popup -ne $h -and [DshUia.Native]::IsWindowVisible($popup)) { return 'owned-popup' }
  if ($doc -and $doc.hwnd -ne [IntPtr]::Zero -and -not [DshUia.Native]::IsWindowEnabled($doc.hwnd)) { return 'document-disabled' }
  return ''
}

# ---------- WPS PDF 配置档 ----------

# 在已核验的主窗口子树内找目标文档的 PDF 窗口（名称形如 "<文件名> - WPS PDF"）。
function Get-WpsPdfDoc($mainEl, [string]$documentName, [string]$installDir) {
  $cands = Find-ByClass $mainEl 'KxPdfMainWindow' 14 1500
  $matched = @($cands | Where-Object { $_.Current.Name.StartsWith($documentName, [StringComparison]::OrdinalIgnoreCase) })
  if ($matched.Count -eq 0) { return @{ error = 'not-found' } }
  if ($matched.Count -gt 1) { return @{ error = 'ambiguous' } }
  $el = $matched[0]
  $docPid = [uint32]$el.Current.ProcessId
  $docPath = [DshUia.Native]::ProcPath($docPid)
  if (-not (Path-Under $docPath $installDir)) { return @{ error = 'foreign-component' } }
  return @{ el = $el; pid = [int]$docPid; hwnd = [IntPtr]$el.Current.NativeWindowHandle; path = $docPath }
}

function Read-WpsPdfPage($doc) {
  # 同一请求内缓存页码标签元素：轮询读回时不必每次重新遍历子树。
  if ($doc.labelEl) {
    try {
      $raw = [string]$doc.labelEl.Current.Name
      $m = [regex]::Match($raw, '^\s*(\d{1,6})\s*/\s*(\d{1,6})\s*$')
      if ($m.Success) { return @{ page = [int]$m.Groups[1].Value; total = [int]$m.Groups[2].Value; raw = $raw } }
    } catch { }
    $doc.labelEl = $null
  }
  $labels = New-Object System.Collections.Generic.List[object]
  foreach ($bar in (Find-ByClass $doc.el 'KxPdfStatusBar' 8 600)) {
    foreach ($w in (Get-Kids $bar)) {
      if ($w.Current.ClassName -ne 'KxPdfNewPageNumberWidget') { continue }
      foreach ($l in (Get-Kids $w)) { $labels.Add($l) }
    }
  }
  if ($labels.Count -eq 0) {
    foreach ($w in (Find-ByClass $doc.el 'KxPdfNewPageNumberWidget' 24 2000)) {
      foreach ($l in (Get-Kids $w)) { $labels.Add($l) }
    }
  }
  foreach ($l in $labels) {
    $raw = [string]$l.Current.Name
    $m = [regex]::Match($raw, '^\s*(\d{1,6})\s*/\s*(\d{1,6})\s*$')
    if ($m.Success) {
      $doc.labelEl = $l
      return @{ page = [int]$m.Groups[1].Value; total = [int]$m.Groups[2].Value; raw = $raw }
    }
  }
  return $null
}

function Read-WpsPdfScroll($doc) {
  if (-not $doc.scrollEl) {
    foreach ($s in (Find-ByClass $doc.el 'KPdfScrollBarWheelFixed' 24 2000)) { $doc.scrollEl = $s; break }
  }
  if (-not $doc.scrollEl) { return $null }
  $p = $null
  try {
    if ($doc.scrollEl.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$p)) { return [double]$p.Current.Value }
  } catch { $doc.scrollEl = $null }
  return $null
}

# 页码标签刷新略有延迟：轮询到变化后再稳定一拍。
function Wait-PageChange($doc, $prev, [int]$maxMs = 1500) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $last = $prev
  while ($sw.ElapsedMilliseconds -lt $maxMs) {
    Start-Sleep -Milliseconds 80
    $cur = Read-WpsPdfPage $doc
    if ($cur -and $prev -and $cur.page -ne $prev.page) {
      Start-Sleep -Milliseconds 120
      $again = Read-WpsPdfPage $doc
      if ($again) { return $again }
      return $cur
    }
    if ($cur) { $last = $cur }
  }
  return $last
}

# ---------- 目标核验 ----------

# 返回 @{ fail } 或 @{ hwnd; el; identity; doc }。任何一项对不上都拒绝。
function Test-Target($req) {
  $exp = $req.identity
  if (-not $exp) { return @{ fail = (New-Fail 'invalid-argument' '缺少目标窗口身份') } }
  $h = [IntPtr][long]$exp.windowId
  if (-not [DshUia.Native]::IsWindow($h)) {
    $detail = 'window-closed'
    if (-not [DshUia.Native]::ProcAlive([uint32]$exp.pid)) { $detail = 'app-closed' }
    return @{ fail = (New-Fail 'window-not-found' '目标窗口已不存在' $detail) }
  }
  $procId = [DshUia.Native]::Pid($h)
  if ([int]$procId -ne [int]$exp.pid) { return @{ fail = (New-Fail 'identity-changed' '窗口句柄已属于其他进程' 'pid') } }
  $path = [DshUia.Native]::ProcPath($procId)
  if (-not (Same-Path $path $exp.processPath)) { return @{ fail = (New-Fail 'identity-changed' '进程路径与核验时不一致' 'processPath') } }
  if ($exp.processStartedAt -and ([DshUia.Native]::ProcStart($procId) -ne [string]$exp.processStartedAt)) {
    return @{ fail = (New-Fail 'identity-changed' '进程启动时间不一致（pid 被复用）' 'processStartedAt') }
  }
  $id = Get-Identity $h $exp.documentName
  if ($exp.documentName -and -not (Has-Text $id.title $exp.documentName)) {
    return @{ fail = (New-Fail 'identity-changed' '目标窗口当前显示的已不是这份文档' 'document-switched'); identity = $id }
  }
  $el = $AE::FromHandle($h)
  $doc = $null
  if ($req.profile -eq 'wps-pdf') {
    $doc = Get-WpsPdfDoc $el $exp.documentName ([IO.Path]::GetDirectoryName($exp.processPath))
    if ($doc.error -eq 'ambiguous') { return @{ fail = (New-Fail 'ambiguous-window' '同一窗口里有多个同名文档' 'ambiguous'); identity = $id } }
    if ($doc.error -eq 'foreign-component') { return @{ fail = (New-Fail 'identity-changed' '文档组件进程不属于这份 WPS 安装' 'component-path'); identity = $id } }
    if ($doc.error) { return @{ fail = (New-Fail 'window-not-found' '窗口里找不到这份文档的 PDF 视图' 'document-not-loaded'); identity = $id } }
    $id.component = @{ pid = $doc.pid; windowId = [string]$doc.hwnd.ToInt64(); processPath = $doc.path }
  }
  $dialog = Get-DialogState $h $doc
  if ($dialog -ne '') { return @{ fail = (New-Fail 'dialog-blocking' '目标应用有弹窗挡着' $dialog); identity = $id } }
  return @{ hwnd = $h; el = $el; identity = $id; doc = $doc }
}

# 前台必须是目标窗口；前台属于调用方自己时可以交还焦点；其他应用一律不抢。
function Assert-Foreground($t, $ownerPids) {
  $fg = Get-Foreground $t.hwnd $ownerPids
  if ($fg.isTarget) { return @{ snap = $fg } }
  if ($fg.isDialogOfTarget) { return @{ snap = $fg; fail = (New-Fail 'dialog-blocking' '目标应用的弹窗在前台' 'foreground-dialog') } }
  if (-not $fg.isOwner) { return @{ snap = $fg; fail = (New-Fail 'focus-stolen' '前台是其他应用，未操作' 'foreground-other') } }
  if ([DshUia.Native]::IsIconic($t.hwnd)) { [void][DshUia.Native]::ShowWindow($t.hwnd, 9) }
  [void][DshUia.Native]::SetForegroundWindow($t.hwnd)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 1500) {
    if ([DshUia.Native]::GetForegroundWindow() -eq $t.hwnd) { return @{ snap = $fg; reclaimed = $true } }
    Start-Sleep -Milliseconds 60
  }
  return @{ snap = $fg; fail = (New-Fail 'focus-stolen' '系统拒绝把目标窗口切到前台' 'foreground-refused') }
}

function Test-ViewFocused($doc) {
  try { $f = $AE::FocusedElement } catch { return $false }
  if (-not $f) { return $false }
  $c = $f.Current
  if ($c.ClassName -ne 'KxPdfView' -or [int]$c.ProcessId -ne $doc.pid) { return $false }
  $fh = [IntPtr]$c.NativeWindowHandle
  return ($fh -eq $doc.hwnd) -or [DshUia.Native]::IsChild($doc.hwnd, $fh)
}

# 键盘焦点要落在目标文档的视图上；焦点在输入框里（用户可能在打字）就不动它。
function Assert-ViewFocus($doc) {
  if (Test-ViewFocused $doc) { return $null }
  try {
    $f = $AE::FocusedElement
    $ct = $f.Current.ControlType
    if ($ct -eq [System.Windows.Automation.ControlType]::Edit -or $ct -eq [System.Windows.Automation.ControlType]::Document -or $ct -eq [System.Windows.Automation.ControlType]::ComboBox) {
      return (New-Fail 'focus-stolen' '键盘焦点在输入框里，未发送按键' 'focus-in-edit')
    }
  } catch { }
  $views = Find-ByClass $doc.el 'KxPdfView' 24 2000
  if ($views.Count -ne 1) { return (New-Fail 'unsupported' '找不到唯一的文档视图' 'view-not-found') }
  try { $views[0].SetFocus() } catch { }
  Start-Sleep -Milliseconds 150
  if (Test-ViewFocused $doc) { return $null }
  return (New-Fail 'focus-stolen' '无法把键盘焦点放到文档视图' 'view-focus-refused')
}

# 发一个导航键：发之前核对前台与焦点，发之后立即复核。
function Send-NavKey($t, [string]$name) {
  if ([DshUia.Native]::GetForegroundWindow() -ne $t.hwnd) { return (New-Fail 'focus-stolen' '发送按键前前台已变化' 'foreground-changed') }
  if (-not (Test-ViewFocused $t.doc)) { return (New-Fail 'focus-stolen' '发送按键前键盘焦点已离开文档' 'focus-changed') }
  if ([DshUia.Native]::ModifierHeld()) { return (New-Fail 'focus-stolen' '用户正按着修饰键，未发送按键' 'modifier-held') }
  $sent = [DshUia.Native]::TapNav([uint16]$VK[$name])
  if ($sent -ne 2) { return (New-Fail 'failed' '系统未接受按键输入' 'sendinput') }
  if ([DshUia.Native]::GetForegroundWindow() -ne $t.hwnd) { return (New-Fail 'focus-stolen' '按键后前台已变化' 'foreground-changed-after') }
  return $null
}

function Complete-After($t, $r, $ownerPids) {
  $r.foregroundAfter = Get-Foreground $t.hwnd $ownerPids
  if ([DshUia.Native]::IsWindow($t.hwnd)) { $r.after = Get-Identity $t.hwnd $t.identity.documentName }
  return $r
}

# ---------- 操作 ----------

function Op-Locate($req) {
  $items = New-Object System.Collections.Generic.List[object]
  $roots = @('HKCU:\SOFTWARE', 'HKLM:\SOFTWARE', 'HKLM:\SOFTWARE\WOW6432Node')
  foreach ($root in $roots) {
    foreach ($exe in @('wps.exe', 'wpp.exe', 'et.exe', 'wpspdf.exe')) {
      $key = "$root\Microsoft\Windows\CurrentVersion\App Paths\$exe"
      try {
        $p = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        $v = [string]$p.'(default)'
        if ($v) { $items.Add(@{ source = 'app-paths'; key = "$key"; name = $exe; value = [Environment]::ExpandEnvironmentVariables($v.Trim('"')) }) }
      } catch { }
    }
    try {
      $p = Get-ItemProperty -LiteralPath "$root\Kingsoft\Office\6.0\Common" -ErrorAction Stop
      if ($p.InstallRoot) { $items.Add(@{ source = 'kingsoft-common'; key = "$root\Kingsoft\Office\6.0\Common"; name = 'InstallRoot'; value = [string]$p.InstallRoot }) }
    } catch { }
    try {
      foreach ($k in (Get-ChildItem -LiteralPath "$root\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction Stop)) {
        try {
          $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction Stop
          if ([string]$p.DisplayName -match 'WPS Office') {
            $items.Add(@{ source = 'uninstall'; key = [string]$k.Name; name = 'DisplayIcon'; value = ([string]$p.DisplayIcon).Trim('"'); version = [string]$p.DisplayVersion; installLocation = [string]$p.InstallLocation })
          }
        } catch { }
      }
    } catch { }
  }
  return @{ ok = $true; candidates = $items.ToArray() }
}

# 查找：先按进程路径过滤，只有路径对得上的窗口才读标题；对不上的标题不读、不输出。
function Op-Find($req) {
  $q = $req.query
  $paths = @($q.processPaths | Where-Object { $_ })
  $dir = [string]$q.processDir
  $needle = [string]$q.titleIncludes
  if ($paths.Count -eq 0 -and $dir -eq '') { return (New-Fail 'invalid-argument' '查找窗口必须限定进程') }
  $pathCache = @{}
  $found = New-Object System.Collections.Generic.List[object]
  $proxies = 0
  foreach ($h in [DshUia.Native]::TopWindows()) {
    Test-Deadline
    $procId = [DshUia.Native]::Pid($h)
    if ($q.pid -and [int]$procId -ne [int]$q.pid) { continue }
    if (-not $pathCache.ContainsKey($procId)) { $pathCache[$procId] = [DshUia.Native]::ProcPath($procId) }
    $path = $pathCache[$procId]
    $okPath = $false
    foreach ($p in $paths) { if (Same-Path $path $p) { $okPath = $true } }
    if (-not $okPath -and $dir -ne '' -and (Path-Under $path $dir)) { $okPath = $true }
    if (-not $okPath) { continue }
    $title = [DshUia.Native]::Title($h)
    # WPS 每个文档标签有一个隐藏的任务栏代理窗口，标题就是文件名：用来发现同名文档。
    if ($needle -ne '' -and [DshUia.Native]::ClassName($h) -eq 'PROME-TASKBAR' -and [string]::Equals($title, $needle, [StringComparison]::OrdinalIgnoreCase)) { $proxies++ }
    if (-not [DshUia.Native]::IsWindowVisible($h)) { continue }
    if ($needle -ne '' -and -not (Has-Text $title $needle)) { continue }
    $found.Add($h)
  }
  if ($found.Count -eq 0) { return (New-Fail 'window-not-found' '没有找到符合条件的窗口' 'no-match') }
  if ($found.Count -gt 1) { return (New-Fail 'ambiguous-window' "有 $($found.Count) 个窗口符合条件" 'multiple-windows') }
  if ($proxies -gt 1) { return (New-Fail 'ambiguous-window' "有 $proxies 个同名文档标签" 'same-name-tabs') }
  $req2 = @{ identity = (Get-Identity $found[0] $req.documentName); profile = $req.profile }
  $t = Test-Target $req2
  if ($t.fail) { $t.fail.before = $req2.identity; return $t.fail }
  return @{ ok = $true; identity = $t.identity; sameNameTabs = $proxies }
}

function Op-Verify($req) {
  $t = Test-Target $req
  if ($t.fail) { if ($t.identity) { $t.fail.after = $t.identity }; return $t.fail }
  $r = @{ ok = $true; before = $t.identity; after = $t.identity; foregroundBefore = (Get-Foreground $t.hwnd $req.ownerPids) }
  if ($req.profile -eq 'wps-pdf') { $p = Read-WpsPdfPage $t.doc; if ($p) { $r.page = $p.page; $r.total = $p.total; $r.raw = $p.raw } }
  return $r
}

function Op-Focus($req) {
  $t = Test-Target $req
  if ($t.fail) { return $t.fail }
  $r = @{ before = $t.identity; method = 'set-foreground' }
  $a = Assert-Foreground $t $req.ownerPids
  $r.foregroundBefore = $a.snap
  if ($a.fail) { $f = $a.fail; $f.before = $t.identity; return (Complete-After $t $f $req.ownerPids) }
  if (-not $a.reclaimed) { $r.method = 'already-foreground' }
  $t2 = Test-Target $req
  if ($t2.fail) { $t2.fail.before = $t.identity; return $t2.fail }
  $r.ok = $true
  return (Complete-After $t $r $req.ownerPids)
}

function Op-ReadPage($req) {
  $t = Test-Target $req
  if ($t.fail) { return $t.fail }
  $p = Read-WpsPdfPage $t.doc
  if (-not $p) { return (New-Fail 'unsupported' '这个 WPS 版本没有暴露可读的页码控件' 'page-label-missing') }
  $r = @{ ok = $true; before = $t.identity; page = $p.page; total = $p.total; raw = $p.raw; method = 'uia-read'; foregroundBefore = (Get-Foreground $t.hwnd $req.ownerPids) }
  $s = Read-WpsPdfScroll $t.doc
  if ($s -ne $null) { $r.scrollValue = $s }
  return (Complete-After $t $r $req.ownerPids)
}

# 进入"可以发键"状态：核验目标、前台、键盘焦点。
function Enter-KeyMode($req) {
  $t = Test-Target $req
  if ($t.fail) { return @{ fail = $t.fail } }
  $a = Assert-Foreground $t $req.ownerPids
  if ($a.fail) { $f = $a.fail; $f.before = $t.identity; $f.foregroundBefore = $a.snap; return @{ fail = $f } }
  if ($a.reclaimed) { $t = Test-Target $req; if ($t.fail) { return @{ fail = $t.fail } } }
  $vf = Assert-ViewFocus $t.doc
  if ($vf) { $vf.before = $t.identity; $vf.foregroundBefore = $a.snap; return @{ fail = $vf } }
  return @{ t = $t; snap = $a.snap }
}

function Op-GotoPage($req) {
  $target = [int]$req.page
  $k = Enter-KeyMode $req
  if ($k.fail) { return $k.fail }
  $t = $k.t
  $cur = Read-WpsPdfPage $t.doc
  if (-not $cur) { return (New-Fail 'unsupported' '读不到页码，无法确认跳页结果' 'page-label-missing') }
  if ($target -lt 1 -or $target -gt $cur.total) { return (New-Fail 'invalid-argument' "页码超出范围 1..$($cur.total)") }
  $r = @{ before = $t.identity; foregroundBefore = $k.snap; pageBefore = @{ page = $cur.page; total = $cur.total } }
  $steps = New-Object System.Collections.Generic.List[string]
  $keys = 0
  $round = 0
  $stalled = 0
  while ($cur.page -ne $target -and $round -lt 12) {
    $round++
    $delta = $target - $cur.page
    $plan = @()
    if ($target -eq 1) { $plan = @('Home') }
    elseif ($target -eq $cur.total) { $plan = @('End') }
    elseif ([Math]::Abs($delta) -gt ($target - 1) + 1 -and $round -eq 1) { $plan = @('Home') }
    elseif ([Math]::Abs($delta) -gt ($cur.total - $target) + 1 -and $round -eq 1) { $plan = @('End') }
    else {
      $name = 'Right'; if ($delta -lt 0) { $name = 'Left' }
      $n = [Math]::Min([Math]::Abs($delta), 10)
      $plan = @(1..$n | ForEach-Object { $name })
    }
    foreach ($key in $plan) {
      $e = Send-NavKey $t $key
      if ($e) { $e.steps = $steps.ToArray(); $e.before = $t.identity; return (Complete-After $t $e $req.ownerPids) }
      $keys++
      Start-Sleep -Milliseconds 40
    }
    $prev = $cur
    $cur = Wait-PageChange $t.doc $prev
    if (-not $cur) { $e = New-Fail 'failed' '按键后读不到页码' 'page-label-lost'; $e.steps = $steps.ToArray(); return (Complete-After $t $e $req.ownerPids) }
    $steps.Add("$($plan[0])x$($plan.Count)->$($cur.page)/$($cur.total)")
    # 连续两轮按键都没让页码变化：按键对这个视图无效，停下来如实报告，不继续盲按。
    if ($cur.page -eq $prev.page) { $stalled++ } else { $stalled = 0 }
    if ($stalled -ge 2) { break }
    Test-Deadline
  }
  $t2 = Test-Target $req
  if ($t2.fail) { $t2.fail.steps = $steps.ToArray(); $t2.fail.before = $t.identity; return $t2.fail }
  $r.steps = $steps.ToArray()
  $r.page = $cur.page; $r.total = $cur.total; $r.raw = $cur.raw
  $r.method = "key-nav x$keys"
  $s = Read-WpsPdfScroll $t.doc
  if ($s -ne $null) { $r.scrollValue = $s }
  if ($cur.page -ne $target) { $r.ok = $false; $r.code = 'failed'; $r.message = "读回第 $($cur.page) 页，不是目标第 $target 页"; $r.detail = 'readback-mismatch' }
  else { $r.ok = $true }
  return (Complete-After $t $r $req.ownerPids)
}

function Op-Scroll($req) {
  $count = [Math]::Max(1, [Math]::Min(10, [int]$req.count))
  $name = switch ("$($req.unit)-$($req.direction)") { 'line-down' { 'Down' } 'line-up' { 'Up' } 'page-down' { 'PageDown' } 'page-up' { 'PageUp' } default { '' } }
  if ($name -eq '') { return (New-Fail 'invalid-argument' '滚动方向或单位不合法') }
  $k = Enter-KeyMode $req
  if ($k.fail) { return $k.fail }
  $t = $k.t
  $cur = Read-WpsPdfPage $t.doc
  if (-not $cur) { return (New-Fail 'unsupported' '读不到页码，无法确认滚动结果' 'page-label-missing') }
  $s0 = Read-WpsPdfScroll $t.doc
  $r = @{ before = $t.identity; foregroundBefore = $k.snap; pageBefore = @{ page = $cur.page; total = $cur.total } }
  for ($i = 0; $i -lt $count; $i++) {
    $e = Send-NavKey $t $name
    if ($e) { $e.before = $t.identity; return (Complete-After $t $e $req.ownerPids) }
    Start-Sleep -Milliseconds 40
  }
  Start-Sleep -Milliseconds 350
  $after = Read-WpsPdfPage $t.doc
  $s1 = Read-WpsPdfScroll $t.doc
  $t2 = Test-Target $req
  if ($t2.fail) { $t2.fail.before = $t.identity; return $t2.fail }
  if (-not $after) { return (New-Fail 'failed' '滚动后读不到页码' 'page-label-lost') }
  $r.page = $after.page; $r.total = $after.total; $r.raw = $after.raw
  $r.method = "key-$name x$count"
  if ($s0 -ne $null) { $r.scrollValueBefore = $s0 }
  if ($s1 -ne $null) { $r.scrollValueAfter = $s1; $r.scrollValue = $s1 }
  $r.moved = ($after.page -ne $cur.page) -or ($s0 -ne $null -and $s1 -ne $null -and $s0 -ne $s1)
  $r.atBoundary = (($req.direction -eq 'down') -and ($after.page -eq $after.total)) -or (($req.direction -eq 'up') -and ($after.page -eq 1))
  if (-not $r.moved -and -not $r.atBoundary) { $r.ok = $false; $r.code = 'failed'; $r.message = '按键后页码与滚动位置都没有变化'; $r.detail = 'no-movement' }
  else { $r.ok = $true }
  return (Complete-After $t $r $req.ownerPids)
}

function Op-ReadText($req) {
  if (-not $req.authorized) { return (New-Fail 'not-authorized' '读取可见文字需要调用方授权') }
  $t = Test-Target $req
  if ($t.fail) { return $t.fail }
  $root = $t.el
  if ($req.profile -eq 'wps-pdf') {
    $views = Find-ByClass $t.doc.el 'KxPdfView' 24 2000
    if ($views.Count -ne 1) { return (New-Fail 'unsupported' '找不到文档视图' 'view-not-found') }
    $root = $views[0]
  }
  $max = [Math]::Max(100, [Math]::Min(50000, [int]$req.maxChars))
  $sb = New-Object System.Text.StringBuilder
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@($root, 0))
  $n = 0
  while ($stack.Count -gt 0 -and $n -lt 1500 -and $sb.Length -lt $max) {
    if (($n % 50) -eq 0) { Test-Deadline }
    $pair = $stack.Pop(); $el = $pair[0]; $d = [int]$pair[1]; $n++
    $tp = $null
    try {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        [void]$sb.Append($tp.DocumentRange.GetText($max - $sb.Length)).Append("`n")
        continue
      }
    } catch { }
    if ($d -ge 20) { continue }
    try { $ch = $Walker.GetFirstChild($el); while ($ch -ne $null) { $stack.Push(@($ch, ($d + 1))); $ch = $Walker.GetNextSibling($ch) } } catch { }
  }
  $text = $sb.ToString().Trim()
  if ($text -eq '') { return (New-Fail 'unsupported' '这个窗口没有通过 UI Automation 暴露正文文字' 'no-text-pattern') }
  $r = @{ ok = $true; before = $t.identity; text = $text; truncated = ($sb.Length -ge $max); method = 'uia-textpattern' }
  return (Complete-After $t $r $req.ownerPids)
}

function Op-ReadForegroundText($req) {
  if (-not $req.authorized) { return (New-Fail 'not-authorized' '读取可见文字需要调用方授权') }
  $h = [DshUia.Native]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return (New-Fail 'unsupported' '现在没有可读的前台窗口' 'no-foreground') }
  # 前台是本进程时读到的是宠物自己的界面，记下来毫无意义，还会把气泡里的私事存成"工作证据"。
  $fgPid = [DshUia.Native]::Pid($h)
  if ([int]$fgPid -eq [int]$PID -or [int]$fgPid -eq [int]$req.ownerPid) {
    return (New-Fail 'invalid-argument' '前台是宠物自己的窗口，不记为工作证据' 'own-window')
  }
  # 用前台窗口现算一份身份，之后完全走 Op-ReadText 的同一套校验与遍历：
  # 不另写一份读法，免得两条路的判定（已关闭/身份变了/没有 TextPattern）慢慢走偏。
  #
  # 注意不能写 $req.identity = ...：$req 是 ConvertFrom-Json 出来的 PSCustomObject，
  # 给它加一个不存在的属性会抛「在此对象上找不到属性 identity」。所以新建一个转发对象。
  $relay = @{
    authorized = $req.authorized
    maxChars = $req.maxChars
    profile = $req.profile
    ownerPids = $req.ownerPids
    ownerPid = $req.ownerPid
    identity = (Get-Identity $h $null)
  }
  return (Op-ReadText $relay)
}

function Invoke-Request($req) {
  $script:Deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1000, [Math]::Min(60000, [int]$req.timeoutMs)))
  switch ([string]$req.op) {
    'ping' { return @{ ok = $true } }
    'locate-wps' { return (Op-Locate $req) }
    'find' { return (Op-Find $req) }
    'verify' { return (Op-Verify $req) }
    'focus' { return (Op-Focus $req) }
    'read-page' { return (Op-ReadPage $req) }
    'goto-page' { return (Op-GotoPage $req) }
    'scroll' { return (Op-Scroll $req) }
    'read-text' { return (Op-ReadText $req) }
    'read-foreground-text' { return (Op-ReadForegroundText $req) }
    default { return (New-Fail 'invalid-argument' '未知操作') }
  }
}

$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($line -eq $null) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $id = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $id = $req.id
    if ($req.profile -and $req.profile -ne 'wps-pdf') { $resp = New-Fail 'unsupported' '未知的语义配置档' }
    else { $resp = Invoke-Request $req }
  } catch {
    if ("$($_.Exception.Message)" -eq 'DSH_TIMEOUT') { $resp = New-Fail 'timeout' '操作超过时间上限，已停止' }
    else { $resp = New-Fail 'failed' ("辅助脚本异常：" + $_.Exception.Message) }
  }
  $resp.id = $id
  $resp.elapsedMs = [int]$sw.ElapsedMilliseconds
  $json = ConvertTo-Json -InputObject $resp -Compress -Depth 8
  [Console]::Out.WriteLine('DSH:' + [Convert]::ToBase64String($utf8.GetBytes($json)))
  [Console]::Out.Flush()
}
