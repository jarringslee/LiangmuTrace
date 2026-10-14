import { z } from 'zod'
import { env } from '../config/env.js'
import { HttpError } from '../middleware/error.js'
import { readModelStream } from './modelStream.js'

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties: Record<string, never>; additionalProperties: false }
  }
}

export type ModelRequest = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  json: boolean
  signal: AbortSignal
  onAnswer?: (text: string) => void | Promise<void>
}

export interface AuditModel {
  name: string
  complete(input: ModelRequest): Promise<{
    content: string | null
    toolCalls: ToolCall[]
  }>
}

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      content: z.string().nullable(),
      tool_calls: z.array(z.object({
        id: z.string().min(1).max(200),
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1).max(100),
          arguments: z.string().max(2_000),
        }),
      })).max(4).optional(),
    }),
  })).min(1),
})

/** 原生 fetch 已足够完成工具调用；测试注入 AuditModel，不调用付费接口。 */
export const deepseekAuditModel: AuditModel = {
  name: env.DEEPSEEK_MODEL,
  async complete(input) {
    if (!env.DEEPSEEK_API_KEY) {
      throw new HttpError(503, 'AI_NOT_CONFIGURED', '请在服务端配置 DeepSeek API Key 后重试')
    }
    let response: Response
    try {
      response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env.DEEPSEEK_MODEL,
          messages: input.messages,
          thinking: { type: 'disabled' },
          temperature: 0.1,
          max_tokens: 2_000,
          stream: Boolean(input.onAnswer),
          ...(input.json ? { response_format: { type: 'json_object' } } : {}),
          // 普通聊天没有工具；仅 Agent 传入工具时才要求工具调用。
          ...(!input.json && input.tools?.length
            ? { tools: input.tools, tool_choice: 'required' }
            : {}),
        }),
        signal: input.signal,
      })
    } catch {
      if (input.signal.aborted) {
        throw new HttpError(504, 'AI_TIMEOUT', 'AI 请求超时，请稍后重试')
      }
      throw new HttpError(502, 'AI_UNAVAILABLE', '暂时无法连接 AI 服务')
    }
    // 上游认证错误不能映射为本系统 401，否则前端会错误地退出登录。
    if (!response.ok) {
      throw new HttpError(
        response.status === 429 ? 503 : 502,
        'AI_UPSTREAM_ERROR',
        'AI 服务调用失败，请检查服务端配置或稍后重试',
      )
    }
    if (input.onAnswer) {
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel().catch(() => undefined)
        throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 服务没有返回有效事件流')
      }
      return readModelStream(response.body, input.signal, input.onAnswer)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      if (input.signal.aborted) {
        throw new HttpError(504, 'AI_TIMEOUT', 'AI 请求超时，请稍后重试')
      }
      throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 服务返回格式不正确')
    }
    const parsed = responseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new HttpError(502, 'AI_INVALID_RESPONSE', 'AI 服务返回格式不正确')
    }
    const choice = parsed.data.choices[0]
    if (!['stop', 'tool_calls'].includes(choice.finish_reason)) {
      throw new HttpError(502, 'AI_INCOMPLETE_RESPONSE', 'AI 回复未完成，请重试')
    }
    return {
      content: choice.message.content,
      toolCalls: choice.message.tool_calls ?? [],
    }
  },
}
