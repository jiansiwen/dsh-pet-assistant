# 只处理标准输入中的固定目标；读取与动作前后都复核前台窗口和控件，不主动抢焦点。
param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MONITORINFOEX {
    public int size; public RECT monitor, work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string device;
  }
  public class Display {
    public string name; public int left, top, width, height; public bool primary;
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  static bool dpiAccurate;
  public static void DpiAware() {
    try { dpiAccurate = SetProcessDpiAwarenessContext(new IntPtr(-4)) || GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) == 2; }
    catch { dpiAccurate = false; }
  }
  public static bool AccurateDpi() { return dpiAccurate; }
  public static Display[] Displays() {
    var displays = new List<Display>();
    MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data) {
      var info = new MONITORINFOEX(); info.size = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfoW(monitor, ref info)) return false;
      displays.Add(new Display { name = info.device, left = info.monitor.Left, top = info.monitor.Top,
        width = info.monitor.Right - info.monitor.Left, height = info.monitor.Bottom - info.monitor.Top, primary = (info.flags & 1) != 0 });
      return true;
    };
    bool ok = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    if (!ok || displays.Count == 0 || displays.Count > 16) throw new InvalidOperationException("无法核验显示器布局");
    displays.Sort((a, b) => StringComparer.Ordinal.Compare(a.name, b.name));
    return displays.ToArray();
  }
  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static string Title(IntPtr h) { var s = new StringBuilder(2048); GetWindowTextW(h, s, s.Capacity); return s.ToString(); }
  public static string ClassName(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, s.Capacity); return s.ToString(); }
  public static IntPtr TopAt(int x, int y) { return GetAncestor(WindowFromPoint(new POINT { X=x, Y=y }), 2); }
  public static bool ModifierHeld() { foreach (int vk in new [] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true; return false; }
  public static uint SendUnicode(char c) {
    var a = new INPUT[2];
    a[0].type = 1; a[0].data.key.scan = c; a[0].data.key.flags = 4;
    a[1].type = 1; a[1].data.key.scan = c; a[1].data.key.flags = 4 | 2;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Click() {
    var a = new INPUT[2]; a[0].type = 0; a[0].data.mouse.flags = 2; a[1].type = 0; a[1].data.mouse.flags = 4;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Wheel(int delta) {
    var a = new INPUT[1]; a[0].type = 0; a[0].data.mouse.flags = 0x0800; a[0].data.mouse.data = unchecked((uint)delta);
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[NativeInput]::DpiAware()
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$action = [string]$req.action
$mayHaveExecuted = $false
$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

function Identity([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or -not [NativeInput]::IsWindow($h) -or -not [NativeInput]::IsWindowVisible($h) -or
      [NativeInput]::IsIconic($h) -or -not [NativeInput]::IsWindowEnabled($h)) { throw '目标窗口不存在、不可见、最小化或被弹窗阻挡' }
  $procId = [NativeInput]::Pid($h)
  if ($procId -eq 0) { throw '无法确定窗口进程' }
  $proc = [Diagnostics.Process]::GetProcessById([int]$procId)
  try { $procPath = [string]$proc.MainModule.FileName; $started = [string]$proc.StartTime.ToUniversalTime().Ticks }
  finally { $proc.Dispose() }
  $title = [NativeInput]::Title($h); $className = [NativeInput]::ClassName($h)
  $bounds = New-Object NativeInput+RECT
  if (-not [NativeInput]::GetWindowRect($h, [ref]$bounds) -or [string]::IsNullOrWhiteSpace($procPath) -or
      [string]::IsNullOrWhiteSpace($started) -or [string]::IsNullOrWhiteSpace($title) -or [string]::IsNullOrWhiteSpace($className)) {
    throw '窗口身份或位置不完整，不能猜测'
  }
  return @{ windowId = [string]$h.ToInt64(); pid = [int]$procId; processPath = $procPath; processStartedAt = $started;
    className = $className; title = $title; left = $bounds.Left; top = $bounds.Top;
    width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top }
}

function Check-Target($expected) {
  if (-not $expected -or [string]::IsNullOrWhiteSpace([string]$expected.windowId)) { throw '缺少已批准的目标窗口' }
  $h = [IntPtr][long]$expected.windowId
  if ([NativeInput]::GetForegroundWindow() -ne $h) { throw '前台窗口已变化，请切回原目标；未抢焦点' }
  $actual = Identity $h
  if ($actual.windowId -ne [string]$expected.windowId -or $actual.pid -ne [int]$expected.pid -or
      -not [string]::Equals($actual.processPath, [string]$expected.processPath, [StringComparison]::OrdinalIgnoreCase) -or
      $actual.processStartedAt -ne [string]$expected.processStartedAt -or $actual.className -cne [string]$expected.className -or
      $actual.title -cne [string]$expected.title -or $actual.left -ne [int]$expected.left -or $actual.top -ne [int]$expected.top -or
      $actual.width -ne [int]$expected.width -or $actual.height -ne [int]$expected.height) { throw '窗口身份、内容标题或位置已变化' }
  if ([NativeInput]::GetForegroundWindow() -ne $h) { throw '核对期间前台窗口已变化' }
  return $actual
}

function Get-ScreenLayout {
  if (-not [NativeInput]::AccurateDpi()) { throw '系统未能提供准确的屏幕像素坐标，未截屏' }
  $displays = @([NativeInput]::Displays() | ForEach-Object {
    @{ name = $_.name; left = $_.left; top = $_.top; width = $_.width; height = $_.height; primary = $_.primary }
  })
  return @{ left = [NativeInput]::GetSystemMetrics(76); top = [NativeInput]::GetSystemMetrics(77);
    width = [NativeInput]::GetSystemMetrics(78); height = [NativeInput]::GetSystemMetrics(79); displays = $displays }
}

function Check-Screen($expected) {
  if (-not $expected -or @($expected.displays).Count -lt 1) { throw '缺少已批准的显示器范围' }
  $actual = Get-ScreenLayout
  if ($actual.left -ne [int]$expected.left -or $actual.top -ne [int]$expected.top -or
      $actual.width -ne [int]$expected.width -or $actual.height -ne [int]$expected.height -or
      @($actual.displays).Count -ne @($expected.displays).Count) { throw '显示器范围已变化，未继续' }
  for ($i = 0; $i -lt @($actual.displays).Count; $i++) {
    $a = $actual.displays[$i]; $b = $expected.displays[$i]
    if ($a.name -cne [string]$b.name -or $a.left -ne [int]$b.left -or $a.top -ne [int]$b.top -or
        $a.width -ne [int]$b.width -or $a.height -ne [int]$b.height -or $a.primary -ne [bool]$b.primary) {
      throw '显示器身份或布局已变化，未继续'
    }
  }
  return $actual
}

function Capture-Screen($expectedTarget, $expectedScreen, [int]$maxBytes) {
  $identity = Check-Target $expectedTarget
  $screen = Check-Screen $expectedScreen
  $width = [int]$screen.width; $height = [int]$screen.height
  if ($width -lt 1 -or $height -lt 1 -or $width -gt 8192 -or $height -gt 8192 -or
      ([long]$width * [long]$height) -gt 24000000 -or $maxBytes -lt 1 -or $maxBytes -gt 8000000) { throw '截图范围或大小限制无效' }
  $bitmap = $null; $graphics = $null; $memory = $null; $bytes = $null
  try {
    # 屏幕没有透明通道；使用 RGB 避免 GDI 拷贝后的透明度让画面变成全透明。
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([int]$screen.left, [int]$screen.top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $memory = [System.IO.MemoryStream]::new()
    $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($memory.Length -gt $maxBytes) { throw '截图超过附件大小上限，未保存或发送' }
    $bytes = $memory.ToArray()
    # 前台或显示器在截取期间变化时，不输出图片。
    $identity = Check-Target $expectedTarget
    $screen = Check-Screen $expectedScreen
    return @{ ok = $true; action = 'look'; target = $identity; screen = $screen; pngBase64 = [Convert]::ToBase64String($bytes) }
  } finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($memory) { $memory.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
  }
}

function Element-InWindow($element, [IntPtr]$h) {
  $root = $AE::FromHandle($h)
  if (-not $root -or -not $element) { return $false }
  $rootId = ($root.GetRuntimeId() -join ',')
  if ([string]::IsNullOrWhiteSpace($rootId)) { return $false }
  $node = $element
  for ($i = 0; $i -lt 100 -and $node; $i++) {
    if (($node.GetRuntimeId() -join ',') -ceq $rootId) { return $true }
    $node = $walker.GetParent($node)
  }
  return $false
}

function Probe($identity, [string]$kind) {
  $h = [IntPtr][long]$identity.windowId
  if ($kind -eq 'click' -or $kind -eq 'scroll') {
    $x = [int]$req.x; $y = [int]$req.y
    if ($x -lt $identity.left -or $y -lt $identity.top -or $x -ge ($identity.left + $identity.width) -or $y -ge ($identity.top + $identity.height)) { throw '坐标不在目标窗口内' }
    if ([NativeInput]::TopAt($x, $y) -ne $h) { throw '坐标位置被其他窗口遮挡，未操作' }
    $point = New-Object System.Windows.Point -ArgumentList $x, $y
    $element = $AE::FromPoint($point)
  } elseif ($kind -eq 'type' -or $kind -eq 'key') { $element = $AE::FocusedElement }
  else { throw '不支持的控件探测类型' }
  if (-not (Element-InWindow $element $h)) { throw '焦点或坐标不属于目标窗口' }
  $c = $element.Current
  if ($c.IsOffscreen -or -not $c.IsEnabled) { throw '目标控件不可见或不可用' }
  $ids = @($element.GetRuntimeId())
  $r = $c.BoundingRectangle
  if ($ids.Count -eq 0 -or $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { throw '控件身份或位置不完整' }
  $name = [string]$c.Name
  if ($name.Length -gt 500) { $name = $name.Substring(0, 500) }
  return @{ runtimeId = @($ids); name = $name; type = [string]$c.ControlType.ProgrammaticName; className = [string]$c.ClassName;
    left = [int]$r.X; top = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height; isPassword = [bool]$c.IsPassword }
}

function Check-Control($expected, $actual) {
  if (-not $expected -or -not $actual -or (($expected.runtimeId -join ',') -cne ($actual.runtimeId -join ',')) -or
      [string]$expected.name -cne $actual.name -or [string]$expected.type -cne $actual.type -or
      [string]$expected.className -cne $actual.className -or [bool]$expected.isPassword -ne $actual.isPassword -or
      [int]$expected.left -ne $actual.left -or [int]$expected.top -ne $actual.top -or
      [int]$expected.width -ne $actual.width -or [int]$expected.height -ne $actual.height) { throw '目标控件已变化，未继续操作' }
}

<#
 按 runtimeId 在目标窗口里找回控件。

 为什么不用坐标：坐标会随滚动/布局变化，而且点坐标必然要抢鼠标。
 runtimeId 是 UIA 给出的稳定身份，同一个控件在多次调用之间不变。
 代价是要走一遍控件树（有节点上限），但几百个节点通常在几十毫秒量级。
#>
function Find-Control($identity, $expected) {
  $h = [IntPtr][long]$identity.windowId
  $root = $AE::FromHandle($h)
  if (-not $root) { throw '目标窗口不支持读取控件' }
  $want = (@($expected.runtimeId) -join ',')
  if (-not $want) { throw '缺少控件身份，请先 look 取得编号' }
  $seen = 0
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push($root)
  while ($stack.Count -gt 0 -and $seen -lt 6000) {
    $node = $stack.Pop()
    $seen = $seen + 1
    try { $ids = @($node.GetRuntimeId()) } catch { continue }
    if (($ids -join ',') -ceq $want) {
      if (-not (Element-InWindow $node $h)) { throw '控件不在目标窗口内，未操作' }
      $c = $node.Current
      if ($c.IsOffscreen -or -not $c.IsEnabled) { throw '目标控件不可见或不可用' }
      return $node
    }
    try {
      $child = $walker.GetFirstChild($node)
      while ($null -ne $child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
    } catch { }
  }
  throw '找不到这个控件：界面可能已经变了，请重新 look'
}

$script:tree = New-Object 'System.Collections.Generic.List[string]'
# 与 tree 逐行对齐的控件身份，供"不动鼠标"的元素级操作按编号引用。
$script:elements = New-Object 'System.Collections.Generic.List[object]'
$script:truncated = $false
function Walk($element, [int]$depth, [int]$maxDepth, [int]$limit) {
  if ($depth -gt $maxDepth) {
    try { if ($walker.GetFirstChild($element)) { $script:truncated = $true } } catch { $script:truncated = $true }
    return
  }
  try { $child = $walker.GetFirstChild($element) } catch { $script:truncated = $true; return }
  while ($null -ne $child) {
    if ($script:tree.Count -ge $limit) { $script:truncated = $true; return }
    try {
      $c = $child.Current
      if (-not $c.IsOffscreen) {
        $name = if ($c.IsPassword) { '受保护输入' } else { ([string]$c.Name).Trim() }
        if ($name.Length -gt 120) { $name = $name.Substring(0, 120) + '…'; $script:truncated = $true }
        $r = $c.BoundingRectangle
        if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) {
          <#
            编号只在**真的进了身份表**时分配。

            曾经的写法是先取 `$script:elements.Count` 当编号、再判断要不要入表，
            于是密码控件（不入表）也占掉一个编号 —— 之后按编号操作会落到**另一个控件**上。
            这种错位不会报错，只会点错东西，所以没拿到身份时统一标 `[-]`。
          #>
          $ids = @($child.GetRuntimeId())
          $label = '[-]'
          if ($ids.Count -gt 0 -and -not $c.IsPassword) {
            $shortName = ([string]$c.Name).Trim()
            if ($shortName.Length -gt 200) { $shortName = $shortName.Substring(0, 200) }
            $label = '[' + $script:elements.Count + ']'
            # 带上位置与密码标记：与 probe 返回的控件身份同形，执行前的 Check-Control 才能逐字段比对。
            $script:elements.Add(@{ runtimeId = @($ids); name = $shortName
              type = [string]$c.ControlType.ProgrammaticName; className = [string]$c.ClassName
              left = [int]$r.X; top = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height
              isPassword = [bool]$c.IsPassword })
          }
          $script:tree.Add(('{0}{1} {2} "{3}" @({4},{5},{6}x{7})' -f ('  ' * $depth), $label, $c.ControlType.ProgrammaticName, $name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height))
          if (-not $c.IsPassword) { Walk $child ($depth + 1) $maxDepth $limit }
        }
      }
      $next = $walker.GetNextSibling($child)
    } catch { $script:truncated = $true; return }
    $child = $next
  }
}

try {
  switch ($action) {
    'snapshot' {
      $h = [NativeInput]::GetForegroundWindow()
      $identity = Identity $h
      if (@($req.excludedPids) -contains $identity.pid -or [NativeInput]::GetForegroundWindow() -ne $h) { throw '前台是助理自身或窗口正在变化' }
      $result = @{ ok = $true; action = $action; target = $identity }
      if ($req.screenshot -eq $true) {
        $result.screen = Get-ScreenLayout
        if ([NativeInput]::GetForegroundWindow() -ne $h) { throw '核对显示器期间前台窗口已变化' }
      }
    }
    'look' {
      if ($req.screenshot -eq $true) {
        $result = Capture-Screen $req.target $req.screen ([int]$req.maxBytes)
        break
      }
      $identity = Check-Target $req.target
      $root = $AE::FromHandle([IntPtr][long]$identity.windowId)
      if (-not $root) { throw '目标窗口不支持读取控件' }
      <#
        网页页面模式：直接把根定位到网页文档（Document），跳过浏览器自己的工具栏、标签栏、地址栏。

        作用不止"少几行"：页面内容的控件是网页元素（按钮/输入框/链接），
        模型按名字就能认出"提交按钮"，不必再根据坐标猜。

        仍然走 UIA，而不是 CDP —— Chrome/Edge 只有在**带 --remote-debugging-port 启动**时才有调试端口，
        对着一个已经在跑的浏览器我们接不上；而 UIA 对正在跑的页面本来就能读到结构。
      #>
      if ($req.webOnly -eq $true) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
        $doc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if (-not $doc) { throw '这个窗口里没有网页文档区域：可能不是浏览器、页面还没加载完，或该应用的网页内容没有暴露无障碍结构（部分 Chromium/Electron 窗口就是这样）' }
        $root = $doc
      }
      if (-not $root) { throw '目标窗口不支持读取控件' }
      $depth = [int]$req.maxDepth; $limit = [int]$req.limit
      if ($depth -lt 1 -or $depth -gt 8 -or $limit -lt 1 -or $limit -gt 150) { throw '读取范围无效' }
      Walk $root 0 $depth $limit
      $identity = Check-Target $req.target
      $result = @{ ok = $true; action = $action; target = $identity; tree = @($script:tree.ToArray())
        elements = @($script:elements.ToArray()); truncated = $script:truncated }
    }
    'probe' {
      $identity = Check-Target $req.target
      $control = Probe $identity ([string]$req.kind)
      $identity = Check-Target $req.target
      $result = @{ ok = $true; action = $action; target = $identity; control = $control }
    }
    { $_ -in @('click', 'scroll', 'type', 'key') } {
      $identity = Check-Target $req.target
      $before = Probe $identity $action
      Check-Control $req.control $before
      if ($before.isPassword -and ($action -eq 'type' -or $action -eq 'key')) { throw '受保护的密码控件不能输入' }
      if ([NativeInput]::ModifierHeld()) { throw '用户正按着修饰键，未操作' }
      $h = [IntPtr][long]$identity.windowId
      switch ($action) {
        'type' {
          $text = [string]$req.text
          if (-not $text -or $text.Length -gt 4000 -or $text -match '[\x00-\x1f\x7f-\x9f]') { throw '普通输入内容无效' }
          foreach ($char in $text.ToCharArray()) {
            [void](Check-Target $req.target)
            $current = Probe $identity 'type'
            if (($current.runtimeId -join ',') -cne ($before.runtimeId -join ',') -or $current.isPassword) { throw '输入期间键盘焦点已变化' }
            if ([NativeInput]::ModifierHeld()) { throw '输入期间用户按下了修饰键，已停止' }
            $mayHaveExecuted = $true
            if ([NativeInput]::SendUnicode($char) -ne 2) { throw '系统未完整接收文字输入' }
          }
        }
        'key' {
          $keys = [string]$req.keys
          if ($keys -notmatch '^(\^|%|\+){0,3}([a-z0-9]|\{(ENTER|ESC|TAB|BACKSPACE|DELETE|UP|DOWN|LEFT|RIGHT|HOME|END|PGUP|PGDN|F([1-9]|1[0-2]))\})$') { throw '不支持的按键序列' }
          [void](Check-Target $req.target)
          Check-Control $req.control (Probe $identity 'key')
          if ([NativeInput]::ModifierHeld()) { throw '用户正按着修饰键，未发送按键' }
          $mayHaveExecuted = $true
          [System.Windows.Forms.SendKeys]::SendWait($keys)
        }
        { $_ -in @('click', 'scroll') } {
          $x = [int]$req.x; $y = [int]$req.y
          if ($action -eq 'scroll' -and ([int]$req.amount -eq 0 -or [Math]::Abs([int]$req.amount) -gt 10)) { throw '滚动格数无效' }
          $mayHaveExecuted = $true
          if (-not [NativeInput]::SetCursorPos($x, $y)) { throw '系统未能移动指针' }
          [void](Check-Target $req.target)
          Check-Control $req.control (Probe $identity $action)
          if ([NativeInput]::ModifierHeld()) { throw '用户正按着修饰键，未继续操作' }
          if ($action -eq 'click') {
            if ([NativeInput]::Click() -ne 2) { throw '系统未完整接收点击' }
          } else {
            $amount = [int]$req.amount
            if ([NativeInput]::Wheel(-$amount * 120) -ne 1) { throw '系统未接收滚动' }
          }
        }
      }
      $identity = Check-Target $req.target
      $after = $null
      try { $after = Probe $identity $action } catch { }
      $result = @{ ok = $true; action = $action; target = $identity; before = $before; after = $after; verified = $false }
    }
    { $_ -in @('invoke', 'setvalue') } {
      <#
        元素级操作：**不移动鼠标、不抢键盘焦点**。

        这是"操作电脑"里质量最高的一层：UIA 直接让控件执行它自己的动作，
        失败会抛异常（不像点坐标那样"点了没反应也不知道"）。
        代价是只有支持对应 Pattern 的控件才行 —— 不支持就如实拒绝，
        并告诉调用方改用 click，而不是偷偷降级成点坐标。
      #>
      $identity = Check-Target $req.target
      $element = Find-Control $identity $req.control
      if ([NativeInput]::ModifierHeld()) { throw '用户正按着修饰键，未操作' }
      $c = $element.Current
      $pattern = ''
      if ($action -eq 'invoke') {
        $mayHaveExecuted = $true
        try { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $pattern = 'InvokePattern' }
        catch {
          try { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $pattern = 'TogglePattern' }
          catch {
            try { $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $pattern = 'SelectionItemPattern' }
            catch { throw '这个控件不支持无鼠标操作（没有 Invoke/Toggle/Select 模式），请改用 click 按坐标点击' }
          }
        }
      } else {
        if ($c.IsPassword) { throw '受保护的密码控件不能写入' }
        if ($c.IsReadOnly) { throw '这个控件是只读的，不能写入' }
        $text = [string]$req.text
        if ($text.Length -gt 4000 -or $text -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]') { throw '写入内容无效' }
        $mayHaveExecuted = $true
        $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text)
        $pattern = 'ValuePattern'
      }
      $identity = Check-Target $req.target
      # 明确指出鼠标没动：调用方与用户都能据此判断"没抢你的桌面"。
      $result = @{ ok = $true; action = $action; target = $identity; pattern = $pattern
        mouseMoved = $false; control = @{ runtimeId = @($req.control.runtimeId); name = [string]$c.Name
          type = [string]$c.ControlType.ProgrammaticName }; verified = $false }
    }
    default { throw '不支持的电脑操作' }
  }
} catch {
  $result = @{ ok = $false; action = $action; error = $_.Exception.Message; mayHaveExecuted = $mayHaveExecuted }
}
$result | ConvertTo-Json -Depth 20 -Compress
