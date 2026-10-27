import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuthSession } from '../types/auth'
import type { AssistantBatch, AssistantContextValue, AssistantHistory, AssistantRequest, AssistantTurn } from '../types/assistant'
import { authMode } from '../config/api'
import { getAssistantHistory, streamAssistantMessage } from '../services/assistantDataSource'
import { assistantSessionKey, isCurrentAssistantSession } from '../services/assistantSession'
import { ApiError, isAbortError } from '../services/api'
import { mergeAssistantTurns } from '../utils/assistant'

type Run = AssistantRequest & { id: string; controller: AbortController; selection: number }

export function useAssistantConversation(session: AuthSession): AssistantContextValue {
    const [open, setOpen] = useState(false)
    const [batch, setBatch] = useState<AssistantBatch | null>(null)
    const [draft, setDraft] = useState('')
    // 这里只保存尚未同步的消息；数据库历史由 Query 管理，不再复制一套 state。
    const [localTurns, setLocalTurns] = useState<AssistantTurn[]>([])
    const runRef = useRef<Run | null>(null)
    const selectionRef = useRef(0)
    const queryClient = useQueryClient()
    const queryKey = ['assistant-history', session.userId, assistantSessionKey(session)]

    const history = useQuery({
        queryKey,
        queryFn: async ({ signal }) => {
            const result = await getAssistantHistory(signal)
            if (!isCurrentAssistantSession(session)) throw new DOMException('身份已变化', 'AbortError')
            return result
        },
        enabled: open,
        retry: false,
        refetchOnWindowFocus: false,
        // 静态 demo 不重新取空历史，API 重开窗口重新核对本人记录。
        staleTime: authMode === 'demo' ? Infinity : 0,
        refetchInterval: (query) => query.state.data?.turns.some((turn) => turn.status === 'pending') ? 2_000 : false,
    })
    const mutation = useMutation({
        mutationKey: ['assistant-message', session.userId],
        mutationFn: (run: Run) => streamAssistantMessage(run.id, run, run.controller.signal, (text) => {
            if (runRef.current !== run || run.controller.signal.aborted || !isCurrentAssistantSession(session)) return
            setLocalTurns(items => items.map(item => item.id === run.id ? { ...item, preview: text } : item))
        }),
        retry: false,
    })
    const serverBusy = history.data?.turns.some((turn) => turn.status === 'pending') ?? false

    useEffect(() => () => {
        runRef.current?.controller.abort()
        runRef.current = null
    }, [])

    const send = async (request?: AssistantRequest) => {
        // ref 防连续点击；mutation 管理本次 loading，Query 管理服务器历史。
        if (runRef.current || mutation.isPending || serverBusy || !history.data || history.isFetching
            || history.isError || !isCurrentAssistantSession(session)) return
        const question = (request?.question ?? draft).trim()
        if (question.length < 2 || question.length > 500) return
        const selected = request ? request.batch : batch
        const run: Run = {
            id: crypto.randomUUID(), question,
            batch: selected ? { ...selected } : null,
            controller: new AbortController(), selection: selectionRef.current,
        }
        runRef.current = run
        setLocalTurns((items) => [...items.slice(-39), {
            id: run.id, question, batch: run.batch, status: 'pending', createdAt: new Date().toISOString(),
        }])
        if (!request) setDraft('')
        const current = () => runRef.current === run && isCurrentAssistantSession(session)
        try {
            // 避免较早发出的 GET 迟到后覆盖本轮成功消息。
            await queryClient.cancelQueries({ queryKey })
            if (!current()) return
            run.controller.signal.throwIfAborted()
            const turn = await mutation.mutateAsync(run)
            if (!current()) return
            run.controller.signal.throwIfAborted()
            await queryClient.cancelQueries({ queryKey })
            if (!current()) return
            run.controller.signal.throwIfAborted()
            queryClient.setQueryData<AssistantHistory>(queryKey, (previous) => ({
                conversationId: previous?.conversationId ?? null,
                mode: turn.reply?.mode ?? previous?.mode ?? 'api',
                turns: mergeAssistantTurns(previous?.turns ?? [], [turn]),
            }))
            setLocalTurns((items) => items.filter((item) => item.id !== run.id))
            // 明确编号查询成功后更新标签；不能覆盖用户等待时主动切换的药材。
            if (turn.batch && selectionRef.current === run.selection) setBatch(turn.batch)
        } catch (error) {
            if (!current()) return
            const stopped = run.controller.signal.aborted || isAbortError(error)
            setLocalTurns((items) => items.map((item) => item.id === run.id ? {
                ...item, status: stopped ? 'stopped' : 'error',
                error: error instanceof ApiError && ['AI_RATE_LIMITED', 'AI_QUESTION_RUNNING', 'AI_QUESTION_STALE', 'UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
                    ? error.message : '刚刚系统有点开小差，再问一遍试试吧～',
            } : item))
        } finally {
            if (runRef.current === run) runRef.current = null
            // 只补查记录，不自动重新执行付费提问；关闭时等下次打开再补查。
            if (isCurrentAssistantSession(session) && history.data?.mode === 'api')
                void queryClient.invalidateQueries({ queryKey })
        }
    }
    const stop = () => runRef.current?.controller.abort()
    return {
        open, batch, draft, setDraft, send, stop,
        turns: mergeAssistantTurns(history.data?.turns ?? [], localTurns),
        isPending: mutation.isPending,
        historyLoading: history.isFetching || open && !history.data && !history.isError,
        historyError: history.error instanceof Error ? history.error.message : null,
        historyMode: history.data?.mode,
        conversationBusy: mutation.isPending || serverBusy,
        reloadHistory: () => { void history.refetch() },
        openAssistant: (next = null) => {
            selectionRef.current++
            setBatch(next ? { ...next } : null)
            setOpen(true)
        },
        closeAssistant: () => { stop(); setOpen(false) },
        removeBatch: () => { selectionRef.current++; setBatch(null) },
    }
}
