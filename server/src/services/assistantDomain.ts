import { knowledgeChunks } from '../knowledge/herbs.js'

export const DOMAIN_REFUSAL = '很抱歉，我主要陪你聊中药材、中医健康科普和批次溯源，也可以日常聊两句，或介绍良木药谷怎么用；编程等专业问题暂时帮不上忙哦～'
export const offTopic = /^\s*\/|\b(?:tcp|udp|react|javascript|typescript|useEffect)\b|前端|算法|编程|写代码|股票|彩票|天气预报/iu
export const greeting = /^(你好|您好|嗨|hello|hi|谢谢|感谢|再见)[！!。.?？\s]*$/iu
export const followupTopic = /继续|详细|展开|再说|刚才|上一|为什么|它的|两者/u
export const batchFactTopic = /批次|溯源|本批|这批|该批|当前批|登记|档案|阶段|状态|质检|检测|加工|审核|仓储|收货|出库|运输|种植机构|种植商|种植日期|时间线/u
export const platformTopic = /你是谁|你能做什么|怎么使用|如何使用|怎么注册|如何注册|(?:怎么|如何|怎样|哪里).*(?:查看|查询|打开|使用|进入).*溯源|(?:溯源码|批次号)(?:是什么|是啥|有什么用|怎么获取|在哪里找)|(?:溯源码|批次号).*(?:查不到怎么办|查询不到怎么办|查询失败怎么办)|(?:系统|平台|良木).*(?:功能|使用|入口|客服|聊天室|消息|订单|支付|注册|账号|停用|启用)/u
export const knowledgeTopic = /中药|中医|药材|草药|配伍|养生|健康|脾虚|气虚|阴虚|阳虚|气血|经络|体质|阴阳|五行|穴位|功效|副作用|禁忌|是什么|介绍|科普|区别/u

export function mentionedHerbs(question: string): string[] {
  return [...new Set(knowledgeChunks.map(chunk => chunk.herbName))].filter(name => question.includes(name))
}
export function allowedGeneral(question: string) {
  return !offTopic.test(question)
}
