# 通用电脑操作助手脚本：读前台窗口/控件树/截图，模拟点击、输入、按键、滚动。
# 只接受标准输入里的 JSON，输出一行 JSON；不写入任何日志文件。
param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$action = [string]$req.action
$result = @{ ok = $true; action = $action }

function Get-Foreground {
  $h = [NativeInput]::GetForegroundWindow()
  $len = [NativeInput]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][NativeInput]::GetWindowText($h, $sb, $sb.Capacity)
  $rect = New-Object NativeInput+RECT
  [void][NativeInput]::GetWindowRect($h, [ref]$rect)
  return @{ handle = [long]$h; title = $sb.ToString(); left = $rect.Left; top = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
}

function Get-Tree($element, $depth, $maxDepth, $limit) {
  $lines = New-Object System.Collections.Generic.List[string]
  if ($depth -gt $maxDepth -or $lines.Count -ge $limit) { return $lines }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($element)
  while ($null -ne $child -and $lines.Count -lt $limit) {
    try {
      $c = $child.Current
      $name = ([string]$c.Name).Trim()
      if ($name.Length -gt 120) { $name = $name.Substring(0, 120) + '…' }
      $rect = $c.BoundingRectangle
      $line = ('{0}{1} [{2}] "{3}" @({4},{5},{6}x{7})' -f ('  ' * $depth), $c.ControlType.ProgrammaticName.Replace('ControlType.', ''), $c.AutomationId, $name, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
      $lines.Add($line)
      foreach ($item in (Get-Tree $child ($depth + 1) $maxDepth ($limit - $lines.Count))) { $lines.Add($item) }
    } catch { }
    $child = $walker.GetNextSibling($child)
  }
  return $lines
}

try {
  switch ($action) {
    'look' {
      $fg = Get-Foreground
      $result.foreground = $fg
      $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$fg.handle)
      $maxDepth = if ($null -ne $req.maxDepth) { [int]$req.maxDepth } else { 4 }
      $limit = if ($null -ne $req.limit) { [int]$req.limit } else { 120 }
      $result.tree = @()
      if ($null -ne $root) { $result.tree = @(Get-Tree $root 0 $maxDepth $limit) }
      if ($req.screenshot -eq $true) {
        $path = [string]$req.path
        $bmp = New-Object System.Drawing.Bitmap $fg.width, $fg.height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($fg.left, $fg.top, 0, 0, $bmp.Size)
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        $result.screenshot = $path
      }
    }
    'click' {
      $x = [int]$req.x; $y = [int]$req.y
      [void][NativeInput]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 60
      [NativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [NativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      $result.point = @($x, $y)
    }
    'type' {
      $text = [string]$req.text
      [System.Windows.Forms.SendKeys]::SendWait($text)
      $result.length = $text.Length
    }
    'key' {
      $keys = [string]$req.keys
      [System.Windows.Forms.SendKeys]::SendWait($keys)
      $result.keys = $keys
    }
    'scroll' {
      $amount = if ($null -ne $req.amount) { [int]$req.amount } else { -3 }
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point ([int]$req.x), ([int]$req.y)
      [NativeInput]::mouse_event(0x0800, 0, 0, $amount * 120, [UIntPtr]::Zero)
      $result.amount = $amount
    }
    'focus' {
      $h = [IntPtr][long]$req.handle
      [void][NativeInput]::SetForegroundWindow($h)
      $result.foreground = Get-Foreground
    }
    default { $result = @{ ok = $false; error = 'unsupported action' } }
  }
} catch {
  $result = @{ ok = $false; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Depth 6 -Compress
