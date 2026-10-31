/**
 * 审批策略的测试。
 *
 * 这一层是安全边界，所以用例的写法与别处不同：**每条都写成"如果判错会发生什么"**，
 * 而不是"函数返回了什么"。判错的代价是不对称的——把高风险判成中风险，用户会批准一个
 * 他以为无关紧要的操作；把专用窗口的回执多信一条，批准就能从舞台那边伪造出来。
 *
 * 全部是纯函数，没有 electron，`node --test` 直接跑得动。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  alwaysConfirmTool,
  cardView,
  checkSender,
  confirmDialogSpec,
  ellipsizeMiddle,
  formatCountdown,
  meetingMailOutcomeText,
  needsNativeConfirm,
  normalizeTarget,
  riskOf,
  sameLocalPage,
  type ApprovalProposal,
  type SenderFacts,
} from '../src/main/approval-policy.ts'

describe('会议邮件结果提示', () => {
  it('提醒尚未登记时必须说明邮件已接受且不要重发', () => {
    const text = meetingMailOutcomeText({ state: 'pending', intentId: 'm1', acceptedAt: 1_800_000_000_000 })
    assert.match(text.message + text.detail, /服务.*接受/u)
    assert.match(text.message + text.detail, /提醒.*未登记/u)
    assert.match(text.detail, /不要重发/u)
  })
  it('计划已登记不等于已送达或已读，缺少结果时只报告未知', () => {
    const scheduled = meetingMailOutcomeText({ state: 'scheduled', intentId: 'm1', acceptedAt: 1_800_000_000_000,
      taskId: 't1', runAt: '2027-01-15T08:02:00.000Z' })
    assert.match(scheduled.detail, /不代表.*收件.*已读/u)
    assert.match(meetingMailOutcomeText(undefined).message, /未知|未确认/u)
  })
})

describe('助理范围确认', () => {
  const full: ApprovalProposal = {
    kind: 'assistant', proposalId: 'assistant-1', revision: 1, digest: 'a'.repeat(64),
    content: '仅允许读取指定项目；可能交给当前模型处理。\n不授权修改或读取其他目录。',
    target: 'D:/项目/' + '完整目录/'.repeat(40), epoch: 'epoch-1', expiresAt: 2000,
    state: 'pending', tool: 'authorize_context', risk: 'medium',
  }
  it('完整范围与目标不截断且不伪装为日报', () => {
    const view = cardView(full, null, 1000)
    assert.equal(view.canDecide, true)
    assert.equal(view.report, null)
    assert.equal(view.assistant?.content, full.content)
    assert.equal(view.target, full.target)
  })
  for (const field of ['revision', 'digest', 'content', 'target', 'epoch', 'expiresAt', 'state', 'tool'] as const) {
    it(`缺少 ${field} 时不能批准`, () => {
      const view = cardView({ ...full, [field]: undefined }, null, 1000)
      assert.equal(view.canDecide, false)
      assert.match(view.blockedReason!, /绑定信息缺失/)
    })
  }
  it('删除即使声明中风险仍须原生确认，过期拒批', () => {
    assert.equal(cardView({ ...full, tool: 'delete_activity' }, null, 1000).needsNativeConfirm, true)
    assert.equal(cardView(full, null, 2000).canDecide, false)
  })
})

function proposal(patch: Partial<ApprovalProposal> = {}): ApprovalProposal {
  return {
    proposalId: 'p-1',
    tool: 'read_file',
    target: 'D:/java/project/report.md',
    summary: '读一下今天的日报',
    risk: 'low',
    state: 'pending',
    expiresAt: 2_000,
    assistantId: 'sun-wukong',
    ...patch,
  }
}

describe('riskOf：认不出的风险等级一律往高判', () => {
  it('三个已知等级原样返回', () => {
    assert.equal(riskOf({ risk: 'low' }), 'low')
    assert.equal(riskOf({ risk: 'medium' }), 'medium')
    assert.equal(riskOf({ risk: 'high' }), 'high')
  })

  it('缺失、null、空串、写错的枚举都按高风险', () => {
    // 这个字段是模型填的。把"我不认识"翻译成"中等"，等于让写错枚举值的模型给自己降级。
    for (const risk of [undefined, null, '', 'Low', 'HIGH', 'critical', 'none']) {
      assert.equal(riskOf({ risk }), 'high', `risk=${JSON.stringify(risk)} 应当判为 high`)
    }
  })
})

describe('alwaysConfirmTool：不可撤销或对外可见的操作，标称低风险也要原生确认', () => {
  it('删除、外发、安装、账户四类都命中', () => {
    for (const tool of [
      'delete_file',
      'fs.remove',
      'unlink',
      'drop_table',
      'send_message',
      'http.post',
      'publish_report',
      'git.push',
      'upload_asset',
      'mail.send',
      'pay',
      'install_package',
      'uninstall',
      'account.update',
      'read_credential',
      'shutdown',
      'restart_service',
      'kill_process',
      'format_disk',
      'login',
      'logout',
      'purchase',
    ]) {
      assert.equal(alwaysConfirmTool(tool), true, `${tool} 必须再过一次原生确认`)
    }
  })

  it('大小写不敏感：工具名写成 DELETE_FILE 也躲不过', () => {
    assert.equal(alwaysConfirmTool('DELETE_FILE'), true)
    assert.equal(alwaysConfirmTool('Fs.Remove'), true)
  })

  it('只读工具不命中', () => {
    for (const tool of ['read_file', 'list_dir', 'search_code', 'get_status']) {
      assert.equal(alwaysConfirmTool(tool), false, `${tool} 是只读的`)
    }
  })

  it('缺失工具名不命中——但 needsNativeConfirm 会另外兜住', () => {
    assert.equal(alwaysConfirmTool(null), false)
    assert.equal(alwaysConfirmTool(undefined), false)
    assert.equal(alwaysConfirmTool(''), false)
  })
})

describe('needsNativeConfirm：哪些批准要再过一道原生确认框', () => {
  it('高风险要确认，哪怕工具名看着无害', () => {
    assert.equal(needsNativeConfirm({ risk: 'high', tool: 'read_file' }), true)
  })

  it('低风险的删除也要确认：不可撤销不看标称风险', () => {
    assert.equal(needsNativeConfirm({ risk: 'low', tool: 'delete_file' }), true)
  })

  it('低风险的只读操作不确认，否则每次翻页都弹一次框', () => {
    assert.equal(needsNativeConfirm({ risk: 'low', tool: 'read_file' }), false)
    assert.equal(needsNativeConfirm({ risk: 'medium', tool: 'list_dir' }), false)
  })

  it('工具名缺失要确认：不知道要动什么的操作最该多看一眼', () => {
    assert.equal(needsNativeConfirm({ risk: 'low', tool: null }), true)
    assert.equal(needsNativeConfirm({ risk: 'low' }), true)
  })

  it('风险等级认不出时按高风险，于是要确认', () => {
    assert.equal(needsNativeConfirm({ risk: 'whatever', tool: 'read_file' }), true)
  })
})

describe('normalizeTarget：规范化之后同一个目标只能有一种写法', () => {
  it('反斜杠与正斜杠、重复斜杠、当前目录段折叠成一种', () => {
    const target = 'D:\\java\\project\\subdir\\report.md'
    assert.equal(normalizeTarget(target), 'D:/java/project/subdir/report.md')
    assert.equal(normalizeTarget('D://java//project//subdir//report.md'), 'D:/java/project/subdir/report.md')
    assert.equal(normalizeTarget('D:/java/project/./subdir/./report.md'), 'D:/java/project/subdir/report.md')
  })

  it('保留 .. 段：跨目录是危险信号，算平就藏住了', () => {
    // 而且纯文本算 .. 本来就算不对——符号链接会让 a/../b 和 b 指向不同地方。
    assert.equal(normalizeTarget('D:/java/project/../secret/key.pem'), 'D:/java/project/../secret/key.pem')
    assert.equal(normalizeTarget('../../etc/passwd'), '../../etc/passwd')
  })

  it('绝对路径与命令行里的路径不被破坏', () => {
    assert.equal(normalizeTarget('/etc/passwd'), '/etc/passwd')
    assert.equal(normalizeTarget('rm -rf /tmp/build'), 'rm -rf /tmp/build')
    assert.equal(normalizeTarget('npm install -g foo'), 'npm install -g foo')
  })

  it('去掉 URL 里的凭据，但不动 // 和路径', () => {
    // 折叠 // 会把 https://host 变成 https:/host，用户对着不像地址的地址做判断更糟。
    assert.equal(normalizeTarget('https://user:token@host/a/b'), 'https://host/a/b')
    assert.equal(normalizeTarget('https://host/a/b'), 'https://host/a/b')
    assert.equal(normalizeTarget('http://host:8080/x?y=1'), 'http://host:8080/x?y=1')
  })

  it('缺失与空白返回 null，而不是空串', () => {
    assert.equal(normalizeTarget(null), null)
    assert.equal(normalizeTarget(undefined), null)
    assert.equal(normalizeTarget(''), null)
    assert.equal(normalizeTarget('   '), null)
  })

  it('非字符串返回 null：这是 HTTP JSON，类型保证不了', () => {
    assert.equal(normalizeTarget(42 as unknown as string), null)
    assert.equal(normalizeTarget({} as unknown as string), null)
  })
})

describe('ellipsizeMiddle：首尾都要留着，中间省略', () => {
  it('不超长就原样返回', () => {
    assert.equal(ellipsizeMiddle('short/path.md', 40), 'short/path.md')
    assert.equal(ellipsizeMiddle('刚好十六个字符长的一段', 16), '刚好十六个字符长的一段')
  })

  it('超长时首尾各留一半，中间一个省略号', () => {
    const long = 'D:/work/dsh/dsh-personal-assistant/dist/index-0905192905.js'
    const shown = ellipsizeMiddle(long, 32)
    assert.ok(shown.length <= 32, `结果长度 ${shown.length} 不该超过 32`)
    assert.ok(shown.includes('…'))
    assert.ok(shown.startsWith('D:/work/'), '盘符和起始目录必须看得见')
    // 尾部留出的那一半要能看见文件名主体，否则截断把最该判断的部分切掉了。
    assert.ok(shown.endsWith('-0905192905.js'), `尾部应当留着文件名，实际是：${shown}`)
  })

  it('上限小到装不下两端时退回尾部省略，但仍然不超上限', () => {
    // 硬凑"首尾各一半"会比上限更长，而调用方要的就是一个放得进固定宽度的字符串。
    for (const max of [1, 2, 4, 8]) {
      const shown = ellipsizeMiddle('abcdefghijklmnopqrst', max)
      assert.ok(shown.length <= max, `max=${max} 时结果长度 ${shown.length} 超了`)
      assert.ok(shown.endsWith('…'), `max=${max} 时应当以省略号收尾`)
    }
  })

  it('上限刚好够两端时仍然是中间省略', () => {
    // 20 个字符、上限 10：首尾各留 4，中间一个省略号，结果 9 个字符。
    assert.equal(ellipsizeMiddle('abcdefghijklmnopqrst', 10), 'abcd…qrst')
  })
})

describe('formatCountdown：审批提案的剩余时间', () => {
  it('到点与过点都是「已过期」', () => {
    assert.equal(formatCountdown(0), '已过期')
    assert.equal(formatCountdown(-1500), '已过期')
  })

  it('按 m:ss 显示，秒补两位', () => {
    assert.equal(formatCountdown(5_000), '0:05')
    assert.equal(formatCountdown(65_000), '1:05')
    assert.equal(formatCountdown(59_999), '0:59')
    assert.equal(formatCountdown(600_000), '10:00')
  })

  it('不足一秒显示 0:00 而不是「已过期」：还有一瞬可以点', () => {
    assert.equal(formatCountdown(999), '0:00')
  })
})

describe('cardView：把原始提案投影成卡片内容', () => {
  it('待批且未过期时可以决定', () => {
    const view = cardView(proposal(), '助理1', 1_000)
    assert.equal(view.canDecide, true)
    assert.equal(view.blockedReason, null)
    // 这里断言截止时间而不是倒计时文案：文案要每秒跳一次，由界面自己用 formatCountdown 算，
    // 那组用例在 formatCountdown 的 describe 里。投影只负责把原始截止时间原样交出去。
    assert.equal(view.expiresAt, 2_000)
    assert.equal(view.riskLabel, '低风险')
    assert.equal(view.requester, '助理1')
  })

  it('过期后不能决定，而且原因要显示出来', () => {
    const view = cardView(proposal({ expiresAt: 1_000 }), '助理1', 1_500)
    assert.equal(view.canDecide, false)
    assert.equal(view.expired, true)
    // 只禁用按钮不告诉原因，用户就不知道自己在等什么。
    assert.ok(view.blockedReason && view.blockedReason.includes('过期'))
    assert.ok(view.blockedReason.includes('重新提请'), '要给出下一步该怎么办')
  })

  it('已批准/已驳回的提案不能决定，原因里说清是哪种', () => {
    const approved = cardView(proposal({ state: 'approved' }), '助理1', 0)
    assert.equal(approved.canDecide, false)
    assert.ok(approved.blockedReason?.includes('批准'))

    const rejected = cardView(proposal({ state: 'rejected' }), '助理1', 0)
    assert.ok(rejected.blockedReason?.includes('驳回'))

    const expiredState = cardView(proposal({ state: 'expired' }), '助理1', 0)
    assert.ok(expiredState.blockedReason?.includes('结束'))
  })

  it('没有有效期的提案不显示倒计时，也不判为过期', () => {
    // expiresAt 是 null 而不是一个过去的时刻：那条提案根本没有期限，说它过期是误导。
    const view = cardView(proposal({ expiresAt: undefined }), '助理1', 9_999_999)
    assert.equal(view.expiresAt, null)
    assert.equal(view.expired, false)
    assert.equal(view.canDecide, true)
  })

  it('state 缺失按 pending 处理：宿主不推这个字段时提案仍然可以批', () => {
    const view = cardView(proposal({ state: undefined }), '助理1', 0)
    assert.equal(view.canDecide, true)
  })

  it('工具名与摘要缺失时给可读的兜底，不留空白', () => {
    const view = cardView(proposal({ tool: null, summary: '   ', target: null }), null, 0)
    assert.equal(view.tool, '未知操作')
    assert.equal(view.summary, null)
    assert.equal(view.target, null)
    assert.equal(view.requester, null)
  })

  it('目标先规范化：反斜杠统一成正斜杠', () => {
    const long = 'D:\\work\\dsh\\dsh-personal-assistant\\dist\\index-0905192905.js'
    const view = cardView(proposal({ target: long }), '助理1', 0)
    // 先收窄类型：给了目标就该有目标，而 assert.ok 是断言函数，后面两条不必再写可选链。
    assert.ok(typeof view.target === 'string', '给了目标就该有目标')
    assert.ok(view.target.startsWith('D:/work/'), '反斜杠应当已经统一')
    assert.equal(view.target.length, long.length, '这个长度还不该触发截断')
  })

  it('超过上限的目标中间省略，首尾都还在', () => {
    // 留头又留尾：用户认路径靠的是开头的盘符目录和结尾的文件名。
    // 只留开头的话，dist 下的一堆产物在卡片上长得一模一样，等于没显示。
    const deep = `C:\\Users\\someone\\AppData\\Roaming\\dsh\\${'very-long-directory-name\\'.repeat(8)}report-2026-09-05.md`
    const view = cardView(proposal({ target: deep }), null, 0)
    assert.ok(typeof view.target === 'string', '给了目标就该有目标')
    assert.ok(view.target.length <= 160, `实际长度 ${view.target.length}`)
    assert.ok(view.target.startsWith('C:/Users/someone/'), '盘符和头两级目录要留着')
    assert.ok(view.target.endsWith('report-2026-09-05.md'), '文件名要留着')
    assert.ok(view.target.includes('…'), '中间应当有省略号')
  })

  it('卡片上标出这次要不要原生确认', () => {
    assert.equal(cardView(proposal({ risk: 'low', tool: 'read_file' }), null, 0).needsNativeConfirm, false)
    assert.equal(cardView(proposal({ risk: 'low', tool: 'delete_file' }), null, 0).needsNativeConfirm, true)
  })
})

describe('confirmDialogSpec：原生确认框的文案', () => {
  it('写出操作、目标、说明、提请者、风险与剩余时间', () => {
    const spec = confirmDialogSpec(cardView(proposal(), '助理1', 1_000), '助理1', 1_000)
    assert.ok(spec.message.includes('助理1'))
    assert.ok(spec.message.includes('read_file'))
    assert.ok(spec.message.includes('真的动手'), '要让用户知道批准后是真执行')
    for (const line of ['操作：read_file', '目标：D:/java/project/report.md', '说明：读一下今天的日报', '提请：助理1', '风险：低风险', '剩余：0:01']) {
      assert.ok(spec.detail.includes(line), `detail 里应当有「${line}」，实际是：${spec.detail}`)
    }
  })

  it('剩余时间按弹框那一刻算，不按卡片渲染那一刻算', () => {
    // 用户可能先读了十几秒卡片才点批准。显示卡片时刻的剩余时间会多报，
    // 而多报的那几秒正是用户以为还来得及的部分。
    const view = cardView(proposal({ expiresAt: 60_000 }), '助理1', 0)
    assert.ok(confirmDialogSpec(view, '助理1', 0).detail.includes('剩余：1:00'))
    assert.ok(confirmDialogSpec(view, '助理1', 30_000).detail.includes('剩余：0:30'))
  })

  it('没有提请者时退回「助理」，不显示 null', () => {
    const spec = confirmDialogSpec(cardView(proposal({ assistantId: null }), null, 0), null, 0)
    assert.ok(spec.detail.includes('提请：助理'))
    assert.ok(!spec.detail.includes('null'))
    assert.ok(!spec.message.includes('null'))
  })

  it('目标与说明缺失时不留下空行', () => {
    const spec = confirmDialogSpec(cardView(proposal({ target: null, summary: null }), null, 0), null, 0)
    assert.ok(!spec.detail.includes('目标：'))
    assert.ok(!spec.detail.includes('说明：'))
    assert.ok(!spec.detail.includes('\n\n'), '过滤掉的行不该留下空行')
  })

  it('没有有效期的提案不显示剩余时间那一行', () => {
    const spec = confirmDialogSpec(cardView(proposal({ expiresAt: undefined }), null, 0), null, 0)
    assert.ok(!spec.detail.includes('剩余：'))
  })

  it('两个按钮的措辞不对称：批准那句更重', () => {
    // 「确定 / 取消」这种对称措辞会让用户不看内容就点第一个。
    const spec = confirmDialogSpec(cardView(proposal({ tool: 'delete_file' }), null, 0), null, 0)
    assert.equal(spec.approveLabel, '我确认，批准')
    assert.equal(spec.cancelLabel, '先不批准')
  })
})

describe('checkSender：专用窗口回来的批准凭什么被采信', () => {
  function facts(patch: Partial<SenderFacts> = {}): SenderFacts {
    return {
      senderId: 7,
      registeredId: 7,
      isMainFrame: true,
      url: 'file:///D:/app/dist/renderer/approval.html',
      expectedUrl: 'file:///D:/app/dist/renderer/approval.html',
      claimedProposalId: 'p-1',
      registeredProposalId: 'p-1',
      ...patch,
    }
  }

  it('四条都满足时采信', () => {
    assert.deepEqual(checkSender(facts()), { ok: true })
  })

  it('没登记过审批任务的窗口，回执一律拒', () => {
    const result = checkSender(facts({ registeredId: null }))
    assert.equal(result.ok, false)
  })

  it('发信者不是登记的那个 webContents 就拒：另一个窗口伪造不了批准', () => {
    const result = checkSender(facts({ senderId: 9 }))
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.reason.includes('登记'))
  })

  it('子 frame 的回执拒：页面里嵌的 iframe 不该能签发批准', () => {
    const result = checkSender(facts({ isMainFrame: false }))
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.reason.includes('frame'))
  })

  it('URL 与加载时不完全相等就拒，差一个字符也不行', () => {
    // 专用窗口禁止导航，所以任何差异都意味着它被导到别处去了。
    for (const url of [
      'file:///D:/app/dist/renderer/approval.html#x',
      'file:///D:/app/dist/renderer/approval.html?x=1',
      'https://evil.example/approval.html',
      'file:///D:/app/dist/renderer/index.html',
      '',
    ]) {
      const result = checkSender(facts({ url }))
      assert.equal(result.ok, false, `url=${url} 应当被拒`)
    }
  })

  it('自报的提案 id 与登记的不一致就拒：窗口说自己在批哪条不算数', () => {
    assert.equal(checkSender(facts({ claimedProposalId: 'p-2' })).ok, false)
    assert.equal(checkSender(facts({ registeredProposalId: null })).ok, false)
    assert.equal(checkSender(facts({ claimedProposalId: '' })).ok, false)
  })

  it('同时错多条时给出第一条原因，不静默通过', () => {
    const result = checkSender(facts({ senderId: 9, isMainFrame: false, url: 'https://evil/' }))
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.reason.length > 0)
  })
})

describe('sameLocalPage：什么才算"就是那个打包进来的本地页面"', () => {
  const page = 'file:///D:/app/dist/renderer/approval.html'

  it('同一个页面相等', () => {
    assert.equal(sameLocalPage(page, page), true)
  })

  it('百分号编码差异不算不同页面：这条是换成解码比对的原因', () => {
    // 字符串全等会在这里误伤——用户目录带空格时审批窗口会完全不能用，而且看不出错在哪。
    assert.equal(
      sameLocalPage('file:///C:/Users/My%20Name/app/approval.html', 'file:///C:/Users/My Name/app/approval.html'),
      true,
    )
  })

  it('远程协议一律不算，哪怕路径一模一样', () => {
    assert.equal(sameLocalPage('https://evil.example/approval.html', 'https://evil.example/approval.html'), false)
    assert.equal(sameLocalPage('http://127.0.0.1:8080/approval.html', page), false)
  })

  it('带 query 或 hash 不算：那已经不是原来那个页面了', () => {
    assert.equal(sameLocalPage(`${page}?p=p-2`, page), false)
    assert.equal(sameLocalPage(`${page}#p-2`, page), false)
  })

  it('另一个本地页面不算，哪怕就在隔壁目录', () => {
    assert.equal(sameLocalPage('file:///D:/app/dist/renderer/index.html', page), false)
    assert.equal(sameLocalPage('file:///D:/app/dist/renderer/approval-copy.html', page), false)
  })

  it('解析不出来的字符串不算，不退回"看着像"的比较', () => {
    assert.equal(sameLocalPage('', page), false)
    assert.equal(sameLocalPage('D:/app/dist/renderer/approval.html', page), false)
    assert.equal(sameLocalPage(page, 'not a url'), false)
  })

  it('期望值本身不是本地页面时也不通过：配置错了要失败，不要放行', () => {
    assert.equal(sameLocalPage(page, 'https://example/approval.html'), false)
  })
})

describe('可信执行器动作的审批卡：差异、命令与复核结论必须完整摊开，对不上就不能批', () => {
  const changeDocument = (patch: Record<string, unknown> = {}) => ({
    format: 'dsh-change-review@1', root: 'D:/work/repo', revision: 2,
    files: [
      { path: 'src/calc.js', action: 'modify', added: 1, removed: 1, baseHash: 'b'.repeat(64), newHash: 'c'.repeat(64),
        diff: '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b\n+  return a + b\n }', diffTruncated: false },
      { path: 'src/new.js', action: 'create', added: 1, removed: 0, baseHash: 'absent', newHash: 'd'.repeat(64),
        diff: '@@ -0,0 +1,1 @@\n+exports.y = 1', diffTruncated: false },
    ],
    totalAdded: 2, totalRemoved: 1, truncated: false, notice: null, ...patch,
  })
  const change = (document: unknown = changeDocument(), patch: Partial<ApprovalProposal> = {}): ApprovalProposal => ({
    proposalId: 'change-1', tool: 'apply_change', target: 'D:/work/repo', summary: '改动第 2 版：2 个文件（+2 −1）',
    risk: 'medium', state: 'pending', expiresAt: 2_000, assistantId: 'member-tangseng',
    content: JSON.stringify(document), digest: 'e'.repeat(64), revision: 2, ...patch,
  })

  it('改动卡：文件清单、增删行数与逐行差异都在，标题与操作名说清是「应用改动」', () => {
    const view = cardView(change(), '总助理', 1_000)
    assert.equal(view.canDecide, true)
    assert.equal(view.title, '请审阅这次改动')
    assert.equal(view.toolLabel, '应用改动（apply_change）')
    assert.equal(view.change?.files.length, 2)
    assert.deepEqual(view.change?.files.map(file => [file.path, file.actionLabel, file.added, file.removed]),
      [['src/calc.js', '修改', 1, 1], ['src/new.js', '新建', 1, 0]])
    assert.equal(view.change?.totalAdded, 2)
    assert.deepEqual(view.change?.files[0]?.lines.map(line => line.kind), ['hunk', 'ctx', 'del', 'add', 'ctx'])
    assert.equal(view.change?.digest, 'e'.repeat(64))
    assert.equal(view.change?.notice, null)
  })

  it('截断时必须带提示，增删行数仍按完整改动显示', () => {
    const truncated = changeDocument({ truncated: true, notice: '差异太长，审批卡只显示了前 4 行' })
    ;(truncated.files as Array<Record<string, unknown>>)[0]!.diffTruncated = true
    ;(truncated.files as Array<Record<string, unknown>>)[0]!.diff = '@@ -1,3 +1,3 @@'
    const view = cardView(change(truncated), null, 1_000)
    assert.equal(view.canDecide, true)
    assert.equal(view.change?.truncated, true)
    assert.match(view.change?.notice ?? '', /只显示了前 4 行/)
    assert.equal(view.change?.files[0]?.added, 1)
    const silent = changeDocument({ truncated: true, notice: null })
    ;(silent.files as Array<Record<string, unknown>>)[0]!.diffTruncated = true
    assert.equal(cardView(change(silent), null, 1_000).canDecide, false, '截断却不提示就不能批')
  })

  it('差异与声明的增删行数对不上、总数不符、修订或摘要缺失、格式不对：一律不能批', () => {
    const lying = changeDocument()
    ;(lying.files as Array<Record<string, unknown>>)[0]!.added = 0
    const cases: ApprovalProposal[] = [
      change(lying),
      change(changeDocument({ totalAdded: 5 })),
      change(changeDocument({ revision: 3 })),
      change(changeDocument({ format: 'other' })),
      change(changeDocument({ files: [] })),
      change(changeDocument(), { digest: undefined }),
      change(changeDocument(), { revision: undefined }),
      change(changeDocument(), { content: '不是 JSON' }),
      change(changeDocument(), { content: undefined }),
    ]
    for (const proposal of cases) {
      const view = cardView(proposal, null, 1_000)
      assert.equal(view.canDecide, false)
      assert.match(view.blockedReason ?? '', /改动差异、版本或绑定信息缺失或对不上/)
      assert.equal(view.change, null)
    }
  })

  const verification = (patch: Partial<ApprovalProposal> = {}, document: Record<string, unknown> = {}): ApprovalProposal => ({
    proposalId: 'verify-1', tool: 'run_verification', target: 'C:/node/node.exe --test test/calc.test.js', risk: 'high', state: 'pending',
    expiresAt: 2_000, assistantId: 'member-tangseng', summary: '在 . 运行验证命令（超时 60 秒）', digest: 'f'.repeat(64), revision: 1,
    content: JSON.stringify({
      format: 'dsh-verification-review@1', root: 'D:/work/repo', cwd: 'D:/work/repo', cwdRelative: '.', program: 'C:/node/node.exe',
      requested: 'node', args: ['--test', 'test/calc.test.js'], timeoutMs: 60_000, expectedEffects: '只运行单元测试，不修改源文件',
      env: '只传基础环境变量', afterChange: { changeId: 'c', revision: 2, files: ['src/calc.js'] }, notes: ['不经过 shell'], ...document,
    }),
    ...patch,
  })

  it('验证命令卡：cwd、程序绝对路径、逐项参数、超时、预期副作用都摊开；高风险要原生确认', () => {
    const view = cardView(verification(), '总助理', 1_000)
    assert.equal(view.canDecide, true)
    assert.equal(view.title, '请确认这条验证命令')
    assert.deepEqual(view.verification?.args, ['--test', 'test/calc.test.js'])
    assert.equal(view.verification?.timeoutLabel, '1 分 0 秒')
    assert.equal(view.verification?.afterChange?.revision, 2)
    assert.equal(view.needsNativeConfirm, true)
    const spec = confirmDialogSpec(view, '总助理', 1_000)
    for (const line of ['工作目录：D:/work/repo', '程序：C:/node/node.exe', '参数：["--test","test/calc.test.js"]', '超时：1 分 0 秒', '预期副作用：只运行单元测试，不修改源文件']) {
      assert.ok(spec.detail.includes(line), `确认框里应当有「${line}」，实际：${spec.detail}`)
    }
    assert.match(spec.message, /运行验证命令/)
  })

  it('验证命令缺参数数组、超时或预期副作用说明：不能批', () => {
    for (const document of [{ args: 'node --test' }, { timeoutMs: 0 }, { expectedEffects: '' }, { format: 'x' }]) {
      const view = cardView(verification({}, document), null, 1_000)
      assert.equal(view.canDecide, false, JSON.stringify(document))
      assert.match(view.blockedReason ?? '', /验证命令的完整范围缺失/)
    }
  })

  it('人工复核卡：写明被复核的操作与要写进账本的结论；信息不全不能批', () => {
    const review = (document: Record<string, unknown> = {}): ApprovalProposal => ({
      proposalId: 'review-1', tool: 'review_unknown', target: 'operation:op-1', risk: 'medium', state: 'pending', expiresAt: 2_000,
      digest: 'a'.repeat(64), revision: 1,
      content: JSON.stringify({
        format: 'dsh-unknown-review@1',
        operation: { operationId: 'op-1', kind: 'bash', target: 'deploy --prod', startedAt: 10, executedAt: 20, detail: '进程中断' },
        resolution: 'verified-failed', resolutionLabel: '已核实失败', note: '日志显示没部署上', effect: '只改写账本里这一项操作的结论', ...document,
      }),
    })
    const view = cardView(review(), null, 1_000)
    assert.equal(view.canDecide, true)
    assert.equal(view.title, '请确认人工复核结论')
    assert.equal(view.review?.resolutionLabel, '已核实失败')
    assert.equal(view.review?.target, 'deploy --prod')
    assert.match(confirmDialogSpec(view, null, 1_000).detail, /标记为「已核实失败」/)
    assert.equal(cardView(review({ resolution: 'succeeded' }), null, 1_000).canDecide, false)
    assert.equal(cardView(review({ operation: null }), null, 1_000).canDecide, false)
  })

  it('普通团队提案与日报、助理卡片照旧：没有审阅区，操作名就是工具名', () => {
    const plain = cardView(proposal(), '助理1', 1_000)
    assert.equal(plain.change, undefined)
    assert.equal(plain.toolLabel, 'read_file')
    assert.equal(plain.title, '有个操作等你点头')
  })
})
