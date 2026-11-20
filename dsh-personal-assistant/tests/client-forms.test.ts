/**
 * 工作台可写配置：设置三项的映射、表单校验、命令行拼法。
 *
 * 这一层的每个错都能被用户直接看见（选中错了、非法值发出去了、密码回显了），
 * 所以逐条钉住：选项 ↔ 命令值必须一对一，校验不过就绝不发命令。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY_SNAPSHOT, MAIL_FIELDS, SECRET_SAVED_PLACEHOLDER, SETTINGS_OPTIONS, SET_OPTION_FAILURE_PREFIX, WECOM_FIELDS,
  buildCommandLine, fieldPlaceholder, initialFormValues, looksLikeUnknownCommand, optionCommand, optionValueOf,
  optionValuesOf, parseMailSnapshot, parseWecomSnapshot, setOptionFailure, validateMail, validateWecom,
} from '../src/client/config-forms.ts'

describe('设置三项：选项与命令值一对一', () => {
  it('三项、每项两个选项，命令值固定', () => {
    assert.deepEqual(SETTINGS_OPTIONS.map(item => item.key), ['wake', 'broadcast', 'docSpeech'])
    assert.deepEqual(SETTINGS_OPTIONS.map(item => item.choices.map(choice => choice.value)), [
      ['on', 'off'],
      ['all', 'voice'],
      ['source', 'ai'],
    ])
  })

  it('点出的命令字符串与后端约定一致', () => {
    assert.equal(optionCommand('wake', 'on'), '/assistant-set-option wake=on')
    assert.equal(optionCommand('wake', 'off'), '/assistant-set-option wake=off')
    assert.equal(optionCommand('broadcast', 'all'), '/assistant-set-option broadcast=all')
    assert.equal(optionCommand('broadcast', 'voice'), '/assistant-set-option broadcast=voice')
    assert.equal(optionCommand('docSpeech', 'source'), '/assistant-set-option docSpeech=source')
    assert.equal(optionCommand('docSpeech', 'ai'), '/assistant-set-option docSpeech=ai')
  })

  it('摘要里的人话 → 选项值；匹配不上返回 null（不猜）', () => {
    assert.equal(optionValueOf('wake', '开 · 只认我的声音'), 'on')
    assert.equal(optionValueOf('wake', '关'), 'off')
    assert.equal(optionValueOf('broadcast', '所有回复都念'), 'all')
    assert.equal(optionValueOf('broadcast', '只念语音发起的'), 'voice')
    assert.equal(optionValueOf('docSpeech', '原文朗读'), 'source')
    assert.equal(optionValueOf('docSpeech', 'AI 讲解'), 'ai')
    for (const unknown of ['', '未知状态', '半开']) {
      assert.equal(optionValueOf('wake', unknown), null, unknown)
    }
  })

  it('摘要行整体映射：缺行/读不出的项不出现在结果里', () => {
    const values = optionValuesOf([['唤醒', '关'], ['播报', '所有回复都念'], ['讲解模式', 'AI 讲解']])
    assert.deepEqual(values, { wake: 'off', broadcast: 'all', docSpeech: 'ai' })
    assert.deepEqual(optionValuesOf([['唤醒', '奇怪的值']]), {})
  })
})

describe('邮件表单校验', () => {
  const valid = {
    address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: '465',
    password: 'abc 123', imapHost: 'imap.example.com', imapPort: '993',
  }

  it('六个字段都有才通过（密码允许空格）', () => {
    assert.deepEqual(validateMail(valid), {})
    assert.deepEqual(MAIL_FIELDS.map(field => field.key), ['address', 'smtpHost', 'smtpPort', 'password', 'imapHost', 'imapPort'])
  })

  it('邮箱格式、端口范围、必填都拦下来', () => {
    assert.equal(validateMail({ ...valid, address: 'me' }).address, '邮箱地址格式不对')
    assert.equal(validateMail({ ...valid, address: '' }).address, '请填写邮箱地址')
    assert.equal(validateMail({ ...valid, smtpPort: '65536' }).smtpPort, '端口必须在 1–65535 之间')
    assert.equal(validateMail({ ...valid, smtpPort: '0' }).smtpPort, '端口必须在 1–65535 之间')
    assert.equal(validateMail({ ...valid, imapPort: '99a' }).imapPort, '端口必须是数字')
    assert.equal(validateMail({ ...valid, smtpHost: '   ' }).smtpHost, '请填写SMTP 主机')
    assert.equal(validateMail({ ...valid, password: '' }).password, '请填写授权码')
  })
})

describe('企业微信表单校验', () => {
  const valid = { corpId: 'ww123', secret: 's3cret', agentId: '1000002', toUser: '@all' }

  it('四项必填、AgentId 必须是数字', () => {
    assert.deepEqual(validateWecom(valid), {})
    assert.equal(validateWecom({ ...valid, corpId: '' }).corpId, '请填写企业 ID')
    assert.equal(validateWecom({ ...valid, agentId: 'abc' }).agentId, 'AgentId 必须是数字')
    assert.deepEqual(WECOM_FIELDS.map(field => field.key), ['corpId', 'secret', 'agentId', 'toUser'])
  })
})

describe('命令行拼法', () => {
  it('跳过空值，含空格的值加引号', () => {
    assert.equal(
      buildCommandLine('assistant-mail-config', { address: 'me@example.com', password: 'abc 123', smtpHost: '' }, ['address', 'password', 'smtpHost']),
      '/assistant-mail-config address=me@example.com password="abc 123"',
    )
  })

  it('引号会被转义，不会把参数截断', () => {
    assert.equal(
      buildCommandLine('assistant-wecom-config', { secret: 'a"b' }, ['secret']),
      '/assistant-wecom-config secret="a\\"b"',
    )
  })
})

describe('"命令还没就绪"的识别', () => {
  it('未知命令类文案被识别，参数错误不被误判', () => {
    assert.equal(looksLikeUnknownCommand('未知命令：assistant-mail-config'), true)
    assert.equal(looksLikeUnknownCommand('no such command'), true)
    assert.equal(looksLikeUnknownCommand('端口不合法'), false)
  })
})

/**
 * `assistant-set-option` 的失败。
 *
 * 服务端现在回 `kind: 'error'` + ``设置没改成：<原因>``；**同一句话在早期版本里装在
 * `success` 壳子里**，那时只认 `ok` 会把"一个字都没写进去"显示成"改好了"。
 * 所以这里钉的是**兜底识别能力**：不管服务端哪种语义，前端都能拿到"失败 + 原因"。
 */
