/** 执行真实脚本，但用内存替身截住 MCI 和 System.Speech，绝不播放或录音。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('../src/main/', import.meta.url))
const windowsOnly = { skip: process.platform !== 'win32' }
const psString = (value: string) => "'" + value.replaceAll("'", "''") + "'"

function runMockedScript(script: 'play.ps1' | 'speak-once.ps1', fail = '', mode = 'stopped', extension = '.wav') {
  const audioPath = path.join(tmpdir(), `不存在的假音频 带空格${extension}`)
  // 唯一编译的类型是这个内存替身；后续所有 Add-Type 均被截住，不能加载 winmm 或 System.Speech。
  const command = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
namespace WinMM {
  public static class MCI {
    public static readonly System.Collections.Generic.List<string> Commands = new System.Collections.Generic.List<string>();
    public static string Fail = "";
    public static string Mode = "stopped";
    private static int polls = 0;
    public static int mciSendString(string command, System.Text.StringBuilder buffer, int size, System.IntPtr callback) {
      Commands.Add(command);
      if (command.StartsWith(Fail + " ")) return 1;
      if (command.StartsWith("status ")) buffer.Append(polls++ == 0 ? "playing" : Mode);
      return 0;
    }
  }
}
'@
# mock 函数会被目标脚本在子脚本作用域里调用；PowerShell 的 $script: 按调用栈动态解析到
# 调用方脚本作用域会读到空值，必须用 $global: 才能跨作用域收集 Fail 开关与合成日志。
$global:Fail = ${psString(fail)}
[WinMM.MCI]::Fail = $global:Fail
[WinMM.MCI]::Mode = ${psString(mode)}
$global:Synthesis = New-Object 'System.Collections.Generic.List[string]'
function Add-Type {
  param($Namespace, $Name, $MemberDefinition, $AssemblyName)
  if ($AssemblyName -eq 'System.Speech') {
    if ($global:Fail -eq 'assembly') { throw '模拟程序集加载失败' }
    return
  }
  if ($Namespace -eq 'WinMM' -and $Name -eq 'MCI') { return }
  throw '测试禁止加载未替换的设备类型'
}
function New-Object {
  param([string]$TypeName, [object[]]$ArgumentList)
  if ($TypeName -ne 'System.Speech.Synthesis.SpeechSynthesizer') {
    return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
  }
  $global:Synthesis.Add('construct')
  if ($global:Fail -eq 'construct') { throw '模拟构造失败' }
  $synth = [pscustomobject]@{}
  $synth | Add-Member ScriptMethod SetOutputToWaveFile {
    param($value)
    $global:Synthesis.Add('file')
    if ($global:Fail -eq 'file') { throw '模拟文件失败' }
  }
  $synth | Add-Member ScriptMethod Speak {
    param($value)
    $global:Synthesis.Add('speak:' + $value)
    if ($global:Fail -eq 'speak') { throw '模拟合成失败' }
  }
  $synth | Add-Member ScriptMethod SetOutputToNull {
    $global:Synthesis.Add('null')
    if ($global:Fail -eq 'null') { throw '模拟输出释放失败' }
  }
  $synth | Add-Member ScriptMethod Dispose {
    $global:Synthesis.Add('dispose')
    if ($global:Fail -eq 'dispose') { throw '模拟释放失败' }
  }
  return $synth
}
& ${psString(path.join(scriptDir, script))} ${script === 'play.ps1'
    ? `-Path ${psString(audioPath)}`
    : `-B64 ${psString(Buffer.from('中文回退。').toString('base64'))} -OutPath ${psString(audioPath)}`}
[Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{
  code = $LASTEXITCODE; commands = @([WinMM.MCI]::Commands); synthesis = @($global:Synthesis)
}))
`
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return { audioPath, ...JSON.parse(result.stdout.trim()) as { code: number; commands: string[]; synthesis: string[] } }
}

test('播放与合成脚本保留 UTF-8 BOM，PowerShell 5.1 不会误读中文', () => {
  for (const name of ['play.ps1', 'play-host.ps1', 'speak-once.ps1']) {
    assert.deepEqual(readFileSync(path.join(scriptDir, name)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
  }
})

for (const extension of ['.wav', '.mp3']) {
  test(`播放器 ${extension} 使用正确 MCI 命令并在完成后关闭`, windowsOnly, () => {
    const result = runMockedScript('play.ps1', '', 'stopped', extension)
    assert.equal(result.code, 0)
    assert.deepEqual(result.commands, [
      `open "${result.audioPath}" type ${extension === '.wav' ? 'waveaudio' : 'mpegvideo'} alias ttsseg`,
      'play ttsseg', 'status ttsseg mode', 'status ttsseg mode', 'close ttsseg',
    ])
  })
}

for (const fail of ['open', 'play', 'status', 'close']) {
  test(`MCI ${fail} 失败返回非零；已打开设备必经 finally 关闭`, windowsOnly, () => {
    const result = runMockedScript('play.ps1', fail)
    assert.equal(result.code, 1)
    assert.match(result.commands[0], /^open /)
    assert.equal(result.commands.includes('close ttsseg'), fail !== 'open')
    if (fail === 'open') assert.equal(result.commands.length, 1)
    else assert.equal(result.commands.at(-1), 'close ttsseg')
  })
}

test('MCI 意外暂停不能谎报自然完成，仍关闭设备', windowsOnly, () => {
  const result = runMockedScript('play.ps1', '', 'paused')
  assert.equal(result.code, 1)
  assert.equal(result.commands.at(-1), 'close ttsseg')
})

test('回退合成先释放合成器再复用播放器，中文内容不损坏', windowsOnly, () => {
  const result = runMockedScript('speak-once.ps1')
  assert.equal(result.code, 0)
  assert.deepEqual(result.synthesis, ['construct', 'file', 'speak:中文回退。', 'null', 'dispose'])
  assert.deepEqual(result.commands, [
    `open "${result.audioPath}" type waveaudio alias ttsseg`,
    'play ttsseg', 'status ttsseg mode', 'status ttsseg mode', 'close ttsseg',
  ])
})

for (const fail of ['assembly', 'construct', 'file', 'speak', 'null', 'dispose']) {
  test(`本地合成 ${fail} 失败不能进入播放器；构造成功后必须释放`, windowsOnly, () => {
    const result = runMockedScript('speak-once.ps1', fail)
    assert.equal(result.code, 1)
    assert.deepEqual(result.commands, [])
    assert.equal(result.synthesis.includes('dispose'), !['assembly', 'construct'].includes(fail))
  })
}

test('回退链路传播播放器失败码，不将播放失败当作合成完成', windowsOnly, () => {
  const result = runMockedScript('speak-once.ps1', 'play')
  assert.equal(result.code, 1)
  assert.equal(result.synthesis.at(-1), 'dispose')
  assert.equal(result.commands.at(-1), 'close ttsseg')
})

test('真实 PowerShell 处理不存在或损坏的音频及无效 Base64：均失败、无标准输出', windowsOnly, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-tts-failure-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const corrupt = path.join(dir, '损坏.wav')
  writeFileSync(corrupt, '不是音频，不能播放')
  for (const args of [
    ['-File', path.join(scriptDir, 'play.ps1'), '-Path', path.join(dir, '不存在.wav')],
    ['-File', path.join(scriptDir, 'play.ps1'), '-Path', corrupt],
    ['-File', path.join(scriptDir, 'speak-once.ps1'), '-B64', '***', '-OutPath', path.join(dir, '不能生成.wav')],
  ]) {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', ...args], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, '')
  }
})
