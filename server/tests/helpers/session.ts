import assert from 'node:assert/strict'

/** Node 测试显式模拟 Cookie；浏览器业务代码不能读取 HttpOnly 或 Set-Cookie。 */
export function sessionHeaders(token?: string | null): Record<string, string> {
  return {
    'X-Liangmu-CSRF': '1',
    ...(token ? { Cookie: `liangmu_session=${token}` } : {}),
  }
}

export function loginToken(response: Response): string {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('liangmu_session='))
  assert.ok(cookie, '登录必须通过 Set-Cookie 签发凭证')
  return cookie.split(';')[0]!.slice('liangmu_session='.length)
}