describe('设置写失败：success 壳子里的「设置没改成」', () => {
  it('前缀命中就返回原因（去掉前缀与冒号），不是失败就返回 null', () => {
    assert.equal(setOptionFailure('设置没改成：桌面宠物没在运行，先召唤它'), '桌面宠物没在运行，先召唤它')
    assert.equal(setOptionFailure('设置没改成:回读不一致'), '回读不一致')
    assert.equal(setOptionFailure('设置没改成'), '设置没改成', '没有原因时原句照显示，不吞成空')
    assert.equal(setOptionFailure('已改：唤醒 = 关'), null)
    assert.equal(setOptionFailure('用法：/assistant-set-option 键=值'), null)
    assert.equal(setOptionFailure(''), null)
  })

  it('前缀常量与服务端文案一致（改文案必须先改这里）', () => {
    assert.equal(SET_OPTION_FAILURE_PREFIX, '设置没改成')
  })

  it('"没改成"不会被当成成功的三句话误伤', () => {
    for (const text of ['已改：播报 = 所有回复都念', '已改：讲解模式 = AI 讲解', '已改：唤醒 = 开 · 只认我的声音']) {
      assert.equal(setOptionFailure(text), null, text)
    }
  })

  it('参数提示（服务端仍是 success）不被误判成写失败', () => {
    const hint = '用法：/assistant-set-option 键=值（wake=on|off、broadcast=all|voice、docSpeech=source|ai）'
    assert.equal(setOptionFailure(hint), null)
  })
})

/**
 * 读回 → 表单初值。
 *
 * 这一段的样本全部是**服务端真函数的输出**（`formatMailConfigView` / `formatWeComAppView` 实跑），
 * 不是手编的：正因为真样本里有两处"看起来像格式错误"的东西（`邮箱 | ` 尾部只剩分隔符、
 * 全空时渲染成 `SMTP | :0`），才必须用真样本钉。
 */
