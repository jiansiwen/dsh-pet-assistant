# 只运行从正式脚本提取的校验与编码逻辑；屏幕 API、窗口和图像均为固定替身，不调用真实截屏。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
public static class NativeInput {
  public static int Calls = 0;
  public static bool ChangeAfterCapture = false;
  public static bool DpiValid = true;
  public class Display { public string name; public int left, top, width, height; public bool primary; }
  public static bool AccurateDpi() { return DpiValid; }
  public static Display[] Displays() { return new [] { new Display { name="显示器1", left=0, top=0, width=1, height=1, primary=true } }; }
  public static int GetSystemMetrics(int index) { return index == 78 || index == 79 ? 1 : 0; }
  public static IntPtr GetForegroundWindow() {
    Calls++;
    return new IntPtr(ChangeAfterCapture && Calls > 2 ? 999 : 123);
  }
}
'@
$file = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'assets\computer.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw '正式脚本存在语法错误' }
function Function-Source([string]$name) {
  $found = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
    Where-Object { $_.Name -eq $name })
  if ($found.Count -ne 1) { throw "无法唯一提取函数 $name" }
  return $found[0].Extent.Text
}
$targetCode = Function-Source 'Check-Target'
$screenCode = Function-Source 'Check-Screen'
$captureCode = Function-Source 'Capture-Screen'
$copyLine = '$graphics.CopyFromScreen([int]$screen.left, [int]$screen.top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)'
if (($captureCode.Split(@($copyLine), [StringSplitOptions]::None)).Count -ne 2) { throw '正式截图调用位置与安全替换规则不匹配' }
$captureCode = $captureCode.Replace($copyLine, '$graphics.Clear([System.Drawing.Color]::Blue)')
if ($captureCode.Contains('CopyFromScreen')) { throw '安全替换不完整，禁止执行测试' }

$script:fakeTarget = @{ windowId='123'; pid=1234; processPath='C:\synthetic.exe'; processStartedAt='1000'; className='Editor';
  title='合成窗口'; left=0; top=0; width=1; height=1 }
$script:layouts = @(); $script:layoutIndex = 0
function Identity([IntPtr]$h) { return $script:fakeTarget }
function Get-ScreenLayout {
  if ($script:layoutIndex -ge $script:layouts.Count) { throw '测试布局读取超过预期次数' }
  $item = $script:layouts[$script:layoutIndex]
  $script:layoutIndex++
  return $item
}
function Use-Layouts($first, $second) { $script:layouts = @($first, $second); $script:layoutIndex = 0; [NativeInput]::Calls = 0; [NativeInput]::ChangeAfterCapture = $false }
function Expect-Failure([scriptblock]$block, [string]$expected) {
  try { & $block | Out-Null } catch { if ($_.Exception.Message -like "*$expected*") { return }; throw }
  throw "应当拒绝：$expected"
}
$fakeLayoutCode = ${function:Get-ScreenLayout}.ToString()
Invoke-Expression (Function-Source 'Get-ScreenLayout')
$layout = Get-ScreenLayout
if ($layout.width -ne 1 -or $layout.height -ne 1 -or $layout.displays.Count -ne 1 -or $layout.displays[0].name -ne '显示器1') {
  throw '合成显示器元数据不正确'
}
[NativeInput]::DpiValid = $false
Expect-Failure { Get-ScreenLayout } '准确的屏幕像素坐标'
[NativeInput]::DpiValid = $true
Invoke-Expression ("function Get-ScreenLayout {`n" + $fakeLayoutCode + "`n}")
Invoke-Expression $targetCode
Invoke-Expression $screenCode
Invoke-Expression $captureCode

$one = @{ left=0; top=0; width=1; height=1; displays=@(@{name='显示器1'; left=0; top=0; width=1; height=1; primary=$true}) }
Use-Layouts $one $one
$result = Capture-Screen $script:fakeTarget $one 8000000
if (-not $result.ok -or $result.screen.displays.Count -ne 1) { throw '合成截图结果不正确' }
$data = [Convert]::FromBase64String($result.pngBase64)
$stream = [System.IO.MemoryStream]::new($data)
$bitmap = [System.Drawing.Bitmap]::new($stream)
try { if ($bitmap.Width -ne 1 -or $bitmap.Height -ne 1 -or $bitmap.GetPixel(0,0).B -ne 255 -or $bitmap.GetPixel(0,0).A -ne 255) { throw '合成图像编码不正确' } }
finally { $bitmap.Dispose(); $stream.Dispose(); [Array]::Clear($data, 0, $data.Length) }

$changed = @{ left=0; top=0; width=1; height=1; displays=@(@{name='显示器2'; left=0; top=0; width=1; height=1; primary=$true}) }
Use-Layouts $one $changed
Expect-Failure { Capture-Screen $script:fakeTarget $one 8000000 } '显示器身份或布局已变化'

Use-Layouts $one $one
[NativeInput]::ChangeAfterCapture = $true
Expect-Failure { Capture-Screen $script:fakeTarget $one 8000000 } '前台窗口已变化'

Use-Layouts $one $one
Expect-Failure { Capture-Screen $script:fakeTarget $one 1 } '截图超过附件大小上限'

$multiple = @{ left=-2; top=0; width=3; height=1; displays=@(
  @{name='显示器1'; left=-2; top=0; width=2; height=1; primary=$false},
  @{name='显示器2'; left=0; top=0; width=1; height=1; primary=$true}
) }
Use-Layouts $multiple $multiple
$result = Capture-Screen $script:fakeTarget $multiple 8000000
if (-not $result.ok -or $result.screen.left -ne -2 -or $result.screen.displays.Count -ne 2) { throw '多屏范围核验失败' }
'合成画面、窗口变化、显示器变化、大小限制和多屏检查通过；未读取真实屏幕。'
