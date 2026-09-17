/**
 * 重启 dsh web 后的一键自检。
 *
 * 用途：新插件构建（主动提醒、schema v2）需要重启 dsh web 才生效。跑完这个脚本，
 * 四项检查全 ok 就说明可以开始照真机验证清单点 40-45 了；任何一项 MISS 都先看它
 * 给出的解释，不要带着旧服务的假象去点清单。
 *
 * 运行：node scripts/verify-restart.mjs   （只读，不写任何数据）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const dir = path.join(dshHome, 'personal-assistant')
let failures = 0

function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'MISS'}  ${label}${detail ? ` —— ${detail}` : ''}`)
}

// ── 1. 桥接服务是不是新构建拉起来的 ──
let info = null
try {
  info = JSON.parse(readFileSync(path.join(dir, 'bridge.json'), 'utf8'))
} catch {
  check('bridge.json 存在（宠物曾被召唤过）', false, '没有桥接文件：先在 dsh 里说一次「召唤宠物」')
}

if (info) {
  const startedAt = new Date(Number(info.startedAt) || 0)
  // 插件新构建的打包时间；早于它启动的服务跑的是旧代码。
  const buildEpoch = Date.parse('2026-09-06T05:10:00+08:00')
  const fresh = startedAt.getTime() >= buildEpoch
  check(
    'dsh web 是重启之后的新实例',
    fresh,
    fresh
      ? `启动于 ${startedAt.toLocaleString()}`
      : `服务 ${startedAt.toLocaleString()} 启动，早于新构建 —— 请重启 dsh web 再跑本脚本`,
  )

  // ── 2. 桥接健康 ──
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health?token=${info.token}`, {
      signal: AbortSignal.timeout(3000),
    })
    const body = await response.json()
    check('桥接 /health 可达', body.ok === true, `epoch=${body.epoch}，团队=${body.team}`)
  } catch (error) {
    check('桥接 /health 可达', false, String(error))
  }
}

// ── 3. 助理库 schema v2（user_flags 表：用户关闭提醒的意愿落库）──
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(dir, 'assistant.sqlite'), { readOnly: true })
  const version = Number(db.prepare('PRAGMA user_version').get().user_version)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  db.close()
  check('assistant.sqlite 已升到 schema v2', version >= 2, `user_version=${version}`)
  check('user_flags 表已建（关闭提醒的持久化载体）', tables.includes('user_flags'))
} catch (error) {
  check('assistant.sqlite 已升到 schema v2', false, `库打不开（${String(error)}）—— 若库不存在，重启 dsh web 后第一次装配会自动创建`)
}

// ── 4. 采样器带键鼠空闲指标 ──
try {
  const date = new Date()
  const name = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`
  const lines = readFileSync(path.join(dir, 'samples', name), 'utf8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  check('今天的采样里有 idleMs（最后键鼠输入毫秒数）', typeof last.idleMs === 'number', `idleMs=${last.idleMs}`)
} catch (error) {
  check('今天的采样里有 idleMs', false, `${String(error)} —— 开启一次「个人助理模式」让采样器跑起来再看`)
}

console.log(failures === 0 ? '\n四项全部就绪，可以开始真机清单 40-45。' : `\n有 ${failures} 项未就绪，按上面提示处理后再点清单。`)
process.exitCode = failures === 0 ? 0 : 1
