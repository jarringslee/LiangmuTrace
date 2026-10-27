import { HttpError } from '../middleware/error.js'

/** 仅清理旧版固定回复的内部说明，读取时转换，不改写数据库历史。 */
export function customerAssistantText(answer: string): string {
  const text = answer.replace(/^这个问题与中医用药有关，不是超出聊天范围。不过/u, '')
    .replace('；列表、扫码和输码均可进入，不要求先扫码。', '。')
    .replace('，不能借用当前批次资料回答。', '。')
    .replace('；我不会自行猜测你指的是哪一批。', '。')
  return text || '你可以换个更具体的问法试试。'
}

export function assistantErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'AI_TIMEOUT': return '这次回答等得有点久，请稍后再问一次吧～'
    case 'AI_QUESTION_STALE': return '批次资料刚刚有更新，请重新提问，我会查看最新档案。'
    case 'AI_RATE_LIMITED': return '提问有点快，稍等一会儿再试吧～'
    case 'AI_QUESTION_RUNNING': return '上一条问题还在回答，请等待完成或先停止。'
    default: return '刚刚系统有点开小差，再问一遍试试吧～'
  }
}

/** 保留诊断码，不向客户端转发模型、数据库或解析器的内部消息。 */
export function publicAssistantError(error: unknown): unknown {
  if (error instanceof HttpError && (error.code.startsWith('AI_') || error.code === 'ASSISTANT_STORAGE_NOT_READY'))
    return new HttpError(error.status, error.code, assistantErrorMessage(error.code))
  return error
}
