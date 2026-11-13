/**
 * 配置类命令的参数解析：`/<命令> key=value key=value`。
 *
 * 形状由前端 `src/client/config-forms.ts` 的 `buildCommandLine` 决定，这里是**消费端**：
 * - 值里含空格或引号时前端会加双引号，内部引号转义成 `\"`；
 * - 键大小写不敏感（统一转小写）；
 * - 同一个键出现多次以最后一次为准。
 *
 * 返回 `null` 表示**参数形状不可用**（有孤立词、缺等号、引号没闭合）。调用方据此给用法提示，
 * 而不是猜用户想填哪个字段 —— 猜错的代价是把半截配置写进文件。
 */

/** 只认「字母开头的标识符」作为键：`mail=`、`smtpHost=`、`corpId=`。 */
const KEY = /^[a-z][a-z0-9]*$/u

function tokenize(text: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      // 前端把双引号转义成 `\"`，所以这里认这个转义；其余反斜杠原样保留（密码里常有）。
      if (char === '\\' && text[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === '"') { quoted = false; continue }
      current += char
      continue
    }
    if (char === '"') { quoted = true; started = true; continue }
    if (/\s/u.test(char)) {
      if (started || current !== '') {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
  }
  // 引号没闭合：整行不可解析，宁可报用法也不要把半截值写进去。
  if (quoted) return null
  if (started || current !== '') tokens.push(current)
  return tokens
}

/** 去掉开头的 `/命令名`，只留参数部分。`/命令名` 后面没有空格时参数为空（= 读）。 */
function argumentText(rawInput: string | undefined): string {
  const raw = (rawInput ?? '').trim()
  if (!raw.startsWith('/')) return raw
  const space = raw.search(/\s/u)
  return space < 0 ? '' : raw.slice(space + 1)
}

/**
 * 解析成 `{ 键: 值 }`。空参数（读操作）返回 `{}`；形状不可用返回 `null`。
 *
 * 值两端空白被裁掉：`key= value` 与前端 `key=value` 等价；引号里的空格保留。
 */
export function parseConfigArguments(rawInput: string | undefined): Record<string, string> | null {
  const tokens = tokenize(argumentText(rawInput))
  if (tokens === null) return null
  const values: Record<string, string> = {}
  for (const token of tokens) {
    const split = token.indexOf('=')
    if (split <= 0) return null
    const key = token.slice(0, split).trim().toLowerCase()
    if (!KEY.test(key)) return null
    values[key] = token.slice(split + 1).trim()
  }
  return values
}

/**
 * 按键取值（键大小写不敏感）。同一含义的多个写法按顺序取第一个有值的，
 * 例如邮件地址既认 `mail=`（命令文档里写的）也认 `address=`（表单字段名）。
 */
export function argumentOf(values: Record<string, string>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = values[key.toLowerCase()]
    if (value !== undefined && value !== '') return value
  }
  return ''
}
