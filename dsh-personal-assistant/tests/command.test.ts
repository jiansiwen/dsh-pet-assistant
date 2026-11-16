/**
 * 受控命令执行的钉子用例。
 *
 * 钉四件事：
 * 1. **不经 shell**：参数原样进数组，程序名里的 shell 元字符直接拒绝；
 * 2. **不可逆操作直接拒**，不指望"用户会看清楚"；
 * 3. **超时/参数/目录都有硬上限**，坏输入不跑到子进程再去崩；
 * 4. 跑失败返回退出码和 stderr，而不是抛异常让调用方瞎猜。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_ARGS, MAX_TIMEOUT_SECONDS, runProgram, validateCommand } from '../src/command.ts'

const here = process.cwd()

void test('校验：正常命令被归一，参数原样保留', () => {
  const spec = validateCommand({ program: 'git', args: ['status', '--short'], cwd: here, timeoutSeconds: 30 })
  assert.equal(spec.program, 'git')
  assert.deepEqual(spec.args, ['status', '--short'])
  assert.equal(spec.timeoutSeconds, 30)
})

void test('校验：shell 元字符不能出现在程序名里', () => {
  for (const bad of ['cmd & del', 'a|b', 'x>y', 'p;q']) {
    assert.throws(() => validateCommand({ program: bad }), /shell 元字符/u, bad)
  }
})

void test('校验：不可逆系统操作直接拒绝', () => {
  for (const bad of ['format', 'DISKPART', 'bcdedit.exe', 'C:\\Windows\\System32\\diskpart.exe']) {
    assert.throws(() => validateCommand({ program: bad }), /不可逆/u, bad)
  }
})

void test('校验：参数、超时、目录都有硬上限', () => {
  assert.throws(() => validateCommand({ program: 'node', args: Array.from({ length: MAX_ARGS + 1 }, () => 'x') }), /参数最多/u)
  assert.throws(() => validateCommand({ program: 'node', args: ['a\u0000b'] }), /控制字符/u)
  assert.throws(() => validateCommand({ program: 'node', timeoutSeconds: MAX_TIMEOUT_SECONDS + 1 }), /超时/u)
  assert.throws(() => validateCommand({ program: 'node', timeoutSeconds: 0 }), /超时/u)
  assert.throws(() => validateCommand({ program: 'node', cwd: 'Z:\\definitely\\not\\here' }), /工作目录/u)
  assert.throws(() => validateCommand({ program: 'node', args: 'not-an-array' as never }), /字符串数组/u)
  assert.throws(() => validateCommand({ program: '' }), /必须给出/u)
})

void test('校验：不给目录时用当前目录，不给超时时默认 60 秒', () => {
  const spec = validateCommand({ program: 'node' })
  assert.equal(spec.cwd, process.cwd())
  assert.equal(spec.timeoutSeconds, 60)
  assert.deepEqual(spec.args, [])
})

void test('执行：成功时返回退出码 0 与输出', async () => {
  const fake = ((_p: string, _a: readonly string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => {
    cb(null, 'hello\n', '')
  }) as never
  const result = await runProgram(validateCommand({ program: 'echo', args: ['hello'], cwd: here }), fake)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /hello/u)
  assert.equal(result.truncated, false)
})

void test('执行：失败时返回退出码与 stderr，不抛异常', async () => {
  const fake = ((_p: string, _a: readonly string[], _o: unknown, cb: (e: { code: number }, o: string, s: string) => void) => {
    cb({ code: 2 }, '', 'boom')
  }) as never
  const result = await runProgram(validateCommand({ program: 'false', cwd: here }), fake)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /boom/u)
})

void test('执行：超长输出被截断并标记', async () => {
  const fake = ((_p: string, _a: readonly string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => {
    cb(null, 'x'.repeat(50_000), '')
  }) as never
  const result = await runProgram(validateCommand({ program: 'cat', cwd: here }), fake)
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length < 50_000)
  assert.match(result.stdout, /已截断/u)
})

void test('执行：spawn 自己抛错也变成结果而不是异常', async () => {
  const fake = (() => { throw new Error('无法启动') }) as never
  const result = await runProgram(validateCommand({ program: 'nope', cwd: here }), fake)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /无法启动/u)
})
