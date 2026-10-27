import { Button, Collapse, Empty, Spin, Tag, Typography } from 'antd'
import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import type { AssistantRequest, AssistantTurn } from '../../types/assistant'
import { formatAssistantAnswer } from '../../utils/assistant'

const { Text, Paragraph } = Typography
// 只在有回答时加载 Markdown 解析器，不让登录首屏承担这部分体积。
const AssistantMarkdown = lazy(() => import('./AssistantMarkdown'))

export default function AssistantMessages({ turns, busy, retry }: {
  turns: AssistantTurn[]; busy: boolean; retry: (request: AssistantRequest) => void
}) {
  if (!turns.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="你好，有什么可以帮你？" />
  return turns.map((turn) => (
    <section key={turn.id} className="assistant-turn">
      <div className="assistant-message assistant-message--user">
        <Text type="secondary">你{turn.batch ? ` · ${turn.batch.herbName} ${turn.batch.batchNo}` : ''}</Text>
        <Paragraph>{turn.question}</Paragraph>
      </div>
      <div className="assistant-message assistant-message--reply">
        <Text strong>良木助手</Text>
        {turn.status === 'pending' && <div><Spin size="small" /> 正在整理回答…</div>}
        {turn.status === 'pending' && turn.preview && <>
          <Suspense fallback={<Paragraph>{turn.preview}</Paragraph>}>
            <AssistantMarkdown>{turn.preview}</AssistantMarkdown>
          </Suspense>
        </>}
        {turn.reply && <>
          <div><Tag color={turn.reply.mode === 'demo' ? 'gold' : 'green'}>
            {turn.reply.mode === 'demo' ? '本地演示 · 未调用 AI'
              : turn.reply.scope === 'batch' ? '批次资料问答' : turn.reply.scope === 'knowledge' ? `${turn.reply.herbName} · 药材知识` : '良木助手回复'}
          </Tag></div>
          {/* 加载期间退回转义文本；不把模型正文交给 dangerouslySetInnerHTML。 */}
          <Suspense fallback={<Paragraph>{formatAssistantAnswer(turn.reply)}</Paragraph>}>
            <AssistantMarkdown>{formatAssistantAnswer(turn.reply)}</AssistantMarkdown>
          </Suspense>
          <Text className="assistant-copy-answer" copyable={{ text: formatAssistantAnswer(turn.reply) }}>复制回答</Text>
          {turn.reply.candidates?.map(candidate => <div key={candidate.id}>
            <Link to={`/trace/${encodeURIComponent(candidate.id)}`}>{candidate.herbName} · {candidate.batchNo} · 查看档案</Link>
            <div><Text copyable={{ text: candidate.traceCode }}>{candidate.traceCode}</Text></div>
          </div>)}
          {turn.reply.citations.length > 0 && <Collapse ghost size="small" items={[{
            key: 'sources', label: `查看依据（${turn.reply.citations.length}）`,
            children: <ul className="assistant-sources">{turn.reply.citations.map((source, index) => (
              <li key={source.id}>
                <span>[{index + 1}] </span>
                {source.url ? <Typography.Link href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</Typography.Link>
                  : <Link to={`/trace/${encodeURIComponent(turn.reply!.batchId!)}`}>{source.title}</Link>}
                <div><Text type="secondary">{source.publisher}</Text></div>
              </li>
            ))}</ul>,
          }]} />}
        </>}
        {(turn.status === 'error' || turn.status === 'stopped') && <>
          <Paragraph type="secondary">
            {turn.status === 'stopped' ? '已停止回答' : turn.error}
          </Paragraph>
          <Button size="small" disabled={busy} onClick={() => retry({ question: turn.question, batch: turn.batch })}>重新提问</Button>
        </>}
      </div>
    </section>
  ))
}
