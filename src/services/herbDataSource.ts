// 把后端 DTO 转换为现有 HerbBatch；
// API 模式读取 PostgreSQL；
// demo 模式继续读取 JSON/localStorage；
// 统一按 ID、溯源码读取详情；
// 404 转换为 null，网络错误继续抛出；
// 对页面隐藏“数据到底来自 API 还是 Mock”。

// 页面不再直接操作 localStorage，统一经数据源自动选择 demo 或真实 API

import dayjs from 'dayjs' // 日期处理工具库，用来格式化、比较时间
import { authMode } from '../config/api' // 读取配置，判断当前是本地模拟模式，还是调用后端真实API模式
import type { UserRole } from '../types/auth' // 用户角色类型定义（仅TS类型，无运行时代码）
// 药材批次相关全部TS类型
import type {
    AuditStatus,
    BatchEvent,
    EventType,
    HerbBatch,
    HerbCategory,
    HerbOrigin,
    RiskLevel,
    Stage,
    DispatchRecipient,
    DispatchBatchInput,
} from '../types/herb'
import {
    addBatch as addLocalBatch,
    addBatchEvent as addLocalBatchEvent,
    getById as getLocalBatchById,
    getByTraceCode as getLocalBatchByTraceCode,
    listBatches as listLocalBatches,
    recordHarvest as recordLocalHarvest,
    setAuditStatus as setLocalAuditStatus,
    setStage as setLocalStage,
    type HarvestInput,
    type NewBatchEventInput,
    type NewBatchInput,
} from './herbStorage'
// API请求工具，ApiError是自定义API异常类，apiRequest是封装好的http请求函数
import { ApiError, apiRequest, apiEventStream } from './api'
import { parseRiskProgress, parseRiskResult, parseRiskStreamError } from './riskStreamContract'
import { parseHerbQuestionReply } from './herbQuestionContract'
import { answerDemoHerbQuestion } from './herbQuestionDemo'
import type { HerbQuestionReply } from '../types/herbQuestion'

import type { PublicTraceBatch } from '../types/publicTrace'
import { isTraceCode } from '../utils/traceCode'
import { parsePublicTraceReply } from './publicTraceContract'
import { buildDemoPublicTrace } from './publicTraceDemo'

import {
    confirmDemoReceipt,
    dispatchDemoBatch,
    listDemoDispatchRecipients,
    parseDispatchRecipients,
    withDemoReceiptPermission,
} from './batchDispatchSupport'

import type {
    RiskAnalysis,
    RiskProgress,
    RiskReviewInput,
} from '../types/riskAnalysis'
import {
    analyzeDemoRisk,
    getDemoRiskAnalysis,
    reviewDemoRisk,
} from './riskAnalysisDemo'

/**
 * 远端API返回数据的TS类型定义
 * 全部带Api前缀的类型，用来描述调用后端接口拿到的JSON数据结构
 */

// 机构信息：种植机构 / 加工机构
type ApiOrganization = {
    id: string // 机构唯一id
    code: string // 机构业务编码
    name: string // 机构名称
    type: string // 机构类型
    province: string | null // 省份，可为空
    city: string | null // 城市，可为空
}

// 附件：图片、凭证文件
type ApiAttachment = {
    id: string // 附件id
    eventId: string | null // 关联溯源事件id，不属于事件的附件可为null
    originalName: string // 文件上传时原始文件名
    publicUrl: string | null // 文件访问地址，可为空
    mimeType: string // 文件类型，如 image/jpeg
    sizeBytes: number // 文件大小，单位字节
    createdAt: string // 文件上传创建时间
}

