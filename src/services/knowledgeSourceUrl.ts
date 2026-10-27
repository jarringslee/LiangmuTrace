/** 来源来自服务端可信站点检索，不允许模型或网络响应拼任意 URL。 */
export function isKnowledgeSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (url.hostname === 'sys01.lib.hkbu.edu.hk') return url.pathname === '/cmed/mmid/detail.php'
    if (url.hostname === 'www.iplant.cn') return /^\/bk\/[A-F\d]+$/iu.test(url.pathname)
      || /^\/info\/[\p{Script=Han}]+$/u.test(decodeURIComponent(url.pathname))
        && [...url.searchParams].every(([key, value]) => key === 't' && value === 'z')
    if (url.hostname === 'www.cmro.gov.hk') return /^\/(?:html|files)\//.test(url.pathname)
    return url.hostname.endsWith('.hkbu.edu.hk') && !/redirect|login|logout|oauth/i.test(url.pathname)
  } catch { return false }
}
