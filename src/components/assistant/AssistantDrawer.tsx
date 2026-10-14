// 批次标签始终显示，窄屏的前缀工具可以展开；缩短说明和输入框最大高度，把空间留给聊天记录。
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Drawer, Input, Space, Tag, Typography } from 'antd'
import { CommentOutlined, SendOutlined } from '@ant-design/icons'
import { useAssistant } from '../../hooks/useAssistant'
import { assistantBatchPrefix } from '../../utils/assistant'
import AssistantMessages from './AssistantMessages'
import './assistant.less'

const { Text } = Typography

export default function AssistantDrawer() {
    const { open, batch, turns, draft, setDraft, isPending,
        historyLoading, historyError, historyMode, conversationBusy, reloadHistory,
        openAssistant, closeAssistant, removeBatch, send, stop } = useAssistant()
    const endRef = useRef<HTMLDivElement>(null)
    // 仅控制工具区展示，不复制 Query 中的聊天记录。
    const [contextExpanded, setContextExpanded] = useState(false)
    const contextId = useId()
    const valid = draft.trim().length >= 2 && draft.trim().length <= 500
    const blocked = historyLoading || !!historyError || conversationBusy
    const prefix = batch ? assistantBatchPrefix(batch) : ''

    useEffect(() => {
        if (open) endRef.current?.scrollIntoView({ block: 'nearest' })
    }, [open, turns])

    return <>
        <Button className="assistant-launcher" type="primary" icon={<CommentOutlined />}
            onClick={() => openAssistant(null)}>AI 助手</Button>
        <Drawer title="良木 AI 助手" open={open} onClose={closeAssistant}
            rootClassName="assistant-drawer"
            size={520} zIndex={1200} styles={{ body: { padding: 0, overflow: 'hidden' } }}>
            <div className="assistant-chat">
                <div className={contextExpanded ? 'assistant-context assistant-context--expanded' : 'assistant-context'}>
                    <div className="assistant-context-summary">
                        {batch
                            ? <Tag closable onClose={removeBatch}>{batch.herbName} · {batch.batchNo}</Tag>
                            : <Text type="secondary">药材知识 / 批次查询</Text>}
                        <Button className="assistant-context-toggle" size="small"
                            aria-expanded={contextExpanded} aria-controls={contextId}
                            onClick={() => setContextExpanded((value) => !value)}>
                            {contextExpanded ? '收起' : batch ? '批次工具' : '使用说明'}
                        </Button>
                    </div>
                    <div id={contextId} className="assistant-context-details">
                        {batch ? <Space wrap>
                            <Button size="small" onClick={() => setDraft((value) =>
                                value.startsWith(prefix) ? value : (prefix + value).slice(0, 500))}>插入批次前缀</Button>
                            <Text copyable={{ text: prefix }}>复制前缀</Text>
                            <Text type="secondary">可以普通聊天；批次问题按标签或明确编号查询。</Text>
                        </Space> : <Text type="secondary">可普通聊天或问药材知识；查具体档案可带入标签或输入完整批次号。</Text>}
                    </div>
                </div>
                {historyLoading && <Text type="secondary">正在同步聊天记录…</Text>}
                {historyError && <Alert type="error" showIcon title="聊天记录加载失败"
                    description={historyError}
                    action={<Button size="small" onClick={reloadHistory}>重试加载</Button>} />}
                {conversationBusy && !isPending && <Text type="secondary">
                    服务器仍有一条提问在处理，稍后会自动补查记录，不会重复调用模型。
                </Text>}
                <div className="assistant-history" aria-live="polite">
                    <AssistantMessages turns={turns} busy={blocked}
                        retry={(request) => { void send(request) }} />
                    <div ref={endRef} />
                </div>
                <div className="assistant-composer">
                    <Input.TextArea aria-label="AI 助手问题" value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={batch ? '询问这个批次，或输入药材名称了解基础知识' : '例如：山茱萸是什么？怎么查看溯源？'}
                        maxLength={500} showCount autoSize={{ minRows: 2, maxRows: 3 }}
                        onPressEnter={(event) => {
                            // Shift+Enter 换行；中文输入法选词时不能误发送。
                            if (!event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault()
                                if (valid && !blocked) void send()
                            }
                        }} />
                    <Space style={{ marginTop: 12 }}>
                        <Button type="primary" icon={<SendOutlined />} loading={isPending}
                            disabled={!valid || blocked} onClick={() => { void send() }}>发送</Button>
                        {isPending && <Button onClick={stop}>停止回答</Button>}
                    </Space>
                    <div className="assistant-history-note">
                        <Text type="secondary">{historyMode === 'api'
                            ? '本人历史已保存，关闭不删除；最近 40 轮，上下文最多 4 轮。'
                            : historyMode === 'demo'
                                ? '离线演示：仅本次登录保留历史，不调用 AI。'
                                : '加载后可发送；关闭会停止未完成请求。'}</Text>
                    </div>
                </div>
            </div>
        </Drawer>
    </>
}
