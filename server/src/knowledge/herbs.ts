/**
 * 小型人工整理知识库，不是药典、不提供剂量和治疗建议。
 * HKBU 药材记录摘要 + 中科院植物智来源植物资料人工整理；不抓取图片或宣称药典鉴定。
 * retrievedAt 是本项目核对日期，不是原站发布时间；来源支持知识背景，不证明某批次质量。
 */
export const KNOWLEDGE_VERSION = 'herb-knowledge-v3'

export type KnowledgeChunk = {
  id: string
  herbName: string
  title: string
  content: string
  url: string
  publisher: string
  retrievedAt: string
}

const entries = [
  {
    herbName: '黄精', pid: 'B00075', retrievedAt: '2026-10-06',
    // 核对官方可检索摘要；本轮原页面直连 403，不冒充完整药典或网页全文采集。
    origin: '黄精属于根及根茎类药材，该记录介绍黄精植物 Polygonatum sibiricum 的干燥根茎。条目列举的常见产区包括内蒙古、陕西和河北；通用产区不能代替本批次登记产地。',
    appearance: '条目描述黄精根茎呈结节状，有较粗的盘状端和较细的圆柱状端，表面偏黄棕，可见皱纹、茎痕或环节。外观资料不能确认某批次品种、含量或安全性。',
  },
  {
    herbName: '丹参', pid: 'B00020',
    origin: '丹参属于根及根茎类药材，取自唇形科丹参植物的干燥根和根茎。资料列举的常见产区包括山东、江苏、安徽和四川。',
    appearance: '丹参根部通常细长并略弯，外表偏砖红，表面可见纵向沟纹，质地较脆。这些外观描述用于学习识别，不能替代专业鉴定或质检。',
  },
  {
    herbName: '黄芪', pid: 'B00071',
    origin: '黄芪属于根及根茎类药材，来源涉及豆科蒙古黄芪和膜荚黄芪的干燥根。资料列举的常见产区包括内蒙古、山西和河北。',
    appearance: '黄芪根条通常呈长圆柱形，外表偏浅棕黄色或浅棕褐色，带有纵向纹理，断面可观察到放射状纹理。描述并非某个批次的检测结论。',
  },
  {
    herbName: '当归', pid: 'B00049',
    origin: '当归属于根及根茎类药材，来自伞形科当归植物的干燥根。资料列举的常见产区包括甘肃、云南和青海。',
    appearance: '当归整体可见主根及分出的支根，外表多为黄棕色到棕褐色，带有纵向皱纹，断面偏黄白。外观资料不等于实际批次质量合格。',
  },
  {
    herbName: '甘草', pid: 'B00129',
    origin: '甘草属于根及根茎类药材，该记录介绍豆科甘草植物的干燥根及根茎。资料列举的常见产区包括内蒙古、山西、甘肃、新疆和宁夏。',
    appearance: '甘草根多为圆柱形，表面偏红棕或灰棕并带有纵向纹理，断面偏黄白，根茎可见芽痕。不能仅凭这些资料确认某批次品种或安全性。',
  },
  {
    herbName: '山茱萸', pid: 'B00234', retrievedAt: '2026-10-14',
    // 本轮核对 HKBU 可检索摘要；原站直连失败，不冒充完整药典原文。
    origin: '山茱萸属于果实及种子类药材，HKBU 条目介绍山茱萸植物 Cornus officinalis 的干燥成熟果肉。资料列举的常见产区包括河南、浙江和陕西；通用背景不能替代本批次登记产地。',
    appearance: '该条目摘要未提供足够的商品外观鉴别细节；植物形态可参考植物智资料，但不能用于判断本批次药材质量或安全。',
  },
] as const

