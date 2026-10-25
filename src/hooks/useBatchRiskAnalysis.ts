import { useEffect, useRef, useState } from 'react'
import {
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query'
import { authMode } from '../config/api'
import { isAbortError } from '../services/api'
import {
    getLatestRiskAnalysis,
    streamBatchRisk,
    submitRiskReview,
} from '../services/herbDataSource'
import type {
    RiskProgress,
    RiskReviewInput,
} from '../types/riskAnalysis'
import { getAuthRevision } from '../utils/auth'
import { herbQueryKeys } from './useHerbBatches'

const riskQueryKey = (batchId: string) =>
    ['batch-risk-analysis', authMode, batchId] as const

type AnalysisRun = {
    controller: AbortController
    revision: number
}

export function useBatchRiskAnalysis(batchId: string) {
    const queryClient = useQueryClient()
    const queryKey = riskQueryKey(batchId)

    // 进度和“请求停止”属于临时页面状态，不是服务器缓存。
    const [progress, setProgress] = useState<RiskProgress[]>([])
    const [stopped, setStopped] = useState(false)

    // controller 不参与渲染，用 ref 保存。
    const controllerRef = useRef<AbortController | null>(null)
    const mountedRef = useRef(true)

    useEffect(() => {
        mountedRef.current = true

        return () => {
            mountedRef.current = false
            // 离开页面或卸载抽屉时，关闭仍在进行的分析连接。
            controllerRef.current?.abort()
        }
    }, [])

    const query = useQuery({
        queryKey,
        queryFn: ({ signal }) => getLatestRiskAnalysis(batchId, signal),
        refetchOnMount: 'always',
    })
    // 关闭会卸载抽屉，旧请求的回调可能不再刷新缓存；而全局默认有 30 秒缓存新鲜期。这里强制重新 GET 已保存建议，不是重新调用付费模型。

    const analyze = useMutation({
        mutationFn: ({ controller }: AnalysisRun) =>
            streamBatchRisk(batchId, {
                signal: controller.signal,
                onProgress: (item) => {
                    if (
                        mountedRef.current &&
                        !controller.signal.aborted
                    ) {
                        // 函数式更新：连续收到多帧时，不丢失前面的事件。
                        setProgress((previous) => [...previous, item])
                    }
                },
            }),
        // 付费操作不自动重试。
        retry: false,
        onSuccess: async (analysis, run) => {
            if (
                !mountedRef.current ||
                run.controller.signal.aborted ||
                run.revision !== getAuthRevision()
            ) return

            // 防止旧读取迟到后覆盖新建议。
            await queryClient.cancelQueries({ queryKey })

            // await 期间也可能停止、卸载或切换账号，再检查一次。
            if (
                !mountedRef.current ||
                run.controller.signal.aborted ||
                run.revision !== getAuthRevision()
            ) return

            queryClient.setQueryData(queryKey, analysis)

            await queryClient.invalidateQueries({
                queryKey: herbQueryKeys.all,
            })
        },
        onSettled: async (_analysis, error, run) => {
            // 正常成功已经更新缓存，不重复请求。
            if (!error && !run.controller.signal.aborted) return

            if (
                !mountedRef.current ||
                run.revision !== getAuthRevision()
            ) return

            // 身份变化产生的取消，不为新身份恢复旧任务。
            if (
                isAbortError(error) &&
                !run.controller.signal.aborted
            ) return

            // 断流不代表没有保存：重新读取已有建议，不重新调用模型。
            await Promise.all([
                queryClient.invalidateQueries({ queryKey }),
                queryClient.invalidateQueries({
                    queryKey: herbQueryKeys.all,
                }),
            ])
        },
    })

    const review = useMutation({
        mutationFn: ({
            analysisId,
            input,
        }: {
            analysisId: string
            input: RiskReviewInput
        }) => submitRiskReview(batchId, analysisId, input),
        retry: false,
        onSuccess: async () => {
            // 审核后列表状态变化，旧建议也会变为 stale。
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: herbQueryKeys.all,
                }),
                queryClient.invalidateQueries({ queryKey }),
            ])
        },
    })

    const startAnalyze = async () => {
        if (
            controllerRef.current ||
            analyze.isPending ||
            review.isPending
        ) return

        // 每次重新分析都创建新 controller；已经 abort 的不能复用。
        const controller = new AbortController()
        const run: AnalysisRun = {
            controller,
            revision: getAuthRevision(),
        }

        controllerRef.current = controller
        setProgress([])
        setStopped(false)
        review.reset()

        try {
            const analysis = await analyze.mutateAsync(run)
            return controller.signal.aborted ? undefined : analysis
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null
            }
        }
    }

    const stopAnalyze = () => {
        const controller = controllerRef.current

        if (controller && !controller.signal.aborted) {
            setStopped(true)
            controller.abort()
        }
    }

    // 主动取消显示停止提示，而不是红色报错。
    const analysisError = isAbortError(analyze.error)
        ? null
        : analyze.error

    return {
        query,
        analyze,
        review,
        progress,
        stopped,
        analysisError,
        startAnalyze,
        stopAnalyze,
    }
}