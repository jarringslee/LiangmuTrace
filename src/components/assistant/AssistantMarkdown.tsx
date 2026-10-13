import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 模型只能控制文字和排版；链接/图片/HTML 不进入正文，真实来源仍在“查看依据”。
const allowedElements = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
const components: Components = {
  table: ({ children }) => (
    <div className="assistant-markdown-table" role="region" aria-label="回答表格，可横向滚动" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
}

export default function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown remarkPlugins={[remarkGfm]} allowedElements={allowedElements}
        skipHtml unwrapDisallowed components={components}>
        {children}
      </Markdown>
    </div>
  )
}
