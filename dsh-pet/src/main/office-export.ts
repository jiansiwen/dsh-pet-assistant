/**
 * 用本机 Microsoft PowerPoint 把 pptx 每页导出成 PNG。
 *
 * 只读打开、不显示窗口、禁用宏；导出文件放在临时目录，读完即删。
 * 不修改原文件，不把 PPTX 交给远端服务。没有 PowerPoint 时由调用方退回本地预览。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT = String.raw`param([string]$inputPath, [string]$outDir)
$ErrorActionPreference = 'Stop'
# Office is single-instance COM: do not attach to a user's open PowerPoint and quit it.
if (Get-Process POWERPNT -ErrorAction SilentlyContinue) {
  Write-Error 'PowerPoint is running; skip automation export'
  exit 2
}
$app = New-Object -ComObject PowerPoint.Application
try {
  $app.DisplayAlerts = 0
  $app.AutomationSecurity = 3
  $pres = $app.Presentations.Open($inputPath, $true, $false, $false)
  try {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    for ($i = 1; $i -le $pres.Slides.Count; $i++) {
      $file = Join-Path $outDir ("slide{0}.png" -f $i)
      $pres.Slides.Item($i).Export($file, 'PNG', 1600, 900)
    }
    Write-Output ("slides=" + $pres.Slides.Count)
  } finally { $pres.Close() }
} finally { $app.Quit() }
`

function powershellPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const wow = path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { readFileSync(wow); return wow } catch { return 'powershell.exe' }
}

/** 只接受 .pptx；导出页数来自 PowerPoint 真正渲染出的页数。 */
export async function exportPptxSlides(inputPath: string, timeoutMs = 90_000): Promise<{ images: Uint8Array[] }> {
  if (path.extname(inputPath).toLowerCase() !== '.pptx') throw new Error('只支持用 PowerPoint 导出 .pptx')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pptx-'))
  const script = path.join(dir, 'export.ps1')
  const output = path.join(dir, 'slides')
  writeFileSync(script, SCRIPT, 'utf8')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, inputPath, output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const timer = setTimeout(() => { child.kill(); reject(new Error('PowerPoint 导出超时')) }, timeoutMs)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0 && /slides=(\d+)/.test(stdout)) resolve()
        else reject(new Error(`PowerPoint 导出失败${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : `（退出码 ${code}）`}`))
      })
    })
    const files = readdirSync(output).filter(name => /^slide\d+\.png$/i.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    if (files.length === 0) throw new Error('PowerPoint 没有导出任何幻灯片')
    return { images: files.map(name => new Uint8Array(readFileSync(path.join(output, name)))) }
  } finally {
    // 导出产物只用于本次阅读；关闭窗口后内存里的图片会随会话释放。
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响本次阅读 */ }
  }
}
