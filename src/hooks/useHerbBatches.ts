/**
 * 批次数据 hooks（基于 TanStack Query v5）
 *
 * 设计要点：
 * 1. `herbDataSource` 根据 VITE_AUTH_MODE 选择真实 API 或本地演示数据，
 *    页面与 Hook 不需要感知实际数据来源。
 * 2. mutation 成功后统一 invalidate 批次缓存；demo 模式的其他本地写入
 *    仍可通过 `herb-changed` 事件触发缓存失效。
 * 3. 对外暴露三个常用入口：
 *    - `useHerbBatches()` —— 列表（admin / buyer / grower 都在用）
 *    - `useHerbBatchById(id)` —— 详情（按需启用，避免列表页面也拖详情）
 *    - `useHerbBatchByIdentifier(identifier)` —— 通知 ID、列表溯源码和直接链接共用的详情
 * 4. `useHerbBatchMutations()` 暴露 11 个 mutation，调用方按需取用。
 */
import { useEffect } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HerbBatch } from '../types/herb'
import type { BatchEvent, DispatchBatchInput, Stage } from '../types/herb'
import {
  addBatchEvent,
  updateBatch,
  type HarvestInput,
  type NewBatchEventInput,
  type NewBatchInput,
} from '../services/herbStorage'

import { authMode } from '../config/api'
import {
  appendHerbEvent,
  auditHerbBatch,
  completeProcessingBatch,
  createHerbBatch,
  getHerbBatchById,
  getHerbBatchByIdentifier,
  harvestHerbBatch,
  listHerbBatches,
  receiveProcessingBatch,
  saveProcessingQualityReport,
  confirmHerbReceipt,
  dispatchHerbBatch,
  type AuditHerbBatchInput,
  type ProcessingQualityReportInput,
  type ProcessorOperator,
} from '../services/herbDataSource'

/** 全局 queryKey 集中管理，避免散落字符串 */
export const herbQueryKeys = {
  all: ['herb-batches', authMode] as const,
  list: () =>
    [...herbQueryKeys.all, 'list'] as const,
  detail: (identifier: string) =>
    [
      ...herbQueryKeys.all,
      'detail',
      identifier,
    ] as const,
}

/**
 * 订阅式获取全量批次列表
 * - 对外返回结构与旧版完全一致：{ data, loading, error, reload }
 *   - data: HerbBatch[]
 *   - loading: boolean（首屏为 true）
 *   - error: Error | null
 *   - reload: () => void
 */
export function useHerbBatches() {
  const query = useQuery({
    queryKey: herbQueryKeys.list(),
    queryFn: listHerbBatches,
  })

  const queryClient = useQueryClient()
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: herbQueryKeys.all })
  }

  return {
    data: query.data ?? [],
    loading: query.isPending || query.isFetching,
    error: (query.error as Error | null) ?? null,
    reload,
  }
}

/** 按 ID 获取单个批次（详情页按需启用） */
// 根据批次 ID 查询药材详情的自定义 Hook
export function useHerbBatchById(id: string | null | undefined) {
  const query = useQuery({
    queryKey: id ? herbQueryKeys.detail(id) : [...herbQueryKeys.all, 'noop'],
    queryFn: () => (id ? getHerbBatchById(id) : Promise.resolve(null)),
    enabled: Boolean(id),
  })

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: (query.error as Error | null) ?? null,
    reload: () => void query.refetch(),
  }
}

/**
 * 写操作 mutation 集合
 * 全部成功后都会自动 invalidate `herb-batches` 全树，
 * 触发所有订阅的 useQuery 重新拉取（admin / buyer / grower 同步刷新）。
 */
