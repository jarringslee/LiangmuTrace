/** 只判断可打开的地址格式；不证明文件存在，也不代替后端授权。 */
// 详情和时间线共用同一个判断，拒绝占位和不允许的协议，保留现有常见图片/PDF 地址。
export function getAttachmentHref(raw: string): string | null {
    const value = raw.trim()
    if (!value || value.startsWith('#') || value.includes('\\') || /\p{Cc}/u.test(value)) return null

    // 保留站内根路径，拒绝 // 开头的跨站地址。
    if (value.startsWith('/') && !value.startsWith('//')) return value
    // 兼容离线样例照片/PDF，但不允许任意 data: 页面。
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|application\/pdf);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value

    try {
        const parsed = new URL(value)
        if ((parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && !parsed.username && !parsed.password) return parsed.href
        if (parsed.protocol === 'blob:' && /^blob:https?:\/\//i.test(value)) return value
    } catch {
        return null
    }

    return null
}