// 2026-10-14 通过植物智公开物种页面及其 descall 资料核对；只保留基础植物学，不摘录疗效。
// 分布是来源植物的分布范围，不是商品药材主产区，更不是任何批次的实际产地。
const plantEntries = [
  { herbName: '黄连', plantName: '黄连', origin: '黄连的相关来源植物记录采用学名 Coptis chinensis，介绍其根状茎及植株形态。植物分布包括四川、贵州、湖北、湖南和陕西南部；常见生境为山地林中或阴湿山谷。', appearance: '黄连植株的叶片有长叶柄，叶片分裂，花葶上可生数朵花，萼片偏黄绿色。这是植物形态资料，不是对干燥药材或当前批次的鉴定。' },
  { herbName: '杜仲', plantName: '杜仲', origin: '杜仲 Eucommia ulmoides 是落叶乔木。植物智记录树皮可药用，并说明该植物现已在多地栽种；资料属于来源植物背景，不证明本批次所用部位或质量。', appearance: '杜仲树皮灰褐、较粗糙，植株具有丝状胶质，叶片互生且边缘有锯齿。果实扁平并带薄翅；这些形态不能替代药材鉴定。' },
  { herbName: '山茱萸', plantName: '山茱萸', origin: '山茱萸 Cornus officinalis 为落叶乔木或灌木，常生于林缘或森林中。植物分布包括山西、陕西、甘肃、河南、浙江等省；这是来源植物分布，不是当前批次的登记产地。', appearance: '山茱萸叶片对生，花呈黄色并可先于叶开放，核果呈较长椭圆形，成熟颜色为红到紫红。植物资料不能确认商品药材或批次安全性。' },
  { herbName: '柴胡', plantName: '北柴胡', origin: '本条介绍柴胡相关来源植物北柴胡 Bupleurum chinense 的基础背景，不是药典基原鉴定。北柴胡为多年生草本，分布包括东北、华北、西北、华东和华中，常见于向阳山坡及草丛。', appearance: '北柴胡主根较硬、偏褐色，茎上部多次分枝，叶片常呈披针形且叶鞘抱茎。植物资料不能确认某批次是否属于指定商品规格或质量合格。' },
  { herbName: '板蓝根', plantName: '菘蓝', origin: '本条介绍板蓝根相关的菘蓝来源植物背景，不能作为药典基原鉴定。植物智记录名称为菘蓝 Isatis tinctoria，为二年生草本，在我国多地栽培；不据此推断本批次的品种或产地。', appearance: '菘蓝茎上部可分枝，叶片形状在植株不同部位有所差异，花瓣黄色，果实边缘带翅。这是植物形态，不能用来认定干燥板蓝根质量。' },
  { herbName: '党参', plantName: '党参', origin: '党参来源植物记录采用名称 Codonopsis pilosula，具有肥大的根和缠绕生长的茎。我国多地有分布和栽培，包括陕西、山西、甘肃、四川等区域；植物分布不等于该批次登记产地。', appearance: '党参根较肥大，上部可见细密环纹，茎缠绕且有分枝，花冠呈较宽钟形，黄绿色并可见紫色斑点。资料不提供批次质量结论。' },
  { herbName: '连翘', plantName: '连翘', origin: '连翘 Forsythia suspensa 是落叶灌木，植物智记录其果实可入药。植物分布包括河北、山西、陕西、河南等区域，常见于山坡灌丛及疏林；植物分布不代表批次产地。', appearance: '连翘花冠黄色，花通常先于叶开放；果实可呈卵形或长椭圆形，先端渐尖。植物背景不能代替青翘、老翘等商品药材的专业鉴别。' },
  { herbName: '五味子', plantName: '五味子', origin: '五味子 Schisandra chinensis 是落叶木质藤本。植物记录列出东北地区、河北、山西等地的分布；这是该来源植物的基础背景，不代表同名商品或某批次已经过鉴定。', appearance: '五味子的聚合果中可见红色小浆果，小果内通常有一至两粒肾形种子。形态介绍不能确认某个药材批次的品种、成分或安全性。' },
  { herbName: '天麻', plantName: '天麻', origin: '天麻 Gastrodia elata 的植物记录描述其具有块茎状根状茎、没有绿色叶片，常生于疏林及林缘等环境。在我国多地分布；这里介绍植物背景，不提供药用指导。', appearance: '天麻根状茎呈块茎状、偏椭圆形，地上茎可见橙黄或蓝绿色，并有膜质鞘。不能仅凭外观判断商品药材或批次质量。' },
  { herbName: '苍术', plantName: '苍术', origin: '苍术 Atractylodes lancea 为多年生草本，具有根状茎；植物智记录其分布于我国多个省区，生境包括山坡草地、林下和灌丛。植物记录不等于商品药材基原或批次鉴定。', appearance: '苍术根状茎可较粗长或呈结节状，叶形及分裂程度会有变化，果实带毛。基础形态不能用于直接判断本批次是否合格。' },
  { herbName: '铁皮石斛', plantName: '铁皮石斛', origin: '铁皮石斛的植物记录使用名称 Dendrobium officinale。记录列出浙江、安徽、福建、广西、四川、云南等地，常生于半阴湿的山地岩石；植物分布不等于药材商品产区或任何批次的登记产地。', appearance: '铁皮石斛茎呈圆柱状，有多个节，通常不分枝，叶片在茎上交互排列，叶鞘抱茎。这里只介绍来源植物，不能替代药典基原鉴定，也不提供服用或治疗建议。' },
] as const

export const knowledgeChunks: KnowledgeChunk[] = [...entries.flatMap((entry) =>
  (['origin', 'appearance'] as const).map((section) => ({
    id: `knowledge:${entry.pid}:${section}`,
    herbName: entry.herbName,
    title: `${entry.herbName} · ${section === 'origin' ? '来源、类别与常见产地' : '外观识别资料'}`,
    content: entry[section],
    url: `https://sys01.lib.hkbu.edu.hk/cmed/mmid/detail.php?pid=${entry.pid}&lang=chs`,
    publisher: '香港浸会大学中药材图像数据库（人工摘要）',
    retrievedAt: 'retrievedAt' in entry ? entry.retrievedAt : '2026-10-05',
  })),
), ...plantEntries.flatMap(entry => (['origin', 'appearance'] as const).map(section => ({
  id: `knowledge:iplant:${entry.herbName}:${section}`, herbName: entry.herbName,
  title: `${entry.herbName} · ${section === 'origin' ? '来源植物、类别与分布' : '来源植物外观'}`,
  content: entry[section], url: `https://www.iplant.cn/info/${encodeURIComponent(entry.plantName)}?t=z`,
  publisher: '中国科学院植物研究所 · 植物智（人工摘要）', retrievedAt: '2026-10-14',
})))]
