import { knowledgeChunks } from '../knowledge/herbs.js'

/** 用于选择科普路径，不是命中就拒答的关键词黑名单。 */
export const healthTopic = /中医|中药|药材|草药|医学|养生|健康|脾虚|气虚|阴虚|阳虚|气血|体质|配伍|功效|副作用|不良反应|禁忌|症状|诊断|处方|药方|用药|剂量|用量|服用|服药|停药|换药|孕妇|怀孕|哺乳|几克|几毫克|多少克|吃多少|疗程/u

export const HEALTH_POLICY = `健康问题以科普方式正常回答，不因“吃什么中药、推荐药材、脾虚”等词直接拒答。
用户问常见药材时，可以根据本轮来源介绍药材名称、传统分类、传统用途和一般注意事项；不能把介绍写成针对提问者的用药推荐，不能仅根据症状对应某个方剂供其自行尝试。
不判断用户属于某个证型或确诊疾病；不生成具体用药剂量、频次、疗程、服药间隔、可直接照做的配方比例；不建议自行停药、换药或增减药量。问到这些内容时，先讲有依据的一般知识，再简短建议具体方案咨询医生，不整段拒答。
孕期、儿童、慢性病、正在用药等情况只说明一般风险，不作个体适用性结论；严重或持续不适应建议及时就医。
传统功效明确归属于中医理论或资料记载，不宣称现代临床有效性已经证实。不能靠免责声明给出以上具体方案。
直接回答用户的问题，不输出“命中了规则、不是超出范围、后台校验、允许回答、本轮检索”等内部说明，也不重复本段限制清单。资料不足时自然说明尚未找到可靠信息。健康科普结尾简短注明“健康科普仅供参考，不能替代诊疗”。`

export const HEALTH_SAFE_ALTERNATIVE = '具体用量、疗程和个人用药需要医生结合实际情况确定。你可以继续了解药材的传统用途、一般风险和注意事项。（健康科普仅供参考，不能替代诊疗）'

const number = '(?:\\d+(?:[.．]\\d+)?|[一二两三四五六七八九十百半]+)'
const dose = new RegExp(`${number}\\s*(?:毫克|微克|毫升|克|片|粒|丸|袋|滴|mg\\b|mcg\\b|ml\\b|g\\b)`, 'iu')
const massDose = new RegExp(`${number}\\s*(?:毫克|微克|毫升|克|mg\\b|mcg\\b|ml\\b|g\\b)`, 'iu')
const schedule = new RegExp(`(?:每日|每天|一天|一日|每次|一次|早晚)[^。！？\\n]{0,12}${number}\\s*次|(?:连服|疗程|服药|服用)[^。！？\\n]{0,12}${number}\\s*(?:天|日|周|月)`, 'u')
const interval = new RegExp(`(?:间隔|隔开|相隔)[^。！？\\n]{0,8}${number}\\s*(?:小时|分钟)`, 'u')
const diagnosis = /(?:你|您|孩子|宝宝)(?:的(?:情况|症状|体质))?[^。！？\n]{0,16}(?:患有|得了|确诊为|诊断为|就是|属于|是典型的|是|为)[^。！？\n]{0,12}(?:脾虚|气虚|阴虚|阳虚|湿热|疾病|胃炎|病|症|证|体质)/u
const personalMedicine = /(?:你|您)(?:可以|应该|应当|适合|必须)[^。！？\n]{0,8}(?:服用|吃|喝|使用)[^。！？\n]{0,12}(?:药|丸|汤|散|胶囊|颗粒)|(?:建议|应该|可以|请|直接)[^。！？\n]{0,8}(?:停药|停用[^。！？\n]{0,6}药|换药|减药|加量)/u
const namedMedicine = [...new Set(knowledgeChunks.map(chunk => chunk.herbName))]
const personalHerb = /(?:[你您](?:可以|应该|应当|适合|必须)|建议(?:你|您)?)[^。！？\n]{0,8}(?:服用|吃|喝|使用)([^。！？\n]{1,20})/u

/** 只兜明显的剂量/个体诊断，不拦年份、批次号、植物尺寸或一般知识。不是完整医学安全系统。 */
export function unsafeHealthAnswer(answer: string, health = true): boolean {
  const text = answer.replace(/\[(?:knowledge|batch|event):[^\]]+\]/g, '')
  return text.split(/[。！？\n，；]/u).some(sentence => {
    const dosing = /服用|口服|煎服|煎药|每日|每天|一天|每次|剂量|用量|配方|药方/u.test(sentence)
      || /^\s*(?:[-*]\s*)?[\p{Script=Han}]{2,8}[：:]/u.test(sentence)
    const named = namedMedicine.some(name => sentence.includes(name))
    if (health && (dosing && dose.test(sentence)
      || named && massDose.test(sentence) && !/批次|净重|重量/u.test(sentence)
      || (/药|服用|口服|煎服/u.test(sentence) || named) && (schedule.test(sentence) || interval.test(sentence)))) return true
    const herb = personalHerb.exec(sentence)
    const match = diagnosis.exec(sentence) ?? personalMedicine.exec(sentence)
      ?? (herb && namedMedicine.some(name => herb[1].includes(name)) ? herb : null)
    if (!match) return false
    // “不能判断你属于……”是解释边界，不是诊断。
    const before = sentence.slice(0, match.index)
    return !/(?:不能|无法)[^，；]{0,12}(?:判断|确定|认定|断言|说)[^，；]{0,8}$|(?:不代表|不等于)[^，；]{0,8}$|(?:不|不要|不应|切勿|不可|不宜|避免)$/u.test(before)
      && !/^\s*(?:请)?(?:不要|不应|切勿|不可|不能|不宜|避免)/u.test(sentence)
  })
}

/** 仅移除不合适的完整句子，尽量保留可核对的科普内容；来源关系由调用方重新映射。 */
export function omitUnsafeHealthSentences(answer: string, health: boolean): string {
  return answer.split(/(?<=[。！？；\n])(?![ \t]*\[(?:knowledge|batch|event):)/u)
    .filter(sentence => !unsafeHealthAnswer(sentence, health)).join('').trim()
}

/** 医学预览仅发送已闭合的安全句子，防止“10”/“克”跨增量时先泄露用量。 */
export function healthAnswerPreview(
  onAnswer: ((text: string) => void | Promise<void>) | undefined, health: boolean,
): typeof onAnswer {
  if (!onAnswer || !health) return onAnswer
  let last = '', blocked = false
  return async text => {
    if (blocked) return
    const end = Math.max(...['。', '！', '？', '!', '?', '\n', '；'].map(char => text.lastIndexOf(char)))
    if (end < 0) return
    const complete = text.slice(0, end + 1)
    if (unsafeHealthAnswer(complete)) { blocked = true; return }
    if (complete !== last) { await onAnswer(complete); last = complete }
  }
}
