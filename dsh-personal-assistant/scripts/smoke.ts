/**
 * 冒烟验证总入口：依次跑「团队存储/审批/状态机」、「会话桥接」与「插件入口装配」三个套件。
 *
 * 三个套件各自负责收尾（关库、停服务、删临时目录），失败也走自己的 finally，
 * 所以这里只负责顺序与短路：前一个套件失败就不再跑后一个，避免两份错误输出互相盖住。
 */
import { run as runApply } from './smoke-apply.ts'
import { run as runBridge } from './smoke-bridge.ts'
import { run as runTeam } from './smoke-team.ts'

export async function run(): Promise<void> {
  console.log('=== 套件一：团队存储 / 审批链路 / 任务状态机')
  await runTeam()
  if (process.exitCode) return
  console.log('\n=== 套件二：会话桥接 HTTP 契约与回复归属')
  await runBridge()
  if (process.exitCode) return
  console.log('\n=== 套件三：插件入口装配（迁移 / 采集闸门 / 保留期 / 工具注册）')
  await runApply()
}
