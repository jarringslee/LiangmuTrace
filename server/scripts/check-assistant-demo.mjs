import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// 独立验收命令：不会被 npm test 自动执行，不读 DeepSeek Key，不清理现有历史。
// 请求会真实调用模型并保存到当前账号；必须显式选择付费验收。
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  assert.ok(value && !value.startsWith('--'), `${name} 需要一个值`)
  return value
}
if (!args.includes('--allow-paid-ai')) {
  console.error('需要 --allow-paid-ai；会产生模型费用和账号历史。密码使用 AI_SMOKE_PASSWORD 环境变量。')
  process.exit(1)
}
const base = new URL(option('--base-url', 'http://localhost:4000/api'))
assert.ok(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))
assert.equal(base.pathname.replace(/\/$/, ''), '/api')
assert.ok(!base.username && !base.password && !base.search && !base.hash)
const password = process.env.AI_SMOKE_PASSWORD
assert.ok(password, '请设置 AI_SMOKE_PASSWORD，不将密码写入脚本或报告')
const api = base.href.replace(/\/$/, '')
const publicSuite = args.includes('--public-suite')
const streaming = args.includes('--stream')
let sessionCookie
async function request(path, body) {
  const response = await fetch(api + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(body ? { 'X-Liangmu-CSRF': '1' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(75_000),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${result.error?.code ?? 'UNKNOWN'}`),
    { status: response.status, code: result.error?.code })
  if (path === '/auth/login') {
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('liangmu_session='))
    assert.ok(cookie, '登录缺少认证 Cookie')
    sessionCookie = cookie.split(';')[0] // Node 脚本显式管理；浏览器业务代码不能读取 HttpOnly Cookie。
  }
  return result
}
const login = async () => {
  const result = await request('/auth/login', { account: option('--account', 'chenjingxuan'), password, role: 'buyer' })
  assert.ok(result.user)
  assert.equal('accessToken' in result, false)
}
const cases = []
async function streamRequest(input) {
  const response = await fetch(api + '/assistant/conversation/messages/stream', {
    method: 'POST', headers: { Cookie: sessionCookie, 'X-Liangmu-CSRF': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(75_000),
  })
  if (!response.ok) {
    const body = await response.json()
    throw new Error(`HTTP ${response.status}: ${body.error?.code ?? 'UNKNOWN'}`)
  }
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', count = 0, turn
  try {
    while (true) {
      const part = await reader.read()
      buffer += decoder.decode(part.value, { stream: !part.done })
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (frame.startsWith(':')) continue
        const lines = frame.split('\n'), event = lines.find(line => line.startsWith('event: '))?.slice(7)
        const raw = lines.find(line => line.startsWith('data: '))?.slice(6)
        if (!raw) continue
        const data = JSON.parse(raw)
        if (event === 'delta') { assert.equal(data.requestId, input.requestId); assert.equal(data.seq, ++count) }
        else if (event === 'result') turn = data.turn
        else if (event === 'error') throw new Error(`Stream error: ${data.code}`)
        else throw new Error('Unknown stream event')
      }
      if (part.done) break
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  assert.ok(turn, '缺少终态；不自动重跑请求，请先查询历史')
  if (turn.reply?.modelName) assert.ok(count > 0, '模型回复必须真的有增量正文')
  console.log(JSON.stringify({ streaming: true, question: input.question, deltaFrames: count }))
  return { turn }
}
async function ask(name, question, batch = null) {
  const input = { requestId: randomUUID(), question, batchIdentifier: batch?.id ?? null }
  const start = Date.now()
  const { turn } = streaming ? await streamRequest(input) : await request('/assistant/conversation/messages', input)
  assert.equal(turn.id, input.requestId)
  assert.equal(turn.question, question)
  assert.equal(turn.status, 'done')
  cases.push({ name, input, turn })
  console.log(JSON.stringify({ name, elapsedMs: Date.now() - start, scope: turn.reply.scope,
    status: turn.reply.status, model: turn.reply.modelName,
    answer: turn.reply.answer, sources: turn.reply.citations.map((source) => source.title) }))
  return turn
}
try {
  await login()
  const before = await request('/assistant/conversation')
  assert.ok(!before.turns.some((turn) => turn.status === 'pending'), '账号已有请求进行中，停止验收，不抢占用户请求')
  const { items } = await request('/batches?pageSize=100')
  const gc = items.find((batch) => batch.herbName === '甘草' && batch.auditStatus === 'approved')
  const hj = items.find((batch) => batch.herbName === '黄精' && batch.auditStatus === 'approved')
  assert.ok(gc && hj, '需要当前采购商可见、已审核的甘草和黄精样例；不自动 seed')
  if (!publicSuite) {
    const help = await ask('平台能力', '平台客服聊天现在可以使用吗？')
    assert.equal(help.reply.scope, 'general')
    const general = await ask('领域边界', 'tcp和udp的区别', gc)
    assert.equal(general.reply.scope, 'general')
    assert.equal(general.reply.status, 'insufficient')
    assert.equal(general.reply.modelName, null)
    const help2 = await ask('平台使用', '系统怎么使用？', gc)
    assert.equal(help2.reply.scope, 'general')
    const recall = await ask('普通多轮', '详细说一下刚才的使用方式', gc)
    assert.equal(recall.reply.scope, 'general')
    assert.doesNotMatch(recall.reply.answer, /React|useEffect/i)
    const origin = await ask('甘草事实与背景', '本批次登记产地在哪里？请与资料列举的甘草常见产区区分。', gc)
    assert.equal(origin.reply.scope, 'batch')
    assert.ok(origin.reply.citations.some((source) => source.id === 'batch:origin'))
  }
  const intro = await ask('甘草简介', '这是什么药材？', gc)
  assert.equal(intro.reply.scope, 'batch')
  assert.equal(intro.reply.status, 'answered')
  assert.match(intro.reply.answer, /甘草/)
  const changed = await ask('切换黄精', publicSuite ? '这个批次登记产地在哪里？' : '平台登记的这个黄精批次产地在哪里？', hj)
  assert.equal(changed.batch.id, hj.id)
  assert.ok(changed.reply.citations.some((source) => source.id === 'batch:origin'))
  assert.doesNotMatch(changed.reply.citations.map((source) => source.title).join(' '), /甘草/)
  if (streaming) {
    for (const herbName of ['山茱萸', '铁皮石斛']) {
      const knowledge = await ask(`${herbName}独立知识`, `${herbName}是什么`, gc)
      assert.equal(knowledge.reply.scope, 'knowledge')
      assert.equal(knowledge.reply.herbName, herbName)
      assert.equal(knowledge.reply.status, 'answered')
      assert.equal(knowledge.batch, null)
      assert.ok(knowledge.reply.citations.every(source => source.kind === 'knowledge'))
    }
    const refused = await ask('无关命令', '/model', gc)
    assert.equal(refused.reply.status, 'insufficient'); assert.equal(refused.reply.modelName, null)
  }
  if (!publicSuite) {
    const followup = await ask('黄精追问', '详细解释刚才的登记产地，哪些是本批次事实，哪些只是通用背景？', hj)
    assert.equal(followup.reply.scope, 'batch')
    assert.doesNotMatch(followup.reply.citations.map((source) => source.title).join(' '), /甘草/)
    const medical = await ask('健康科普', '脾虚可以吃什么中药')
    assert.equal(medical.reply.scope, 'knowledge')
    assert.equal(medical.reply.status, 'answered')
    assert.ok(medical.reply.modelName)
    assert.doesNotMatch(medical.reply.answer, /不是超出聊天范围|后台校验/)
    const count = (await request('/assistant/conversation')).turns.length
    await assert.rejects(request('/assistant/conversation/messages', { requestId: randomUUID(),
      question: 'YM-TRACE-2099-9999 的登记产地是什么？', batchIdentifier: null }), { status: 404 })
    assert.equal((await request('/assistant/conversation')).turns.length, count)
    const replayed = await request('/assistant/conversation/messages', cases[0].input)
    assert.deepEqual(replayed.turn, cases[0].turn)
    console.log('未知编号返回 404、不新增历史；同 UUID 重放原结果。越权路径由独立权限回归覆盖。')
  }
  // 重新获取 Token，证明读取来自该账号数据库，而非沿用旧客户端气泡。
  await login()
  const restored = await request('/assistant/conversation')
  for (const item of cases) assert.ok(restored.turns.some((turn) =>
    turn.id === item.turn.id && turn.reply?.answer === item.turn.reply.answer))
  console.log(JSON.stringify({ result: 'passed', base: api, cases: cases.length,
    completedModelReplies: cases.filter((item) => item.turn.reply.modelName).length,
    historyRestored: true, retainedDemoTurns: cases.length }))
} catch (error) {
  console.error(error instanceof Error ? error.message : '验收失败')
  process.exitCode = 1 // 不重试付费调用、不删除历史、不回退静态回复。
}