// 药材批次溯源事件
type ApiBatchEvent = {
    id: string // 事件id
    type: EventType // 事件类型枚举（种植、采收、入库等）
    title: string // 事件标题
    description: string | null // 事件描述文字，允许为空
    payload: unknown // 事件额外扩展数据，暂不限制结构
    occurredAt: string // 事件实际发生时间
    operatorName: string | null // 操作人姓名，可为空
    operatorRole: UserRole | null // 操作人角色，可为空
    visibleRoles: UserRole[] // 允许查看本条事件的角色列表（权限控制）
    fromStage: Stage | null // 阶段变更：变更前阶段，无阶段流转则为null
    toStage: Stage | null // 阶段变更：变更后阶段，无阶段流转则为null
    createdAt: string // 本条事件记录入库时间
    attachments: ApiAttachment[] // 本条事件绑定的附件数组
}

// 批次摘要：列表页面使用，精简信息，不带事件流水
type ApiBatchSummary = {
    id: string // 批次唯一id
    batchNo: string // 批次编号
    traceCode: string // 溯源码，可用于查询详情
    herbName: string // 药材名称
    category: HerbCategory // 药材分类
    plantingStartDate: string // 种植开始日期
    origin: unknown // 产地信息，暂不约束类型
    environment: string | null // 种植环境描述，可为空
    coverImageUrl: string | null // 批次封面图链接，可为空
    description: string | null // 批次整体描述，可为空
    requiresProcessing: boolean // 是否需要加工处理
    stage: Stage // 批次当前所处阶段
    auditStatus: AuditStatus // 审核状态（待审核/通过/驳回）
    riskLevel: RiskLevel // 风险等级
    version: number // 版本号，乐观锁，防止并发覆盖
    createdAt: string // 批次创建时间
    updatedAt: string // 批次最后更新时间
    growerOrganization: ApiOrganization // 种植机构信息
    processorOrganization: ApiOrganization | null // 加工机构，不需要加工时为null

    buyerOrganization: {
        id: string
        name: string
    } | null
    canConfirmReceipt: boolean

    createdBy: {
        id: string // 创建人id
        displayName: string // 创建人展示名称
        role: UserRole // 创建人角色
    }
}

// 批次详情类型
// & 交叉类型：继承ApiBatchSummary所有字段，额外追加详情独有的数据
type ApiBatchDetail = ApiBatchSummary & {
    events: ApiBatchEvent[] // 该批次全部溯源事件流水
    audits: unknown[] // 审核记录数组，暂不约束结构
    attachments: ApiAttachment[] // 批次级别的附件（不属于单个事件）
}

// 批次列表接口的整体返回结构
type ApiBatchListResponse = {
    items: ApiBatchSummary[] // 当前页批次摘要数组
    pagination: {
        page: number // 当前页码
        pageSize: number // 每页条数
        total: number // 全部数据总条数
        totalPages: number // 总页数
    }
}

// 批次详情接口外层包装类型：接口返回最外层是一个对象，batch字段存放批次详情数据
type ApiBatchDetailResponse = {
    batch: ApiBatchDetail
}

// 管理员审核只能产生明确结论，不能通过审核接口退回 pending。
export type AuditDecision = Extract<
    AuditStatus,
    'approved' | 'rejected'
>

export type AuditHerbBatchInput = {
    id: string
    decision: AuditDecision
    reason?: string
    riskLevel?: RiskLevel
}


/**
 * 日期格式化函数，只保留年月日
 * @param value 原始时间字符串
 * @returns 格式化后的日期
 */
function formatDate(value: string): string {
    return dayjs(value).format('YYYY-MM-DD')
}

/**
 * 日期时间格式化函数，年月日+时分
 */
function formatDateTime(value: string): string {
    return dayjs(value).format('YYYY-MM-DD HH:mm')
}

/**
 * 空值转换工具：把 null 转为 undefined，字符串原样返回
 * @param value 可以是字符串或者null
 * @returns string | undefined
 */
function optionalText(
    value: string | null,
): string | undefined {
    // ?? 空合并运算符：value为null时，返回undefined，否则返回value本身
    return value ?? undefined
}

