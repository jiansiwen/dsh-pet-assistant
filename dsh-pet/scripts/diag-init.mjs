/**
 * 诊断：直接 spawn dsh --profile sdk，发送 initialize，分别捕获 stdout/stderr。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const nodeRequire = createRequire(import.meta.url)
const dshBin = path.join(path.dirname(nodeRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')

console.error('[diag] bin =', dshBin)
console.error('[diag] DEEPSEEK_API_KEY set =', Boolean(process.env.DEEPSEEK_API_KEY))

const child = spawn(process.execPath, [dshBin, '--profile', 'sdk'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', d => console.error('[stdout]', JSON.stringify(d.slice(0, 500))))
child.stderr.on('data', d => console.error('[stderr]', JSON.stringify(d.slice(0, 500))))
child.on('exit', (code, sig) => console.error('[exit]', code, sig))

setTimeout(() => {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
  console.error('[diag] sending initialize...')
  child.stdin.write(JSON.stringify(init) + '\n')
}, 8000)

setTimeout(() => {
  console.error('[diag] 40s reached, killing')
  child.kill()
  process.exit(0)
}, 40000)
