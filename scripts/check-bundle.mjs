import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

// 只递归静态 imports；dynamicImports 不是首屏必下载项。Set 同时去重并处理环。
export function collectStaticFiles(manifest, entries) {
  const visited = new Set()
  function visit(key) {
    if (visited.has(key)) return
    const chunk = manifest[key]
    assert.ok(chunk, `manifest 缺少 ${key}`)
    visited.add(key)
    for (const dependency of chunk.imports ?? []) visit(dependency)
  }
  entries.forEach(visit)
  return [...new Set([...visited].map((key) => manifest[key].file))]
}

export function inspectBundle(directory = 'dist') {
  // Pages 的认证依赖真实代理；静态 JS 构建成功不能代替代理文件交付。
  for (const file of ['_worker.js', '_routes.json']) {
    assert.equal(readFileSync(resolve(directory, file), 'utf8'),
      readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), `Pages 产物缺少或未同步 ${file}`)
  }
  const manifest = JSON.parse(readFileSync(resolve(directory, '.vite/manifest.json'), 'utf8'))
  const login = 'src/pages/login/index.tsx'
  const chart = 'src/components/charts/DashboardChart.tsx'
  const markdown = 'src/components/assistant/AssistantMarkdown.tsx'
  const buyer = 'src/pages/buyer/herbs/index.tsx'
  const routes = Object.keys(manifest).filter((key) => key.startsWith('src/pages/'))
  assert.equal(routes.length, 19, '19 个页面均应独立成为动态入口；新增页面时同步检查')
  assert.equal(manifest['src/pages/trace/Public.tsx']?.isDynamicEntry, true, '公开溯源页应独立延迟加载')
  routes.forEach((key) => assert.equal(manifest[key].isDynamicEntry, true, `${key} 不应提前导入`))
  assert.equal(manifest[chart]?.isDynamicEntry, true, '图表应独立延迟加载')
  assert.equal(manifest[markdown]?.isDynamicEntry, true, 'Markdown 应在回答出现时延迟加载')

  const entryFiles = collectStaticFiles(manifest, ['index.html'])
  const loginFiles = collectStaticFiles(manifest, ['index.html', login])
  for (const files of [entryFiles, loginFiles]) {
    for (const key of [...routes.filter((key) => key !== login), chart, markdown]) {
      assert.equal(files.includes(manifest[key].file), false, `首屏提前加载了 ${key}`)
    }
    assert.equal(files.includes(manifest[buyer].file), false, '登录页不应加载扫码所在采购商页')
  }
  const measure = (files) => files.reduce((total, file) => {
    const bytes = readFileSync(resolve(directory, file))
    total.rawBytes += bytes.length
    total.gzipBytes += gzipSync(bytes).length
    return total
  }, { rawBytes: 0, gzipBytes: 0 })
  const report = {
    routeEntries: routes.length,
    entry: measure(entryFiles),
    login: measure(loginFiles),
    chartChunk: measure([manifest[chart].file]),
  }
  // gzip 预算是体积回归门槛，不是性能评分；初次导航还会加载目标页面依赖。
  assert.ok(report.entry.gzipBytes < 350_000, '入口静态 JS gzip 超过 350 KB 预算')
  assert.ok(report.login.gzipBytes < 400_000, '完整登录首屏 JS gzip 超过 400 KB 预算')
  assert.ok(report.chartChunk.gzipBytes < 225_000, '按需图表块 gzip 超过 225 KB 预算')
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(inspectBundle(process.argv[2] ?? 'dist'), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