/**
 * origin 在数据库中是 JSON，所以接口类型只能先写 unknown。
 * 使用前必须检查需要的字段，不能直接断言为 HerbOrigin。
 * @param value 远端接口返回的产地原始数据(unknown)
 * @returns 校验通过后返回标准化的 HerbOrigin 对象
 */
function toHerbOrigin(value: unknown): HerbOrigin {
    // 校验：入参为空或者不是对象，直接抛接口异常
    if (!value || typeof value !== 'object') {
        throw new ApiError(
            0,
            'INVALID_RESPONSE',
            '批次产地数据格式不正确',
        )
    }

    // 转成键值未知的对象，方便读取属性
    const origin = value as Record<string, unknown>

    // 强制校验省、市，这两个字段是必填，类型必须为字符串
    if (
        typeof origin.province !== 'string' ||
        typeof origin.city !== 'string'
    ) {
        throw new ApiError(
            0,
            'INVALID_RESPONSE',
            '批次产地数据格式不正确',
        )
    }

    return {
        province: origin.province,
        city: origin.city,
        // district 可选，只有是字符串才放进返回对象，否则不携带该key
        ...(typeof origin.district === 'string'
            ? { district: origin.district }
            : {}),
        // address 可选，只有是字符串才放进返回对象，否则不携带该key
        ...(typeof origin.address === 'string'
            ? { address: origin.address }
            : {}),
    }
}

/**
 * 转换附件：接口返回ApiAttachment → 业务内部附件结构
 * @param attachment 接口返回的附件原始对象ApiAttachment
 * @returns 适配前端BatchEvent的附件对象
 */
function toAttachment(
    attachment: ApiAttachment,
): NonNullable<BatchEvent['attachments']>[number] {
    return {
        name: attachment.originalName,
        // 暂无真实对象存储地址时保留占位，页面不会把 # 当成可下载链接。
        url: attachment.publicUrl ?? '#',

    }
}

/**
 * 转换批次事件：接口ApiBatchEvent → 项目内部BatchEvent
 * @param event 接口返回的原始批次事件
 * @returns 格式化后的批次事件，日期格式化、空值统一处理
 */
function toBatchEvent(
    event: ApiBatchEvent,
): BatchEvent {
    return {
        id: event.id,
        type: event.type,
        title: event.title,
        description: optionalText(event.description),
        occurredAt: formatDateTime(event.occurredAt),
        operatorName: optionalText(event.operatorName),
        operatorRole: event.operatorRole ?? undefined,
        // 有可见角色配置才赋值，为空数组时置为undefined，减少冗余数据
        scopes: event.visibleRoles.length > 0
            ? event.visibleRoles
            : undefined,
        fromStage: event.fromStage ?? undefined,
        toStage: event.toStage ?? undefined,
        // 存在附件数组则映射转换，无附件时置undefined
        attachments: event.attachments.length > 0
            ? event.attachments.map(toAttachment)
            : undefined,
    }
}

/**
 * 转换中药材批次主数据：接口ApiBatchSummary → 内部HerbBatch
 * @param batch 接口返回批次摘要原始数据
 * @param events 已经转换好的批次事件数组，默认空数组
 * @returns 标准化后的批次完整对象，日期格式化、字段映射、数据清洗
 */
