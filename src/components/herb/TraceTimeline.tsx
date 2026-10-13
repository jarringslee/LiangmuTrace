import { useMemo } from 'react'
import { Empty, Tag, Timeline, Typography } from 'antd'
import type { TimelineProps } from 'antd'
import {
  AuditOutlined,
  CarOutlined,
  DropboxOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  PlusCircleOutlined,
  SwapOutlined,
  TransactionOutlined,
} from '@ant-design/icons'
import {
  EVENT_TYPE_LABEL,
  STAGE_LABEL,
  type BatchEvent,
  type EventType,
} from '../../types/herb'
import type { UserRole } from '../../types/auth'
import { filterEventsForRole } from '../../utils/herbEvents'
import './TraceTimeline.less'

import { getAttachmentHref } from '../../utils/attachmentUrl'

const { Text } = Typography

const EVENT_ICON: Record<EventType, React.ReactNode> = {
  create: <PlusCircleOutlined />,
  audit: <AuditOutlined />,
  stageChange: <SwapOutlined />,
  qcReport: <ExperimentOutlined />,
  storage: <DropboxOutlined />,
  transport: <CarOutlined />,
  transaction: <TransactionOutlined />,
  note: <FileTextOutlined />,
}

const EVENT_COLOR: Record<EventType, string> = {
  create: 'green',
  audit: 'blue',
  stageChange: 'purple',
  qcReport: 'cyan',
  storage: 'gold',
  transport: 'geekblue',
  transaction: 'magenta',
  note: 'gray',
}

const OPERATOR_ROLE_LABEL: Record<NonNullable<BatchEvent['operatorRole']>, string> = {
  admin: '管理员',
  grower: '种植商',
  processor: '加工商',
  buyer: '采购商',
  system: '系统',
}

type Props = {
  events: BatchEvent[]
  role: UserRole
  /** 是否按时间倒序展示（默认 true，最新在上） */
  reverse?: boolean
  /** 仅取前 N 条（在倒序后截取） */
  limit?: number
  mode?: Exclude<TimelineProps['mode'], 'left' | 'right'>
  /** 空数据时的描述文案 */
  emptyDescription?: string
}

export default function TraceTimeline({
  events,
  role,
  reverse = true,
  limit,
  mode = 'start',
  emptyDescription = '暂无链路事件',
}: Props) {
  const visible = useMemo(() => {
    const filtered = filterEventsForRole(events, role)
    const sorted = [...filtered].sort((a, b) =>
      reverse ? (a.occurredAt < b.occurredAt ? 1 : -1) : a.occurredAt < b.occurredAt ? -1 : 1,
    )
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted
  }, [events, role, reverse, limit])

  if (visible.length === 0) {
    return <Empty description={emptyDescription} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  return (
    <Timeline
      mode={mode}
      items={visible.map((e) => ({
        color: EVENT_COLOR[e.type],
        icon: EVENT_ICON[e.type] as React.ReactNode,
        content: <EventCard event={e} />,
      }))}
    />
  )
}

function EventCard({ event }: { event: BatchEvent }) {
  // 受控阶段事件按当前阶段字典展示，不回写历史记录中的旧“已售”标题。
  const title = event.type === 'stageChange' && event.fromStage && event.toStage
    ? `阶段变更：${STAGE_LABEL[event.fromStage]} → ${STAGE_LABEL[event.toStage]}`
    : event.title
  return (
    <div>
      <div className="trace-timeline__event-title">
        <Tag variant="filled">{EVENT_TYPE_LABEL[event.type]}</Tag>
        <span>{title}</span>
        {event.fromStage && event.toStage ? (
          <Tag color="purple" variant="filled">
            {STAGE_LABEL[event.fromStage]} → {STAGE_LABEL[event.toStage]}
          </Tag>
        ) : null}
        <span className="trace-timeline__event-time">{event.occurredAt}</span>
      </div>
      {event.description ? (
        <div className="trace-timeline__event-desc">{event.description}</div>
      ) : null}
      {event.operatorName ? (
        <div className="trace-timeline__event-desc">
          <Text type="secondary" style={{ fontSize: 12 }}>
            操作主体：{event.operatorName}
            {event.operatorRole ? `（${OPERATOR_ROLE_LABEL[event.operatorRole]}）` : ''}
          </Text>
        </div>
      ) : null}
      {event.attachments && event.attachments.length > 0 ? (
        // 有允许的地址才渲染链接，否则明确展示登记信息，不再出现 href="#" 的假入口。
        <div className="trace-timeline__event-attachments">
          {event.attachments.map((a) => {
            const href = getAttachmentHref(a.url)
            return (
              <Tag key={a.url + a.name} icon={<PaperClipOutlined />}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {a.name}
                  </a>
                ) : (
                  <Text type="secondary">
                    {a.name}（仅元数据，暂无文件）
                  </Text>
                )}
              </Tag>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
