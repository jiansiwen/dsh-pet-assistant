/**
 * 受控命令执行。
 *
 * 定位：很多"操作电脑"的活其实是命令，不是点按钮 —— 用 CLI 比找坐标点网页可靠得多。
 *
 * 四条安全约束（按重要性排）：
 *
 * 1. **不经 shell**：`execFile(program, args)`，参数一个个传。拼字符串给 shell 等于把
 *    注入面直接开给模型生成的内容。
 * 2. **每次都要批准**，卡片上显示**完整程序名 + 参数 + 工作目录 + 超时**。
 *    控制权在"人看过这一条"，不在黑名单 —— 黑名单永远漏，而且会挡住正当用途。
 * 3. **极少数不可逆系统操作直接拒绝**（磁盘格式化、引导配置、分区工具）：
 *    这类命令即使被批准也不该由助理代劳，出错没有回头路。
 * 4. **超时 + 输出上限**：命令卡住不能拖死桌面会话，输出不能撑爆模型上下文。
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

export interface CommandSpec {
  program: string
  args: string[]
  cwd: string
  timeoutSeconds: number
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}

export const MAX_ARGS = 24
export const MAX_ARG_CHARS = 2000
export const MAX_TIMEOUT_SECONDS = 300
export const MAX_OUTPUT_CHARS = 20_000

/**
 * 不可逆、影响整台机器、出错没有回头路的程序。
 *
 * 这不是"安全边界"，边界是逐次批准；这里只是拒绝**明显不该由助理代劳**的动作。
 * 名单短、理由清楚，避免变成一份维护不完的黑名单。
 */
const DENIED_PROGRAMS = new Set(['format', 'format.com', 'diskpart', 'diskpart.exe', 'bcdedit', 'bcdedit.exe'])

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const SHELL_META = /[&|<>^`;]/u

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${what}必须是字符串`)
  if (value.length > max) throw new Error(`${what}超过 ${max} 字符`)
  if (CONTROL_CHARS.test(value)) throw new Error(`${what}不能包含控制字符`)
  return value
}

/**
 * 校验并归一命令。任何一条不合法都直接拒绝 —— 命令执行没有"尽量修正"的余地。
 */
export function validateCommand(input: unknown): CommandSpec {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const program = text(raw.program, '程序', 260).trim()
  if (program === '') throw new Error('必须给出要运行的程序')
  if (SHELL_META.test(program)) throw new Error('程序名不能包含 shell 元字符；本工具不经 shell，请把参数放进 args')
  const base = program.replace(/^.*[\\/]/u, '').toLowerCase()
  if (DENIED_PROGRAMS.has(base)) throw new Error(`不接受由助理执行 ${base}：这类操作不可逆，请你自己在终端里做`)

  const rawArgs = raw.args
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) throw new Error('参数必须是一个字符串数组')
  const args = (rawArgs ?? []).map((item, index) => text(item, `第 ${index + 1} 个参数`, MAX_ARG_CHARS))
  if (args.length > MAX_ARGS) throw new Error(`参数最多 ${MAX_ARGS} 个`)
  for (const arg of args) {
    // 参数里出现 shell 元字符本身无害（不经 shell），但仍提示一次：
    // 用户看到卡片时应该能一眼认出"这条命令在做什么"。
    if (arg.includes('\n')) throw new Error('参数里不要放换行；多行脚本请写成单行或放进文件')
  }

  const cwd = raw.cwd === undefined || raw.cwd === '' ? process.cwd() : text(raw.cwd, '工作目录', 1000)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('工作目录不存在或不是文件夹')

  const seconds = raw.timeoutSeconds === undefined ? 60 : raw.timeoutSeconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`超时必须是 1–${MAX_TIMEOUT_SECONDS} 秒之间的数字`)
  }
  return { program, args, cwd, timeoutSeconds: Math.round(seconds) }
}

function clip(value: string): { text: string; truncated: boolean } {
  return value.length <= MAX_OUTPUT_CHARS
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, MAX_OUTPUT_CHARS)}\n…（输出过长已截断）`, truncated: true }
}

/**
 * 真正执行。**不抛异常**：跑不起来和跑失败都是结果的一部分，
 * 调用方需要看到退出码和 stderr，而不是一个异常。
 */
export function runProgram(spec: CommandSpec, start: typeof execFile = execFile): Promise<CommandResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: CommandResult): void => { if (!settled) { settled = true; resolve(value) } }
    try {
      start(spec.program, spec.args, {
        cwd: spec.cwd, timeout: spec.timeoutSeconds * 1000, maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1
        const out = clip(String(stdout ?? ''))
        const err = clip(String(stderr ?? ''))
        finish({ code, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated })
      })
    } catch (error) {
      finish({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), truncated: false })
    }
  })
}
