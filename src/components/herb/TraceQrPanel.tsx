import { useMemo, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Space, Typography } from 'antd'
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons'
import { QRCodeCanvas } from 'qrcode.react'
import { buildTraceUrl } from '../../utils/traceUrl'

const { Text } = Typography

type Props = {
  traceCode: string
  /** 二维码尺寸（像素，正方形） */
  size?: number
  /** 不显示文字标签与按钮，仅显示图 */
  compact?: boolean
  /** 自定义说明文案 */
  description?: string
}

/** 共用二维码面板：渲染真二维码，支持复制链接 / 下载 PNG */
export default function TraceQrPanel({ traceCode, size = 168, compact = false, description }: Props) {
  const { message } = AntdApp.useApp()
  const url = useMemo(() => buildTraceUrl(traceCode), [traceCode])
  const canvasWrapRef = useRef<HTMLDivElement | null>(null)
  // 记录复制失败的具体链接，避免切换批次后显示旧链接。
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null)

  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('当前环境不支持剪贴板写入')
      }

      await navigator.clipboard.writeText(url)
      setManualCopyUrl(null)
      message.success('溯源链接已复制')
    } catch {
      setManualCopyUrl(url)
      message.warning('复制失败，请在下方手动复制链接')
    }
  }

  const downloadPng = () => {
    const canvas = canvasWrapRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `${traceCode}.png`
    a.click()
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        width: compact ? 'fit-content' : '100%',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <div
        ref={canvasWrapRef}
        style={{
          padding: 12,
          background: '#fff',
          border: '1px solid #e5ebe7',
          borderRadius: 8,
          lineHeight: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <QRCodeCanvas
          value={url}
          size={size}
          level="M"
          marginSize={2}
          fgColor="#1a3e2c"
          bgColor="#ffffff"
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      </div>

      {!compact ? (
        <Space
          orientation="vertical"
          align="center"
          size={4}
          style={{ width: '100%', minWidth: 0 }}
        >
          <Text
            strong
            copyable={{ text: traceCode }}
            style={{ fontSize: 13, overflowWrap: 'anywhere' }}
          >
            {traceCode}
          </Text>

          <Text
            type="secondary"
            style={{ fontSize: 12, overflowWrap: 'anywhere' }}
          >
            {description ??
              '扫码或访问链接查看公开档案（仅已审核批次）'}
          </Text>

          <Space wrap size={8} style={{ marginTop: 4 }}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={copyLink}
            >
              复制链接
            </Button>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={downloadPng}
            >
              下载二维码
            </Button>
          </Space>

          {manualCopyUrl === url ? (
            <div style={{ width: '100%', marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                点击链接文本后复制；手机可长按复制。
              </Text>
              <Input.TextArea
                aria-label="手动复制公开溯源链接"
                readOnly
                value={url}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}
        </Space>
      ) : null}
    </div>
  )
}
