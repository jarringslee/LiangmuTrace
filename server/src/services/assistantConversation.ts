import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { deepseekAuditModel, type AuditModel, type ChatMessage } from '../lib/deepseek.js'
import { HttpError } from '../middleware/error.js'
import { createAssistantService } from './assistant.js'
import { createHerbQuestionService } from './herbQuestion.js'
import { createAssistantStore, type AssistantStore, type StoredAssistantTurn } from './assistantStore.js'
import type { AuthService, AuthUser } from './auth.js'
import type { BatchDetailRecord, BatchService } from './batches.js'
import type { QuestionSource } from './knowledgeSearch.js'
import { allowedGeneral, batchFactTopic, DOMAIN_REFUSAL, followupTopic, greeting, medicalTopic, MEDICAL_REFUSAL, mentionedHerbs, offTopic, platformTopic } from './assistantDomain.js'

export const conversationMessageSchema = z.object({
  requestId: z.string().uuid(), question: z.string().trim().min(2).max(500),
  batchIdentifier: z.string().trim().min(1).max(150).nullable().default(null),
}).strict()
export type ConversationInput = z.infer<typeof conversationMessageSchema>
type BatchLabel = { id: string; herbName: string; batchNo: string }
type Reply = { id: string; scope: 'general' | 'batch' | 'knowledge'; herbName?: string; batchId: string | null; question: string;
  status: 'answered' | 'insufficient'; answer: string; citations: Omit<QuestionSource, 'excerpt'>[];
  mode: 'api'; modelName: string | null; createdAt: string }
export type ConversationTurn = { id: string; question: string; batch: BatchLabel | null;
  status: StoredAssistantTurn['status']; createdAt: string; reply?: Reply; error?: string }

function contextHistory(records: StoredAssistantTurn[], user: AuthUser, batch: BatchDetailRecord | null, herbName: string | null): ChatMessage[] {
  // 最多 4 轮 / 8 条，只有当前身份、当前批次版本的历史进入模型。
  return records.filter((turn) => turn.status === 'done' && turn.reply
    && turn.actorRole === user.role && turn.actorOrganizationId === user.organizationId
    && !offTopic.test(turn.question) && !offTopic.test((turn.reply as unknown as Reply).answer)
    && (batch ? turn.batchId === batch.id && turn.batchVersion === batch.version
      : herbName ? (turn.reply as unknown as Reply).scope === 'knowledge' && (turn.reply as unknown as Reply).herbName === herbName
        : !turn.batchId && !turn.batchLabel && (turn.reply as unknown as Reply).scope === 'general'
          && (allowedGeneral(turn.question) || followupTopic.test(turn.question))))
    .slice(-4).flatMap((turn): ChatMessage[] => {
      const reply = turn.reply as unknown as Reply
      const answer = reply.answer.slice(0, 1_000)
      return [{ role: 'user', content: turn.question }, { role: 'assistant',
        // JSON 模式的历史助手消息也保持 JSON，避免纯文本示例干扰结构化输出。
        content: JSON.stringify({ status: reply.status,
          answer: batch || herbName ? answer : answer.replace(/\[(?:batch|knowledge|event):[^\]]+\]/g, ''),
          // RAG 历史保持三字段结构，但旧引用不是本轮资料；本轮仍校验 sources。
          ...(batch || herbName ? { sourceIds: reply.citations.filter((source) => answer.includes(`[${source.id}]`)).map((source) => source.id) } : {}) }) }]
    })
}

