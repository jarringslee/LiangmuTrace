import { knowledgeChunks } from '../knowledge/herbs.js'

export const DOMAIN_REFUSAL = '很抱歉，我主要陪你聊中药材、中医健康科普和批次溯源，也可以日常聊两句，或介绍良木药谷怎么用；编程等专业问题暂时帮不上忙哦～'
export const MEDICAL_REFUSAL = '这个问题与中医用药有关，不是超出聊天范围。不过不能仅凭描述判断体质或直接推荐个人用药。可以先了解相关概念和一般注意事项；具体选药、剂量及特殊人群用药，请让有资质的医生结合实际情况判断。（健康科普仅供参考，不能替代诊疗）'
// 拦截个人诊疗/选药/剂量请求，而不是看见“副作用、配伍、脾虚”就整类拒答。
export const medicalTopic = /(?:吃|喝|服用|用药|用量|剂量).*(?:多少|几克|几毫|几次)|(?:多少|几克|剂量|用量).*(?:吃|喝|服|药)|(?:可以吃|该吃|要吃|吃什么|喝什么|推荐.*药|开个.*方|开药|开处方)|(?:我|本人|孩子|宝宝|孕妇|怀孕|哺乳).*(?:能吃|能喝|服用|诊断|治疗|症状|配伍)|(?:帮我|给我).*(?:诊断|治病|治疗|处方|药方)/u
export const offTopic = /^\s*\/|\b(?:tcp|udp|react|javascript|typescript|useEffect)\b|前端|算法|编程|写代码|股票|彩票|天气预报/iu
export const greeting = /^(你好|您好|嗨|hello|hi|谢谢|感谢|再见)[！!。.?？\s]*$/iu
export const followupTopic = /继续|详细|展开|再说|刚才|上一|为什么|它的|两者/u
export const batchFactTopic = /批次|溯源|本批|这批|该批|当前批|登记|档案|阶段|状态|质检|检测|加工|审核|仓储|收货|出库|运输|种植机构|种植商|种植日期|时间线/u
export const platformTopic = /你是谁|你能做什么|怎么使用|如何使用|怎么注册|如何注册|(?:怎么|如何|怎样|哪里).*(?:查看|查询|打开|使用|进入).*溯源|(?:系统|平台|良木).*(?:功能|使用|入口|客服|聊天室|消息|订单|支付|注册|账号|停用|启用)/u
export const knowledgeTopic = /中药|中医|药材|草药|配伍|养生|健康|脾虚|气虚|阴虚|阳虚|气血|经络|体质|阴阳|五行|穴位|功效|副作用|禁忌|是什么|介绍|科普|区别/u

export function mentionedHerbs(question: string): string[] {
  return [...new Set(knowledgeChunks.map(chunk => chunk.herbName))].filter(name => question.includes(name))
}
export function allowedGeneral(question: string) {
  return !offTopic.test(question) && !medicalTopic.test(question)
}
