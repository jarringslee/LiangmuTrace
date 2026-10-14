/** 来源链接只允许已使用的权威数据库记录，不允许模型拼任意 URL。 */
export function isKnowledgeSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (url.hostname === 'sys01.lib.hkbu.edu.hk') return url.pathname === '/cmed/mmid/detail.php'
    return url.hostname === 'www.iplant.cn' && /^\/info\/[\p{Script=Han}]+$/u.test(decodeURIComponent(url.pathname))
      && [...url.searchParams].every(([key, value]) => key === 't' && value === 'z')
  } catch { return false }
}
