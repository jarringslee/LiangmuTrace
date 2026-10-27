export const TRACE_NOT_FOUND = '未查到该溯源码相关的药材批次信息，请核对后再试～'
export const BATCH_NOT_FOUND = '未查到该编号相关的药材批次信息，请核对后再试～'
export const INCOMPLETE_BATCH_CODE = '这个编号的格式似乎不完整，请核对溯源码或批次号后再试～'

/** 仅规范化复制时常见的字符差异，不纠正数字、不做模糊匹配，也不访问粘贴链接。 */
export function normalizeAssistantBatchText(question: string): string {
  return question.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63]/g, '-')
    .replace(/([A-Z0-9])[ \t]+-[ \t]+(?=YM-)/gi, '$1 / ')
    .replace(/[ \t]*-[ \t]*/g, '-')
}

export function readAssistantBatchCodes(question: string) {
  const text = normalizeAssistantBatchText(question)
  // 不把末尾残缺、下划线等非法字符之前的一截误认为完整编号。
  const matches = [...text.matchAll(/(?<![A-Z0-9_])YM-(?:[A-Z0-9]+-)*[A-Z0-9]+(?![A-Z0-9_-])/gi)]
  const markers = [...text.matchAll(/(?<![A-Z0-9_])YM(?=[-_]|TRACE|\d{4})/gi)]
  const malformed = markers.some(marker => !matches.some(match => marker.index >= match.index && marker.index < match.index + match[0].length))
    || matches.some(match => match[0].length > 150)
    || !matches.length && /(?:溯源码|批次号)\s*(?:是|为)?\s*[:：=]?\s*[A-Z0-9_]{2,}/i.test(text)
  return { codes: [...new Set(matches.map(match => match[0].toUpperCase()))], malformed }
}