function toHerbBatch(
    batch: ApiBatchSummary,
    events: BatchEvent[] = [],
): HerbBatch {
    return {
        id: batch.id,
        batchNo: batch.batchNo,
        traceCode: batch.traceCode,
        herbName: batch.herbName,
        category: batch.category,
        // 从接口返回的种植机构对象，提取id和name平铺到当前批次对象
        growerId: batch.growerOrganization.id,
        growerName: batch.growerOrganization.name,

        buyerId: batch.buyerOrganization?.id,
        buyerName: batch.buyerOrganization?.name,
        canConfirmReceipt: batch.canConfirmReceipt === true,

        plantingStartDate: formatDate(
            batch.plantingStartDate,
        ),
        // 产地JSON单独校验转换
        origin: toHerbOrigin(batch.origin),
        environment: optionalText(batch.environment),
        coverImageUrl: optionalText(batch.coverImageUrl),
        description: optionalText(batch.description),
        stage: batch.stage,
        auditStatus: batch.auditStatus,
        riskLevel: batch.riskLevel,
        createdAt: formatDateTime(batch.createdAt),
        createdBy: batch.createdBy.displayName,
        // 现有前端只区分管理员代建档和种植商建档。
        createdByRole: batch.createdBy.role === 'grower'
            ? 'grower'
            : 'admin',
        updatedAt: formatDateTime(batch.updatedAt),
        events,
    }
}

/**
 * 转换批次详情完整接口数据，转成页面能用的HerbBatch
 * @param batch 后端返回的完整批次详情 ApiBatchDetail（包含events、独立附件）
 * @returns 组装、处理好的批次业务对象
 */
function toDetailedHerbBatch(
    batch: ApiBatchDetail,
): HerbBatch {
    // 1. 把接口返回的事件列表，批量转换成前端事件模型
    const events = batch.events.map(toBatchEvent)

    /**
     * 没有关联具体事件的附件仍然要在现有时间线结构中显示，
     * 因此转换成一条合成事件。
     */
    // 筛选不属于任何事件的附件：eventId为空，不属于某一条溯源流水
    const unboundAttachments = batch.attachments.filter(
        (attachment) => !attachment.eventId,
    )

    // 如果存在这种独立附件，手动造一条虚拟事件塞进时间线
    if (unboundAttachments.length > 0) {
        events.push({
            id: `batch-attachments-${batch.id}`, // 造一个唯一id
            type: 'note',
            title: '批次附件',
            occurredAt: formatDateTime(batch.updatedAt), // 时间取批次最后更新时间
            attachments: unboundAttachments.map(toAttachment),
        })
    }

    // 把全部事件按发生时间从小到大排序，保证时间线顺序正确
    events.sort(
        (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt),
    )

    // 复用之前写好的批次转换函数，返回最终批次对象，带上处理完的events
    return toHerbBatch(batch, events)
}

/**
 * 请求批次列表接口
 * @param page 页码
 * @returns 返回后端列表接口原始响应
 */
async function requestBatchPage(
    page: number,
): Promise<ApiBatchListResponse> {
    // 调用封装好的通用请求函数，请求批次列表，固定每页100条
    return apiRequest<ApiBatchListResponse>(
        `/batches?page=${page}&pageSize=100`,
    )
}

/**
 * 当前页面仍采用前端筛选和前端分页，所以这里需要取完所有页。
 * 后续数据量增大时，再把筛选和分页状态完整交给服务端。
 */
// 一次性拉取后端全部批次数据，所有筛选、分页都放在前端 JS 里做
// 数据一多，一次性拉取全部会很慢而且占内存
async function listApiBatches(): Promise<HerbBatch[]> {
    // 先请求第1页的数据
    const firstPage = await requestBatchPage(1)

    // 如果总共只有1页，直接转换数据返回
    if (firstPage.pagination.totalPages <= 1) {
        return firstPage.items.map((batch) =>
            toHerbBatch(batch),
        )
    }

    // 多页场景：并发一次性请求剩下所有页码（第2页到最后一页）
    const remainingPages = await Promise.all(
        Array.from(
            {
                // 需要请求的页数 = 总页数 - 第一页
                length:
                    firstPage.pagination.totalPages - 1,
            },
            (_, index) => requestBatchPage(index + 2),
        ),
    )

    // 合并第一页 + 剩余所有页的数据，统一转换成前端业务模型
    return [
        ...firstPage.items,
        ...remainingPages.flatMap((page) => page.items),
    ].map((batch) => toHerbBatch(batch))
}

