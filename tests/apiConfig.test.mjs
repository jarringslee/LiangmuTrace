import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'vite'

let vite, resolveApiConfig
before(async () => {
  vite = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-tests/api-config',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  ;({ resolveApiConfig } = await vite.ssrLoadModule('/src/config/apiConfig.ts'))
})
after(async () => { await vite?.close() })

test('模式缺省与显式非法值分开，配置错误不悄悄降级', () => {
  assert.deepEqual(resolveApiConfig({ production: false }), { authMode: 'demo', apiBaseUrl: '/api' })
  assert.deepEqual(resolveApiConfig({ mode: 'api', production: true }), { authMode: 'api', apiBaseUrl: '/api' })
  for (const mode of ['', 'API', 'unknown']) assert.throws(() => resolveApiConfig({ mode, production: false }), /VITE_AUTH_MODE/)
})

test('同源与完整接口地址正规化；开发可 HTTP、生产跨域必须 HTTPS', () => {
  for (const baseUrl of ['/api', ' /api/// ', ' https://API.example.test:443/api/// ']) {
    assert.equal(resolveApiConfig({ baseUrl, production: true }).apiBaseUrl,
      baseUrl.includes('https') ? 'https://api.example.test/api' : '/api')
  }
  assert.equal(resolveApiConfig({ baseUrl: 'http://localhost:4000/api', production: false }).apiBaseUrl, 'http://localhost:4000/api')
  assert.throws(() => resolveApiConfig({ baseUrl: 'http://localhost:4000/api', production: true }), /HTTPS/)
})

test('Cookie API 生产模式拒绝完整跨站地址，要求真实同源代理', () => {
  for (const baseUrl of ['https://api.example.test/api', 'https://liangmu-trace-api.onrender.com/api']) {
    assert.throws(() => resolveApiConfig({ mode: 'api', baseUrl, production: true }), /必须为 \/api/)
  }
  assert.equal(resolveApiConfig({ mode: 'api', baseUrl: 'https://api.example.test/api', production: false }).apiBaseUrl,
    'https://api.example.test/api')
})

test('拒绝空值、错路径、非 HTTP 协议与地址中的私密/查询数据，不回显原值', () => {
  for (const baseUrl of ['', ' ', '/', '/backend/api', '//api.example.test/api', 'file:///api',
    'https://api.example.test', 'https://api.example.test/v1/api', 'https://',
    'https://user:private-sentinel@api.example.test/api', 'https://api.example.test/api?key=private-sentinel',
    'https://api.example.test/api#private-sentinel']) {
    assert.throws(() => resolveApiConfig({ baseUrl, production: true }), (error) =>
      /VITE_API_BASE_URL/.test(error.message) && !error.message.includes('private-sentinel'))
  }
})

test('真实 Vite 构建在非法模式、HTTP 生产接口或 VITE_ 密钥配置时提前失败', { timeout: 30_000 }, () => {
  const cases = [
    [{ VITE_AUTH_MODE: 'invalid' }, /VITE_AUTH_MODE 必须/],
    [{ VITE_API_BASE_URL: 'http://api.example.test/api' }, /HTTPS/],
    [{ VITE_API_BASE_URL: 'https://liangmu-trace-api.onrender.com/api' }, /必须为 \/api/],
    ...['VITE_DEEPSEEK_API_KEY', 'VITE_DATABASE_URL', 'VITE_JWT_SECRET'].map((key) =>
      [{ [key]: 'private-sentinel' }, /属于服务端私密配置/]),
  ]
  for (const [override, expected] of cases) {
    const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir',
      'node_modules/.vite-tests/invalid-config-build'], {
      env: { ...process.env, VITE_AUTH_MODE: 'api', VITE_API_BASE_URL: '/api', ...override },
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expected)
    assert.doesNotMatch(result.stdout + result.stderr, /private-sentinel|modules transformed/)
  }
})

test('Pages 静态资源规则有明确目标且在 SPA fallback 前，不误写成跨域 API 代理', () => {
  const rules = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
  assert.deepEqual(rules, [
    ['/data/*', '/data/:splat', '200'], ['/images/*', '/images/:splat', '200'],
    ['/assets/*', '/assets/:splat', '200'], ['/*', '/index.html', '200'],
  ])
})