export function createAssistantConversationService(options: {
  batches: Pick<BatchService, 'detail'>; auth: Pick<AuthService, 'currentUser'>; store?: AssistantStore; model?: AuditModel
}) {
  const store = options.store ?? createAssistantStore()
  const general = createAssistantService(options.model ?? deepseekAuditModel)
  const rag = createHerbQuestionService(options.batches, options.model ?? deepseekAuditModel)
  const sameIdentity = async (user: AuthUser) => {
    const current = await options.auth.currentUser(user.id)
    if (current.role !== user.role || current.organizationId !== user.organizationId)
      throw new HttpError(403, 'FORBIDDEN', '身份权限已经变化，请重新登录')
  }
  const safeTurn = async (user: AuthUser, turn: StoredAssistantTurn, visible: Map<string, boolean>): Promise<ConversationTurn> => {
    let allowed = turn.actorRole === user.role && turn.actorOrganizationId === user.organizationId
    if (allowed && turn.batchLabel) {
      if (!turn.batchId) allowed = false // 批次被删除后不泄漏历史快照。
      else {
        if (!visible.has(turn.batchId)) {
          try { await options.batches.detail(user, turn.batchId); visible.set(turn.batchId, true) } catch (error) {
            if (error instanceof HttpError && (error.status === 404 || error.status === 403)) visible.set(turn.batchId, false)
            else throw error
          }
        }
        allowed = visible.get(turn.batchId)!
      }
    }
    const createdAt = turn.createdAt.toISOString()
    if (!allowed) {
      const question = '历史记录（当前权限不可查看）'
      return { id: turn.requestId, question, batch: null, status: 'done', createdAt,
        reply: { id: turn.requestId, question, scope: 'general', batchId: null, status: 'insufficient',
          answer: '身份或批次访问权限已变化，原问题、回答和来源已隐藏。', citations: [], mode: 'api', modelName: null, createdAt } }
    }
    const interrupted = turn.status === 'pending' && Date.now() - turn.createdAt.getTime() > 65_000
    return { id: turn.requestId, question: turn.question, batch: turn.batchLabel as BatchLabel | null,
      status: interrupted ? 'stopped' : turn.status, createdAt,
      ...(turn.status === 'done' && turn.reply ? { reply: turn.reply as unknown as Reply } : {}),
      ...(turn.status === 'error' ? { error: ({
        AI_RESULT_JSON_INVALID: '模型返回的 JSON 不完整，请手动重新提问。',
        AI_RESULT_SCHEMA_INVALID: '模型回答字段不符合约定，请手动重新提问。',
        AI_RESULT_CITATIONS_INVALID: '回答依据未通过校验，请手动重新提问。',
        AI_INCOMPLETE_RESPONSE: '回答生成中断，未保存为成功回答，请手动重新提问。',
        AI_TIMEOUT: '回答超时，请手动重新提问。',
      } as Record<string, string>)[turn.errorCode ?? ''] ?? '回答失败，请手动重新提问；不会自动重复调用模型。' } : {}) }
  }
  const read = async (user: AuthUser) => {
    const snapshot = await store.read(user.id)
    const visible = new Map<string, boolean>()
    const turns: ConversationTurn[] = []
    for (const turn of snapshot.turns) turns.push(await safeTurn(user, turn, visible))
    await sameIdentity(user)
    return { conversationId: snapshot.conversationId, mode: 'api' as const, turns }
  }

  return { read, async send(user: AuthUser, raw: ConversationInput, signal?: AbortSignal, onAnswer?: (text: string) => void): Promise<ConversationTurn> {
    const input = conversationMessageSchema.parse(raw)
    signal?.throwIfAborted()
    const previous = await store.find(user.id, input.requestId)
    const replay = async (turn: StoredAssistantTurn) => {
      if (turn.question !== input.question || turn.requestedIdentifier !== input.batchIdentifier)
        throw new HttpError(409, 'AI_REQUEST_CONFLICT', '同一请求标识不能用于不同问题')
      if (turn.status === 'pending' && Date.now() - turn.createdAt.getTime() <= 65_000)
        throw new HttpError(409, 'AI_QUESTION_RUNNING', '这条问题仍在处理，请稍后刷新历史')
      const safe = await safeTurn(user, turn, new Map())
      await sameIdentity(user)
      return safe
    }
    if (previous) return replay(previous)

    // 明确编号优先于旧标签；多个编号不猜测、不跨组织枚举。
    const codes = [...new Set((input.question.match(/\bYM-(?:[A-Z0-9]+-)*[A-Z0-9]+\b/gi) ?? []).map((code) => code.toUpperCase()))]
    const plain = input.question.replace(/^对于[^，,\n]{1,150}[，,]\s*/u, '').trim()
    const names = mentionedHerbs(plain)
    const records = (await store.read(user.id)).turns
    const latest = records.slice().reverse().find(turn => turn.status === 'done' && turn.reply
      && turn.actorRole === user.role && turn.actorOrganizationId === user.organizationId)
    const lastReply = latest?.reply as unknown as Reply | undefined
    const followup = followupTopic.test(plain)
    const medical = medicalTopic.test(plain), unrelated = offTopic.test(plain)
    // “如何使用审核功能”是平台帮助；“平台登记的本批次产地”仍是具体事实。
    const systemHelp = platformTopic.test(plain) && !codes.length
      && !/本批|这批|该批|当前批|登记|(?:这个|该|当前).*批次/u.test(plain)
    const explicitBatch = codes.length > 0 || !systemHelp && batchFactTopic.test(plain)
    const ordinary = greeting.test(plain) || systemHelp
      || !explicitBatch && !names.length && followup && lastReply?.scope === 'general'
        && !!latest && !offTopic.test(latest.question) && !offTopic.test(lastReply.answer)
    let herbName = !explicitBatch && names.length === 1 ? names[0] : null
    if (!herbName && !ordinary && !explicitBatch && !names.length && followup && lastReply?.scope === 'knowledge'
      && latest?.requestedIdentifier === input.batchIdentifier) herbName = lastReply.herbName ?? null
    const subject = explicitBatch || /产地|来源|外观|是什么|哪里|哪儿|介绍|继续|详细|它|这个|那个|刚才|上一|展开|再说|为什么/u.test(plain)
    let batch: BatchDetailRecord | null = null
    let clarification: string | null = codes.length > 1 ? '一次先查询一个批次，请明确选择一个批次号。' : null
    const identifier = codes[0] ?? input.batchIdentifier
    if (!clarification && !medical && !unrelated && !herbName && (codes.length || !ordinary && subject)) {
      if (!identifier) clarification = '请从药材详情带入批次，或在问题中提供完整批次号/溯源码；列表、扫码和输码均可进入，不要求先扫码。'
      else {
        batch = await options.batches.detail(user, identifier)
        if (names.some((name) => name !== batch!.herbName))
          clarification = '问题提到其他药材，请切换对应批次或提供完整批次号，不能借用当前批次资料回答。'
      }
    }
    if (medical) { clarification = MEDICAL_REFUSAL; herbName = null }
    else if (unrelated || !ordinary && !batch && !herbName && !clarification) clarification = DOMAIN_REFUSAL
    else if (!codes.length && names.length > 1) { clarification = '请先询问一种药材，再逐一比较；通用知识不需要绑定批次。'; batch = null; herbName = null }
    signal?.throwIfAborted()
    const { turn, claimed } = await store.begin(user, { requestId: input.requestId, question: input.question,
      requestedIdentifier: input.batchIdentifier, batch })
    if (!claimed) return replay(turn)
    try {
      signal?.throwIfAborted()
      const history = contextHistory(records, user, batch, herbName)
      const emitAnswer = onAnswer ? async (text: string) => {
        signal?.throwIfAborted()
        // 流式正文也受身份/批次授权保护，而不是仅在整段生成结束时复核。
        await sameIdentity(user)
        if (batch) {
          const current = await options.batches.detail(user, batch.id)
          if (current.version !== batch.version) throw new HttpError(409, 'AI_QUESTION_STALE', '批次资料已经变化，请重新提问')
        }
        signal?.throwIfAborted()
        onAnswer(text)
      } : undefined
      let reply: Reply
      if (clarification) reply = { id: randomUUID(), question: input.question, scope: 'general', batchId: null,
        status: 'insufficient', answer: clarification, citations: [], mode: 'api', modelName: null, createdAt: new Date().toISOString() }
      else if (batch) {
        const result = await rag.ask(user, batch.id, { question: input.question }, signal, history, emitAnswer)
        reply = { id: result.id, question: result.question, scope: 'batch', batchId: result.batchId,
          status: result.status, answer: result.answer, citations: result.citations.map(({ id, kind, title, publisher, url }) => ({ id, kind, title, publisher, url })),
          mode: 'api', modelName: result.modelName, createdAt: result.createdAt }
      } else if (herbName) {
        const result = await rag.askKnowledge(user, herbName, input.question, signal, history, emitAnswer)
        reply = { ...result, citations: result.citations.map(({ id, kind, title, publisher, url }) => ({ id, kind, title, publisher, url })) }
      } else reply = await general.ask(user, { question: input.question }, signal, history, true, emitAnswer)
      signal?.throwIfAborted()
      await sameIdentity(user)
      if (batch) {
        const latest = await options.batches.detail(user, batch.id)
        if (latest.version !== batch.version) throw new HttpError(409, 'AI_QUESTION_STALE', '批次资料已经变化，请重新提问')
      }
      signal?.throwIfAborted()
      const saved = await store.finish(user.id, turn, { status: 'done', reply: reply as unknown as Prisma.InputJsonValue })
      if (!saved) throw new HttpError(409, 'AI_REQUEST_STALE', '回答租约已失效，请刷新历史后重新提问')
      return safeTurn(user, saved, new Map())
    } catch (error) {
      const stopped = signal?.aborted || error instanceof Error && error.name === 'AbortError'
      await store.finish(user.id, turn, { status: stopped ? 'stopped' : 'error',
        errorCode: error instanceof HttpError ? error.code : stopped ? 'AI_CANCELLED' : 'AI_UPSTREAM_ERROR' })
      throw error
    }
  } }
}
export type AssistantConversationService = ReturnType<typeof createAssistantConversationService>