export function useHerbBatchMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: herbQueryKeys.all })

  const create = useMutation({
    mutationFn: (input: NewBatchInput) => createHerbBatch(input),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<HerbBatch> }) =>
      updateBatch(id, patch),
    onSuccess: invalidate,
  })
  const setAudit = useMutation({
    mutationFn: (input: AuditHerbBatchInput) =>
      auditHerbBatch(input),
    onSuccess: invalidate,
  })
  const addEvent = useMutation({
    mutationFn: ({
      batchId,
      input,
    }: {
      batchId: string
      input: NewBatchEventInput
    }) => appendHerbEvent(batchId, input),
    onSuccess: invalidate,
  })
  const setStage = useMutation({
    mutationFn: ({
      batchId,
      toStage,
      operator,
      note,
    }: {
      batchId: string
      toStage: Stage
      operator: { displayName: string; role: BatchEvent['operatorRole'] }
      note?: string
    }) => {
      return addBatchEvent(batchId, {
        type: 'stageChange',
        title: '阶段变更',
        occurredAt: new Date().toISOString(),
        operatorName: operator.displayName,
        operatorRole: operator.role,
        toStage,
        description: note,
      }).then(() => updateBatch(batchId, { stage: toStage }))
    },
    onSuccess: invalidate,
  })
  const harvest = useMutation({
    mutationFn: ({
      batchId,
      input,
      operator,
    }: {
      batchId: string
      input: HarvestInput
      operator: { userId: string; displayName: string; growerId?: string; growerName?: string }
    }) => harvestHerbBatch(
      batchId,
      input,
      operator,
    ),
    onSuccess: invalidate,
  })

  // 加工商接收批次
  const receiveProcessing = useMutation({
    // mutationFn：实际执行的异步业务函数
    mutationFn: ({
      batchId,
      operator,
    }: {
      batchId: string
      operator: ProcessorOperator
    }) => receiveProcessingBatch(batchId, operator),
    // 操作成功后，让批次相关缓存失效，自动重新拉取最新数据
    onSuccess: invalidate,
  })

  // 完成加工，批次流转进入仓储阶段
  const completeProcessing = useMutation({
    mutationFn: ({
      batchId,
      note,
      operator,
    }: {
      batchId: string
      note: string
      operator: ProcessorOperator
    }) => completeProcessingBatch(
      batchId,
      note,
      operator,
    ),
    onSuccess: invalidate,
  })

  // 保存加工环节质检报告记录
  const saveQualityReport = useMutation({
    mutationFn: ({
      batchId,
      input,
      operator,
    }: {
      batchId: string
      input: ProcessingQualityReportInput
      operator: ProcessorOperator
    }) => saveProcessingQualityReport(
      batchId,
      input,
      operator,
    ),
    onSuccess: invalidate,
  })
  // 出库、收货的请求状态和成功后的缓存刷新仍由 TanStack Query 统一管理。
  const dispatch = useMutation({
    mutationFn: ({
      batchId,
      input,
    }: {
      batchId: string
      input: DispatchBatchInput
    }) => dispatchHerbBatch(batchId, input),
    onSuccess: invalidate,
    retry: false,
  })

  const confirmReceipt = useMutation({
    mutationFn: ({
      batchId,
    }: {
      batchId: string
    }) => confirmHerbReceipt(batchId),
    onSuccess: invalidate,
    retry: false,
  })
  return {
    create,
    update,
    setAudit,
    addEvent,
    setStage,
    harvest,
    receiveProcessing,
    completeProcessing,
    saveQualityReport,
    dispatch,
    confirmReceipt,
  }
}

/**
 * 把本地覆盖层的变更事件桥接到 TanStack Query：
 * 任意 storage 变更（新增/审核/阶段/重置）触发 `herb-changed` 事件，
 * 在这里统一使批次查询缓存失效，让 useQuery 自动重新拉取。
 */
export function useHerbQueryInvalidator() {
  const qc = useQueryClient()
  useEffect(() => {
    const onChange = () => qc.invalidateQueries({ queryKey: herbQueryKeys.all })
    window.addEventListener('herb-changed', onChange)
    return () => window.removeEventListener('herb-changed', onChange)
  }, [qc])
}

/**
 * 列表接口只返回摘要；确实依赖事件链的页面再按需补查详情。
 * 当前仅用于种植日志和采收记录，避免所有列表都产生 N+1 请求。
 */
export function useHerbBatchDetails(batches: HerbBatch[]) {
  const queries = useQueries({
    queries: batches.map((batch) => ({
      queryKey: herbQueryKeys.detail(batch.id),
      queryFn: () => getHerbBatchById(batch.id),
      enabled: authMode === 'api',
    })),
  })

  if (authMode === 'demo') {
    return {
      data: batches,
      loading: false,
      error: null as Error | null,
      reload: () => undefined,
    }
  }

  return {
    data: queries.flatMap((query) => (query.data ? [query.data] : [])),
    loading: queries.some((query) => query.isPending || query.isFetching),
    error: (queries.find((query) => query.error)?.error as Error | null) ?? null,
    reload: () => {
      queries.forEach((query) => void query.refetch())
    },
  }
}

// 按批次id或溯源码读取详情，通知和列表入口共用

export function useHerbBatchByIdentifier(
  identifier: string | null | undefined,
) {
  const value = identifier?.trim()

  const query = useQuery({
    queryKey: value
      ? herbQueryKeys.detail(value)
      : [...herbQueryKeys.all, 'noop-detail'],
    queryFn: () =>
      value
        ? getHerbBatchByIdentifier(value)
        : Promise.resolve(null),
    enabled: Boolean(value),
  })

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: (query.error as Error | null) ?? null,
    reload: () => {
      void query.refetch()
    },
  }
}
