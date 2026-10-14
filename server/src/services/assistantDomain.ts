import { knowledgeChunks } from '../knowledge/herbs.js'

export const DOMAIN_REFUSAL = '很抱歉，我只能回答中药材相关知识或是批次溯源相关信息哦～你也可以问我如何使用良木药谷。'
export const MEDICAL_REFUSAL = '我可以介绍药材基础知识和溯源资料，但不提供诊断、用量或治疗建议；这些问题请咨询具备资质的专业人员。'
export const medicalTopic = /剂量|用量|服用|怎么吃|能吃|能喝|治疗|治病|处方|孕妇|怀孕|哺乳|儿童|副作用|配伍|疗效|症状|诊断/u
export const offTopic = /^\s*\/|\b(?:tcp|udp|react|javascript|typescript|useEffect)\b|前端|算法|编程|写代码|股票|彩票|天气预报/iu
export const greeting = /^(你好|您好|嗨|hello|hi|谢谢|感谢|再见)[！!。.?？\s]*$/iu
export const followupTopic = /继续|详细|展开|再说|刚才|上一|为什么/u
export const batchFactTopic = /批次|溯源码|本批|这批|该批|当前批|登记|档案|阶段|状态|质检|检测|加工|审核|风险|仓储|收货|出库|运输|种植机构|种植商|种植日期|时间线/u
export const platformTopic = /你是谁|你能做什么|怎么使用|如何使用|怎么注册|如何注册|(?:系统|平台|良木).*(?:功能|使用|入口|客服|聊天室|消息|订单|支付|注册|账号|停用|启用)/u

export function mentionedHerbs(question: string): string[] {
  return [...new Set(knowledgeChunks.map(chunk => chunk.herbName))].filter(name => question.includes(name))
}
export function allowedGeneral(question: string) {
  return !offTopic.test(question) && (greeting.test(question) || platformTopic.test(question))
}