/**
 * 根据标识(id/traceCode)获取单个批次详情
 * @param identifier 批次id或者溯源码
 * @returns 批次对象，找不到返回null，其他错误继续抛出
 */
async function getApiBatch(
    identifier: string,
): Promise<HerbBatch | null> {
    try {
        // 请求详情接口，encodeURIComponent防止溯源码里特殊字符导致接口报错
        const response =
            await apiRequest<ApiBatchDetailResponse>(
                `/batches/${encodeURIComponent(identifier)}`,
            )

        // 调用详情专用转换函数，处理事件+游离附件
        return toDetailedHerbBatch(response.batch)
    } catch (error) {
        // 如果是ApiError并且状态码404（不存在/无权限），返回null
        if (
            error instanceof ApiError &&
            error.status === 404
        ) {
            return null
        }
        // 其他类型错误，继续往上抛，交给外层捕获处理
        throw error
    }
}

/** 管理员出库时读取可选采购组织，页面不区分 API/demo。 */
export async function listDispatchRecipients(
    signal?: AbortSignal,
): Promise<DispatchRecipient[]> {
    signal?.throwIfAborted()

    if (authMode === 'demo') {
        return listDemoDispatchRecipients(signal)
    }

    const response = await apiRequest<unknown>(
        '/batches/dispatch-recipients',
        { signal },
    )

    signal?.throwIfAborted()
    return parseDispatchRecipients(response)
}

/**
 * 获取全部药材批次
 * 自动区分模式：demo演示模式读本地数据；正式API模式请求后端接口
 * @returns 批次数组
 */
export async function listHerbBatches(): Promise<HerbBatch[]> {
    if (authMode === 'demo') {
        const batches = await listLocalBatches()
        return batches.map(withDemoReceiptPermission)
    }
    // 正式环境，调用接口拉取全部批次
    return listApiBatches()
}

/**
 * 通过批次id查询批次详情
 * @param id 批次id
 * @returns 批次对象，找不到返回null
 */
export async function getHerbBatchById(id: string): Promise<HerbBatch | null> {
    if (authMode === 'demo') {
        const batch = await getLocalBatchById(id)
        return batch ? withDemoReceiptPermission(batch) : null
    }
    // API模式调用后端详情接口，传入id查询
    return getApiBatch(id)
}

/**
 * 通过溯源码查询批次详情
 * @param traceCode 溯源码traceCode
 * @returns 批次对象，找不到返回null
 */
export async function getHerbBatchByTraceCode(traceCode: string): Promise<HerbBatch | null> {
    if (authMode === 'demo') {
        const batch = await getLocalBatchByTraceCode(traceCode)
        return batch ? withDemoReceiptPermission(batch) : null
    }
    // API模式调用后端详情接口，传入溯源码查询
    return getApiBatch(traceCode.trim().toUpperCase())
}

/** 完整详情允许使用批次 ID 或溯源码；不能统一改变大小写。 */
export async function getHerbBatchByIdentifier(
    identifier: string,
): Promise<HerbBatch | null> {
    const value = identifier.trim()
    if (!value) return null

    // 溯源码走原有规范化逻辑；数据库 ID 保留原样。
    return isTraceCode(value)
        ? getHerbBatchByTraceCode(value)
        : getHerbBatchById(value)
}

/**
 * 获取匿名公开档案。
 * 与登录后的完整详情分开，不使用私有详情接口。
 */
export async function getPublicTraceByCode(
    traceCode: string,
    signal?: AbortSignal,
): Promise<PublicTraceBatch | null> {
    signal?.throwIfAborted()

    const code = traceCode.trim().toUpperCase()
    if (!isTraceCode(code)) return null

    if (authMode === 'demo') {
        const batch = await getLocalBatchByTraceCode(code)
        signal?.throwIfAborted()

        return buildDemoPublicTrace(batch)
    }

    try {
        const response = await apiRequest<unknown>(
            `/public/trace/${encodeURIComponent(code)}`,
            {
                auth: false,
                signal,
            },
        )

        return parsePublicTraceReply(response, code)
    } catch (error) {
        // 不存在或暂不可公开，由页面统一展示空结果。
        if (error instanceof ApiError && error.status === 404) {
            return null
        }

        // 网络故障、限流、服务异常不能伪装成“档案不存在”。
        throw error
    }
}

