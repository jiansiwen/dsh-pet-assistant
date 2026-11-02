/** 使用内存子进程替身，验证大图回执不会被普通控件输出上限误杀。 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { spawn } from 'node:child_process'
import { runComputerScript } from '../src/computer.ts'

function syntheticChild(output: string) {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): void }
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let killed = false
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', 1)) }
  child.stdin.resume()
  child.stdin.on('finish', () => {
    child.stdout.once('end', () => { if (!killed) child.emit('close', 0) })
    child.stdout.end(output)
  })
  return child
}

test('截图返回允许超过 1 MB 的有界编码；普通控件返回仍维持原上限', async () => {
  const output = JSON.stringify({ ok: true, pngBase64: 'A'.repeat(1_200_000) })
  const start = (() => syntheticChild(output)) as unknown as typeof spawn
  const result = await runComputerScript('C:\\synthetic.ps1', { action: 'look', screenshot: true }, undefined, start)
  assert.equal((result.pngBase64 as string).length, 1_200_000)
  await assert.rejects(runComputerScript('C:\\synthetic.ps1', { action: 'look' }, undefined, start), /返回过长/)
})

test('取消前不启动子进程', async () => {
  const controller = new AbortController(); controller.abort('取消')
  let starts = 0
  const start = (() => { starts++; return syntheticChild('{}') }) as unknown as typeof spawn
  await assert.rejects(runComputerScript('C:\\synthetic.ps1', { action: 'look', screenshot: true }, controller.signal, start), /已取消/)
  assert.equal(starts, 0)
})
