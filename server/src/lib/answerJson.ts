import { HttpError } from '../middleware/error.js'

export const ANSWER_JSON_RULE = '只输出完整 JSON 对象。answer 内的换行、回车、制表符必须写为 JSON 转义 \\n、\\r、\\t；双引号和反斜杠也必须转义。不要输出 Markdown 代码围栏。'

/** 兼容已实测的上游字符串控制字符错误，不补括号、不猜字段、不挽救截断。 */
export function parseAnswerJson(content: string | null): unknown {
  const raw = content ?? ''
  if (raw.length > 24_000) throw new HttpError(502, 'AI_RESULT_SCHEMA_INVALID', '回答结构过长')
  let normalized = '', inString = false, escaped = false
  for (const char of raw) {
    if (inString && !escaped && char.charCodeAt(0) < 32) {
      normalized += JSON.stringify(char).slice(1, -1)
      continue
    }
    normalized += char
    if (escaped) escaped = false
    else if (inString && char === '\\') escaped = true
    else if (char === '"') inString = !inString
  }
  try { return JSON.parse(normalized) } catch {
    throw new HttpError(502, 'AI_RESULT_JSON_INVALID', '回答结构校验失败')
  }
}