describe('读回：邮件视图 → 表单初值', () => {
  const configured = '邮箱 | me@example.com\nSMTP | smtp.example.com:465\nIMAP | imap.example.com:993\n授权码 | 已保存'

  it('已配置：五个非密码字段全部回填，密码只有"存过"这个布尔值', () => {
    const snapshot = parseMailSnapshot(configured)
    assert.equal(snapshot.unavailable, false)
    assert.equal(snapshot.configured, true)
    assert.equal(snapshot.hasSecret, true)
    assert.deepEqual(snapshot.values, {
      address: 'me@example.com',
      smtpHost: 'smtp.example.com',
      smtpPort: '465',
      imapHost: 'imap.example.com',
      imapPort: '993',
    })
    // 密码的值永远不在这份数据里 —— 结构上就没有这个可能
    assert.equal('password' in snapshot.values, false)
  })

  it('新装机器：读回是一句「还没有配置邮箱」，是未配置、不是读不到', () => {
    const snapshot = parseMailSnapshot('还没有配置邮箱')
    assert.equal(snapshot.unavailable, false, '这句话是一个答案，不是失败')
    assert.equal(snapshot.configured, false)
    assert.deepEqual(snapshot.values, {})
    assert.equal(snapshot.hasSecret, false)
  })

  it('字段全空：`邮箱 | `（尾部只剩分隔符）与 `SMTP | :0` 都不许污染表单', () => {
    const snapshot = parseMailSnapshot('邮箱 | \nSMTP | :0\nIMAP | 未配置\n授权码 | 未配置')
    assert.equal(snapshot.configured, false)
    // `:0` 若被当成真值，表单会预填一个 0 端口，用户点保存才发现不合法——是我们塞进去的错
    assert.deepEqual(snapshot.values, {})
  })

  it('读不到是另一句话：不填任何字段，也不冒充"未配置"', () => {
    const snapshot = parseMailSnapshot('暂时读不到邮箱配置')
    assert.equal(snapshot.unavailable, true)
    assert.equal(snapshot.configured, false)
    assert.deepEqual(snapshot.values, {})
  })

  it('看不懂的回包（错误句 / 空）按"读不到"处理，绝不猜', () => {
    for (const text of ['', '   ', '未知命令：assistant-mail-config', '端口不合法']) {
      assert.equal(parseMailSnapshot(text).unavailable, true, JSON.stringify(text))
      assert.deepEqual(parseMailSnapshot(text).values, {})
    }
  })
})

describe('读回：企业微信视图 → 表单初值', () => {
  it('已配置：三个非密码字段回填，Secret 只有布尔值', () => {
    const snapshot = parseWecomSnapshot('企业 ID | ww1234\nAgentId | 1000002\n接收人 | @all\nSecret | 已保存')
    assert.equal(snapshot.configured, true)
    assert.equal(snapshot.hasSecret, true)
    assert.deepEqual(snapshot.values, { corpId: 'ww1234', agentId: '1000002', toUser: '@all' })
    assert.equal('secret' in snapshot.values, false)
  })

  it('未配置：四行都是「未配置」→ 空表单 + 未配置（不是读不到）', () => {
    const snapshot = parseWecomSnapshot('企业 ID | 未配置\nAgentId | 未配置\n接收人 | 未配置\nSecret | 未配置')
    assert.equal(snapshot.unavailable, false)
    assert.equal(snapshot.configured, false)
    assert.deepEqual(snapshot.values, {})
  })

  it('读不到 → unavailable，字段不填', () => {
    assert.equal(parseWecomSnapshot('暂时读不到企业微信配置').unavailable, true)
  })
})

