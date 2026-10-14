import { HttpError } from '../middleware/error.js'

/** 只解码 JSON 的 answer 字符串；半个转义/Unicode 留到下一块，不用 eval 或修补 JSON。 */
export function partialAnswer(json: string): string {
  const start = /"answer"\s*:\s*"/.exec(json)
  if (!start) return ''
  let answer = ''
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const char = json[i]
    if (char === '"') break
    if (char !== '\\') { answer += char; continue }
    const escaped = json[++i]
    if (!escaped) break
    if (escaped === 'u') {
      const hex = json.slice(i + 1, i + 5)
      if (!/^[\da-f]{4}$/i.test(hex)) break
      answer += String.fromCharCode(parseInt(hex, 16)); i += 4
    } else {
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }
      if (!(escaped in escapes)) break
      answer += escapes[escaped]
    }
  }
  // 引用还未校验：生成中不展示内部来源 ID，最终帧才给正式引用编号。
  return answer.replace(/\[[^\]]*(?:\]|$)/g, '').replace(/[\uD800-\uDBFF]$/, '').slice(0, 3_000)
}

/** DeepSeek data-only SSE；网络块不是消息块，也不是一个汉字/一个 token。 */
export async function readModelStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, onAnswer: (text: string) => void | Promise<void>) {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', content = '', lastAnswer = '', finished = false, doneMarker = false
  const emit = async (force = false) => {
    const answer = partialAnswer(content)
    // 首段立即发，后续合并约24字再发；不加动画/延时，减少每个token触发数据库复核。
    if (answer && answer !== lastAnswer && (force || !lastAnswer || answer.length - lastAnswer.length >= 24)) {
      await onAnswer(answer); lastAnswer = answer
    }
  }
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!doneMarker) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(part.value, { stream: !part.done })
      if (buffer.length > 128_000) throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 流消息过大')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { doneMarker = true; break }
        let chunk: { choices?: { delta?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string | null }[]; error?: unknown }
        try { chunk = JSON.parse(data) } catch { throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 流返回了无效 JSON') }
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || chunk.error || !Array.isArray(chunk.choices)) throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 流格式不正确')
        const choice = chunk.choices[0]
        if (!choice) continue // 兼容只包含 usage 的空 choices 帧。
        if (choice.delta?.tool_calls?.length) throw new HttpError(502, 'AI_INVALID_RESULT', '问答不允许调用工具')
        if (choice.delta?.content != null) {
          if (typeof choice.delta.content !== 'string' || finished) throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 流正文格式不正确')
          content += choice.delta.content
          if (content.length > 24_000) throw new HttpError(502, 'AI_RESULT_SCHEMA_INVALID', 'AI 输出超过结构大小限制')
          await emit()
        }
        if (choice.finish_reason) {
          if (choice.finish_reason !== 'stop') throw new HttpError(502, 'AI_INCOMPLETE_RESPONSE', 'AI 回复未完成，请手动重试')
          await emit(true)
          finished = true
        }
      }
      if (part.done) break
    }
    signal.throwIfAborted()
    if (!doneMarker || !finished) throw new HttpError(502, 'AI_INCOMPLETE_RESPONSE', 'AI 流中断，回答未完成，请手动重试')
    return { content, toolCalls: [] }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
