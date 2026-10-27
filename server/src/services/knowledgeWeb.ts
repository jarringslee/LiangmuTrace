import { createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from '../config/env.js'
import type { QuestionSource } from './knowledgeSearch.js'

export type KnowledgeWeb = { search(question: string, topic: string, signal: AbortSignal): Promise<QuestionSource[]> }

/** 仅可信站点；模型不决定 URL，后端也不直接 fetch 用户提供的地址。 */
export function knowledgeWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const host = url.hostname
    if (!(host === 'hkbu.edu.hk' || host.endsWith('.hkbu.edu.hk')
      || ['www.iplant.cn', 'www.cmro.gov.hk'].includes(host))) return null
    if (host === 'sys01.lib.hkbu.edu.hk' && url.pathname !== '/cmed/mmid/detail.php') return null
    if (host === 'www.iplant.cn' && !(/^\/bk\/[A-F\d]+$/iu.test(url.pathname)
      || /^\/info\/[\p{Script=Han}]+$/u.test(decodeURIComponent(url.pathname))
        && [...url.searchParams].every(([key, value]) => key === 't' && value === 'z'))) return null
    if (host === 'www.cmro.gov.hk' && !/^\/(?:html|files)\//.test(url.pathname)) return null
    if (/redirect|login|logout|oauth/i.test(url.pathname)) return null
    url.protocol = 'https:'; url.hash = ''
    return url.href.length <= 500 ? url.href : null
  } catch { return null }
}

const responseSchema = z.object({ results: z.array(z.object({
  title: z.string().max(2_000), url: z.string().max(8_192),
  summary: z.string().max(30_000).optional(), snippet: z.string().max(5_000).optional(),
})).max(50) })

export function createKnowledgeWeb(fetcher: typeof fetch = fetch): KnowledgeWeb {
  // 缓存仅含公开知识，不含账号/批次；不把搜索摘要自动永久写入受维护的知识库。
  const cache = new Map<string, { until: number; sources: QuestionSource[] }>()
  return { async search(question, topic, signal) {
    // 只发送知识主题，不发历史、批次资料、编号、URL 或联系方式；禁止用户注入搜索操作符。
    const clean = (text: string) => text.replace(/\bYM-[A-Z0-9-]+\b/gi, '')
      .replace(/https?:\/\/\S+|\S+@\S+|\d{5,}/g, '').replace(/[^\p{Script=Han}\s]/gu, ' ').trim()
    const subject = clean(topic === '中药与健康科普' ? question : `${topic} ${question}`).slice(0, 58)
    if (!subject || !env.DEEPSEEK_API_KEY) return []
    const query = `${subject} 中药科普 site:hkbu.edu.hk OR site:cmro.gov.hk OR site:iplant.cn`.slice(0, 128)
    const cached = cache.get(query)
    if (cached && cached.until > Date.now()) return structuredClone(cached.sources)
    const combined = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    try {
      const response = await fetcher('https://api.deepseek.com/v1/tools/search', {
        method: 'POST', headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count: 6, need_content: false }), signal: combined,
      })
      if (!response.ok || !response.body) { await response.body?.cancel(); return [] }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let raw = '', bytes = 0
      try {
        while (true) {
          combined.throwIfAborted()
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.length
          if (bytes > 512_000) return []
          raw += decoder.decode(part.value, { stream: true })
        }
        raw += decoder.decode()
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      const parsed = responseSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return []
      const urls = new Set<string>(), sources: QuestionSource[] = []
      for (const result of parsed.data.results) {
        const url = knowledgeWebUrl(result.url), excerpt = (result.summary || result.snippet || '').trim().slice(0, 780)
        if (!url || urls.has(url) || !excerpt || !result.title.trim()) continue
        urls.add(url)
        sources.push({ id: `knowledge:web:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
          kind: 'knowledge', title: result.title.trim().slice(0, 200), excerpt,
          publisher: `${new URL(url).hostname}（联网检索摘要）`, url })
        if (sources.length === 4) break
      }
      if (cache.size >= 100) cache.delete(cache.keys().next().value!)
      cache.set(query, { until: Date.now() + (sources.length ? 6 * 60 * 60_000 : 60_000), sources })
      return structuredClone(sources)
    } catch {
      signal.throwIfAborted()
      return [] // 搜索失败不伪装成模型知识或批次事实，也不重复付费调用。
    }
  } }
}
export const knowledgeWeb = createKnowledgeWeb()