/**
 * 创建批次。
 * demo 模式写入 localStorage；API 模式只发送允许用户填写的业务字段。
 * growerId、创建人、审核状态、阶段和风险等级由服务端身份决定。
 */
export async function createHerbBatch(
    input: NewBatchInput,
): Promise<HerbBatch> {
    if (authMode === 'demo') return addLocalBatch(input)

    const response = await apiRequest<ApiBatchDetailResponse>(
        '/batches',
        {
            method: 'POST',
            body: {
                herbName: input.herbName,
                category: input.category,
                plantingStartDate: input.plantingStartDate,
                origin: input.origin,
                environment: input.environment,
                description: input.description,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/**
 * 管理员审核批次。
 * demo 模式继续使用本地覆盖层；API 模式写入 PostgreSQL。
 */
export async function auditHerbBatch(
    input: AuditHerbBatchInput,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return setLocalAuditStatus(input.id, input.decision)
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(input.id)}/audit`,
        {
            method: 'PATCH',
            body: {
                decision: input.decision,
                reason: input.reason,
                riskLevel: input.riskLevel,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}


/**
 * 追加种植日志。
 * 操作人、所属组织和事件角色由后端登录身份确定，前端不能伪造。
 */
export async function appendHerbEvent(
    batchId: string,
    input: NewBatchEventInput,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return addLocalBatchEvent(batchId, input)
    }

    if (input.attachments?.length) {
        throw new Error(
            '真实数据模式暂未接入图片存储，请移除照片后提交日志',
        )
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/events`,
        {
            method: 'POST',
            body: {
                title: input.title,
                description: input.description,
                occurredAt: dayjs(input.occurredAt).toISOString(),
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/**
 * 采收登记。
 * 后端会在一次原子写入中生成采收事件、阶段变更事件并更新批次阶段。
 */
export async function harvestHerbBatch(
    batchId: string,
    input: HarvestInput,
    operator: {
        userId: string
        displayName: string
        growerId?: string
        growerName?: string
    },
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return recordLocalHarvest(
            batchId,
            input,
            operator,
        )
    }

    if (input.photos?.length) {
        throw new Error(
            '真实数据模式暂未接入图片存储，请移除照片后提交采收登记',
        )
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/harvest`,
        {
            method: 'POST',
            body: {
                harvestDate: input.harvestDate,
                yieldKg: input.yieldKg,
                plotArea: input.plotArea,
                harvesterName: input.harvesterName,
                note: input.note,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

// 加工操作人员信息类型
export type ProcessorOperator = {
    displayName: string // 页面展示的操作员名称
    processorName?: string // 可选 加工商名称
}

// 加工质检报告提交入参类型
export type ProcessingQualityReportInput = {
    note: string // 质检备注
    attachments?: NonNullable<NewBatchEventInput['attachments']> // 附件列表，可选
}

/**
 * 加工商接收批次
 * demo模式写入本地覆盖层；API模式由服务端绑定加工组织并推进阶段。
 * @param batchId 批次ID
 * @param operator 加工操作员信息
 * @returns 更新后的药材批次业务对象
 */

export async function receiveProcessingBatch(
    batchId: string,
    operator: ProcessorOperator,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        const processorName =
            operator.processorName
            ?? operator.displayName

        return setLocalStage(batchId, 'processing', {
            operatorName: operator.displayName,
            operatorRole: 'processor',
            note: `${processorName} 已接收该批次，进入加工中。`,
        })
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/processing/receive`,
        {
            method: 'POST',
        },
    )

    // 将后端原始接口数据转换为前端内部业务模型
    return toDetailedHerbBatch(response.batch)
}

/**
 * 完成加工并转入仓储阶段
 * 阶段更新和溯源事件由服务端原子写入，保证数据一致性
 * @param batchId 批次ID
 * @param note 加工完成备注信息
 * @param operator 加工操作员信息
 * @returns 更新后的药材批次业务对象
 */
export async function completeProcessingBatch(
    batchId: string,
    note: string,
    operator: ProcessorOperator,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        // demo环境：本地修改批次状态为待入库
        return setLocalStage(batchId, 'warehousing', {
            operatorName: operator.displayName,
            operatorRole: 'processor',
            note,
        })
    }

    // 真实环境：请求后端完成加工接口
    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/processing/complete`,
        {
            method: 'POST',
            body: {
                note,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/**
 * 保存加工环节质检报告
 * API 第一版仅支持保存文字摘要；附件功能等待对象存储接入后再启用
 * @param batchId 批次ID
 * @param input 质检报告内容（文字+附件）
 * @param operator 加工操作员信息
 * @returns 更新后的药材批次业务对象
 */
export async function saveProcessingQualityReport(
    batchId: string,
    input: ProcessingQualityReportInput,
    operator: ProcessorOperator,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return addLocalBatchEvent(batchId, {
            type: 'qcReport',
            title: '加工质检报告',
            description: input.note,
            occurredAt: dayjs().format('YYYY-MM-DD HH:mm'),
            operatorName: operator.displayName,
            operatorRole: 'processor',
            attachments: input.attachments,
        })
    }

    if (input.attachments?.length) {
        throw new Error(
            '真实数据模式暂未接入文件存储，请先移除质检附件',
        )
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/processing/quality-report`,
        {
            method: 'POST',
            body: {
                summary: input.note,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/**
 * 管理员出库：提交目标采购组织，不提交当前操作人身份。
 * 页面不区分 demo/API，统一调用此方法。
 */
export async function dispatchHerbBatch(
    batchId: string,
    input: DispatchBatchInput,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return dispatchDemoBatch(
            batchId,
            input.buyerOrganizationId,
        )
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/shipping/dispatch`,
        {
            method: 'POST',
            // 显式选择允许提交的字段。
            body: {
                buyerOrganizationId: input.buyerOrganizationId,
            },
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/**
 * 采购商收货：不提交组织或操作人。
 * API 由后端登录身份确定；demo 从当前演示身份读取。
 */
export async function confirmHerbReceipt(
    batchId: string,
): Promise<HerbBatch> {
    if (authMode === 'demo') {
        return confirmDemoReceipt(batchId)
    }

    const response = await apiRequest<ApiBatchDetailResponse>(
        `/batches/${encodeURIComponent(batchId)}/receipt/confirm`,
        {
            method: 'POST',
        },
    )

    return toDetailedHerbBatch(response.batch)
}

/** 查询最近一次风险分析；没有记录时返回 null。 */
export async function getLatestRiskAnalysis(
    batchId: string,
    signal?: AbortSignal,
): Promise<RiskAnalysis | null> {
    if (authMode === 'demo') {
        return getDemoRiskAnalysis(batchId)
    }

    const response = await apiRequest<{
        analysis: RiskAnalysis | null
    }>(
        `/batches/${encodeURIComponent(batchId)}/risk-analysis`,
        { signal },
    )

    return response.analysis
}

/** 发起分析；此操作只生成建议，不改变审核结论。 */
export async function analyzeBatchRisk(
    batchId: string,
): Promise<RiskAnalysis> {
    if (authMode === 'demo') {
        return analyzeDemoRisk(batchId)
    }

    const response = await apiRequest<{
        analysis: RiskAnalysis
    }>(
        `/batches/${encodeURIComponent(batchId)}/risk-analysis`,
        {
            method: 'POST',
            // 多轮模型调用可能超过普通请求的 15 秒。
            timeoutMs: 70_000,
        },
    )

    return response.analysis
}

/** 管理员提交最终结论，并关联本次分析记录。 */
export async function submitRiskReview(
    batchId: string,
    analysisId: string,
    input: RiskReviewInput,
): Promise<{
    batchId: string
    decision: RiskReviewInput['decision']
}> {
    if (authMode === 'demo') {
        return reviewDemoRisk(batchId, analysisId, input)
    }

    return apiRequest<{
        batchId: string
        decision: RiskReviewInput['decision']
    }>(
        `/batches/${encodeURIComponent(batchId)}/risk-analysis/${encodeURIComponent(analysisId)}/review`,
        {
            method: 'POST',
            body: input,
        },
    )
}

/** 通过同一数据源接入过程流；旧非流式接口保留，便于兼容和诊断。 */
export async function streamBatchRisk(
    batchId: string,
    options: { signal: AbortSignal; onProgress: (progress: RiskProgress) => void },
): Promise<RiskAnalysis> {
    options.signal.throwIfAborted()
    if (authMode === 'demo') {
        // 本地规则很快完成，不伪造模型等待时间或 DeepSeek 工具过程。
        options.onProgress({
            seq: 1, stage: 'snapshot', status: 'running',
            message: '本地规则演示：准备读取批次资料', at: new Date().toISOString(),
        })
        options.signal.throwIfAborted()
        const analysis = await analyzeDemoRisk(batchId)
        options.signal.throwIfAborted()
        options.onProgress({
            seq: 2, stage: 'save', status: 'completed',
            message: '本地规则演示：建议已保存，等待人工复核', at: new Date().toISOString(),
        })
        return analysis
    }
    let result: RiskAnalysis | undefined
    let lastSeq = 0
    await apiEventStream(`/batches/${encodeURIComponent(batchId)}/risk-analysis/stream`, {
        method: 'POST', signal: options.signal, timeoutMs: 70_000,
        onMessage: ({ event, data }) => {
            if (event === 'progress') {
                const progress = parseRiskProgress(data, lastSeq)
                lastSeq = progress.seq
                options.onProgress(progress)
            } else if (event === 'result') {
                const analysis = data && typeof data === 'object' && 'analysis' in data ? data.analysis : undefined
                result = parseRiskResult(analysis, batchId)
                return true // 终态已收到，不再等待或自动重连。
            } else if (event === 'error') {
                throw parseRiskStreamError(data)
            } else {
                throw new ApiError(0, 'STREAM_INVALID', '收到未知分析事件')
            }
            return false
        },
    })
    if (!result) throw new ApiError(0, 'STREAM_INCOMPLETE', '连接已结束但未收到完整建议，请重新查询或手动重试')
    return result
}

/** 单轮资料问答：只提交问题，批次资料和权限由服务端读取。 */
export async function askHerbQuestion(
    batchId: string,
    question: string,
    signal: AbortSignal,
): Promise<HerbQuestionReply> {
    signal.throwIfAborted()
    const trimmed = question.trim()
    if (trimmed.length < 2 || trimmed.length > 500) throw new Error('问题需要 2～500 个字符')
    if (authMode === 'demo') {
        const batch = await getHerbBatchById(batchId)
        signal.throwIfAborted()
        if (!batch) throw new Error('药材批次不存在')
        return parseHerbQuestionReply(answerDemoHerbQuestion(batch, trimmed), batchId)
    }
    const response = await apiRequest<{ reply: unknown }>(
        `/batches/${encodeURIComponent(batchId)}/questions`,
        { method: 'POST', body: { question: trimmed }, signal, timeoutMs: 70_000 },
    )
    return parseHerbQuestionReply(response.reply, batchId)
}
