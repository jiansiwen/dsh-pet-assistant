import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../assets/sampler.ps1', import.meta.url))

test('采样脚本在落盘前去除被排除窗口的身份与标题，不启动真实采集', { skip: process.platform !== 'win32' }, () => {
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DSH_TEST_SAMPLER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Protect-Sample' }, $true)
if ($null -eq $function) { throw 'missing privacy filter' }
. ([scriptblock]::Create($function.Extent.Text))
$excludedProcesses = @('KeePass', 'Bitwarden')
$excludedTitles = @('password manager', '[private]')
$results = foreach ($item in ($env:DSH_TEST_CASES | ConvertFrom-Json)) {
  $sample = @{}
  foreach ($property in $item.psobject.Properties) { $sample[$property.Name] = $property.Value }
  Protect-Sample $sample
}
ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
`
  const cases = [
    { ts: 1, proc: 'keepass', pid: 777, title: 'secret', idleMs: 100 },
    { ts: 2, proc: 'chrome', pid: 778, title: 'My PASSWORD MANAGER', idleMs: 100 },
    { ts: 3, proc: 'chrome', title: '[private] personal' },
    { ts: 4, proc: 'Code', title: 'project.ts', idleMs: 0 },
    { ts: 5, proc: 'Code', idleMs: 0 },
    { ts: 6, proc: 'chrome', title: 'private without brackets' },
  ]
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, DSH_TEST_SAMPLER: script, DSH_TEST_CASES: JSON.stringify(cases) },
  })
  assert.deepEqual(JSON.parse(output.trim().replace(/^\uFEFF/, '')), [
    { ts: 1, excluded: true }, { ts: 2, excluded: true }, { ts: 3, excluded: true },
    cases[3], cases[4], cases[5],
  ])
})