describe('密码字段的占位符与"留空=不改"', () => {
  const password = MAIL_FIELDS.find(field => field.key === 'password')
  const secret = WECOM_FIELDS.find(field => field.key === 'secret')

  it('存过 → 「已保存，留空表示不修改」；没存过 → 必填提示', () => {
    assert.ok(password !== undefined && secret !== undefined)
    assert.equal(fieldPlaceholder(password, { ...EMPTY_SNAPSHOT, hasSecret: true }), SECRET_SAVED_PLACEHOLDER)
    assert.equal(fieldPlaceholder(secret, { ...EMPTY_SNAPSHOT, hasSecret: true }), SECRET_SAVED_PLACEHOLDER)
    assert.equal(fieldPlaceholder(password, EMPTY_SNAPSHOT), '请输入授权码')
    assert.equal(fieldPlaceholder(secret, EMPTY_SNAPSHOT), '请输入 Secret')
  })

  it('非密码字段的占位符不受影响（还是示例值）', () => {
    const address = MAIL_FIELDS.find(field => field.key === 'address')
    assert.ok(address !== undefined)
    assert.equal(fieldPlaceholder(address, { ...EMPTY_SNAPSHOT, hasSecret: true }), 'name@example.com')
  })

  it('初值只取非密码字段：密码格永远从空开始', () => {
    const snapshot = { unavailable: false, configured: true, hasSecret: true, values: { address: 'me@example.com', password: '不该出现' } }
    const values = initialFormValues(MAIL_FIELDS, snapshot)
    assert.deepEqual(values, { address: 'me@example.com' })
    assert.equal('password' in values, false)
  })

  it('存过凭据后，密码留空是合法的（否则改端口会被迫重填授权码）', () => {
    const filled = { address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: '465', imapHost: 'imap.example.com', imapPort: '993' }
    assert.deepEqual(validateMail({ ...filled, password: '' }, { hasSecret: true }), {})
    assert.equal(validateMail({ ...filled, password: '' }, { hasSecret: false }).password, '请填写授权码')
    assert.equal(validateMail({ ...filled, password: '' }).password, '请填写授权码', '默认按"没存过"算，宁严不松')
  })

  it('企微同理：Secret 存过可留空，没存过必填', () => {
    const filled = { corpId: 'ww1', agentId: '1000002', toUser: '@all' }
    assert.deepEqual(validateWecom({ ...filled, secret: '' }, { hasSecret: true }), {})
    assert.equal(validateWecom({ ...filled, secret: '' }, { hasSecret: false }).secret, '请填写应用 Secret')
  })
})

/**
 * `SMTP | host:port` / `IMAP | host:port` 的切分。
 *
 * 前提：服务端只写 `host:port`，所以按最后一个冒号切。下面的断言钉的是**切错时的降级形态**：
 * 遇到未支持的形态（IPv6 字面量）宁可"整串当 host、端口留空"，也不要截出一个静默错误的值。
 */
describe('读回里的 host:port', () => {
  const mail = (smtp, imap = 'imap.example.com:993') => parseMailSnapshot(
    `邮箱 | me@example.com\nSMTP | ${smtp}\nIMAP | ${imap}\n授权码 | 已保存`,
  )

  it('常规形态：按最后一个冒号切成 host 与 port', () => {
    assert.deepEqual(mail('smtp.example.com:465').values, {
      address: 'me@example.com', smtpHost: 'smtp.example.com', smtpPort: '465',
      imapHost: 'imap.example.com', imapPort: '993',
    })
  })

  it('没有端口：整串当 host，端口留空（让用户自己填，不编一个 465）', () => {
    const values = mail('smtp.example.com').values
    assert.equal(values.smtpHost, 'smtp.example.com')
    assert.equal('smtpPort' in values, false)
  })

  it('防御：裸 IPv6 不截断 —— 整串当 host、端口留空，而不是切出 `2001:db8:` 这种坏值', () => {
    const values = mail('2001:db8::1').values
    assert.equal(values.smtpHost, '2001:db8::1')
    assert.equal('smtpPort' in values, false)
  })

  it('防御：方括号形式同样整串当 host、端口留空（不做 IPv6 解析，只求不静默切错）', () => {
    const values = mail('[::1]:465').values
    assert.equal(values.smtpHost, '[::1]:465')
    assert.equal('smtpPort' in values, false)
  })

  it('host 为空（`SMTP | :0`）→ host 与 port 都不回填', () => {
    const values = mail(':0').values
    assert.equal('smtpHost' in values, false)
    assert.equal('smtpPort' in values, false)
  })
})
