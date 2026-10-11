# LiangmuTrace Server

良木药谷后端使用 Node.js、Express、TypeScript、PostgreSQL 和 Prisma 7，为批次流转、AI 问答、通知和协作聊天提供认证 API。

## 服务范围

- JWT 登录、角色守卫、组织范围与账号状态校验
- 批次读取、阶段流转、事务溯源事件与版本并发保护
- 匿名公开溯源白名单
- DeepSeek 风险分析、RAG 问答与按账号保存的多轮 AI 会话
- 业务通知、协作聊天及 Socket.IO 实时提示
- PostgreSQL 健康检查与开发环境初始化工具

## 本地准备

安装依赖：

```powershell
cd server
npm ci
```

首次配置且 `.env` 不存在时，复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

在 `.env` 中填写本机连接串：

```env
DATABASE_URL=postgresql://postgres:你的密码@localhost:5432/liangmu_medicine?schema=public
```

`.env` 包含密码和 API Key，不得提交到 Git。后端启动和 Prisma 数据库命令都要求存在有效的 `DATABASE_URL`。

开发环境可以不设置 `JWT_SECRET`：服务启动时生成随机密钥，重启后需要重新登录。生产必须设置 `NODE_ENV=production`、显式 HTTPS `CLIENT_ORIGIN` 和至少 32 字符的随机 `JWT_SECRET`，非法配置会启动失败。可在本地生成密钥后复制到 `.env`，不要提交或发送给前端：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 生产配置

- 设置 `NODE_ENV=production`、显式 HTTPS `CLIENT_ORIGIN` 与至少 32 字符的随机 `JWT_SECRET`。来源只能是一个 origin，不带凭证、业务路径、查询或片段；允许尾斜杠并正规化。PostgreSQL URL 必须有主机/数据库名，端口范围为 1～65535
- `.env.example` 新增 `TRUST_PROXY=off`；实际 `.env` 与 `.env.*` 忽略，模板保留跟踪。dotenv 从当前工作目录读 `.env`，不会自动读 `.env.production`；生产推荐平台环境变量。AI Key 只在后端，数据库 TLS 按提供商要求核对
- 云库连接可单独保存在被 Git 忽略的 `.env.deploy.local`，但应用与 Prisma CLI 不会自动加载该文件；运行云端检查/迁移时必须显式指定连接，不能覆盖本机开发 `.env`。Render 根目录设为 `server`，构建用 `npm ci --include=dev && npm run prisma:generate && npm run build`，启动用 `npm start`
- 已有迁移发布到云库时，先核对目标并显式设置当前进程的 `DATABASE_URL`，再在 `server/` 执行 `npx prisma migrate deploy`，使用项目已安装的 Prisma 版本；样例 seed 仅用于经确认的全新空演示库，不加入构建、日常启动或每次部署，不使用 reset 初始化已有环境
- `DB_POOL_MAX` 默认 2（整数 1～20），`DB_CONNECT_TIMEOUT_MS` 默认 15000（整数 1000～60000 毫秒）。前者限制当前实例的数据库连接数，后者限制新连接或空闲连接的等待，不是 SQL/事务执行超时；连接池满时排队，不自动重试业务写入。[pg 连接池配置](https://node-postgres.com/apis/pool)
- `DB_TRANSACTION_TIMEOUT_MS` 默认 15000（整数 1000～60000 毫秒），单独限制交互式事务的执行时间；事务获取等待使用 `DB_CONNECT_TIMEOUT_MS`，不改变原有隔离级别。事务到期仍会取消并回滚，不能用增加超时替代 SQL 优化，也不将模型调用放进事务。[Prisma 事务配置](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)
- Express 应用显式读取可信代理设置，仅支持 off、loopback 或已核对的 IP/CIDR 列表，拒绝 true/纯跳数/全网 /0。必须另行阻止绕过网关、核对转发头；loopback 不会自动改变服务监听地址。内存限流与广播仍是单实例 MVP，不是全局限流
- HTTP 仅向配置的前端源给出 CORS 许可；Bearer 不使用跨站 Cookie，预检允许 Authorization/Content-Type、向浏览器暴露 Retry-After。无 Origin 或其他来源仍由 JWT/角色/组织独立鉴权，CORS 不能阻止 CLI 请求。[CORS 原理](https://expressjs.com/en/resources/middleware/cors/)
- Pages 只托管前端；独立 Node HTTPS 后端须支持 `/api`、SSE 无缓冲/不缓存/足够超时以及 `/socket.io` polling/Upgrade。生产代理、数据库 TLS 和微信兼容性需要在实际托管环境核验。

## 初始化数据库

校验 Schema 并生成 Prisma Client：

```powershell
npm run prisma:validate
npm run prisma:generate
```

在新环境应用仓库中已有的 migration：

```powershell
npx prisma migrate deploy
```

仅全新开发数据库需要样例数据时，单独导入；已有环境日常启动与生产部署不重复执行：

```powershell
npm run prisma:seed
```

Prisma 7 只会在显式执行 `prisma db seed` 时运行 seed。当前 seed 从仓库的 `public/data/herb-batches.json` 读取并校验 15 条前端样例，使用固定主键和 `upsert` 写入：

- 12 个组织
- 8 个测试账号
- 15 个药材批次
- 50 条批次事件
- 14 条审核记录
- 7 条附件元数据
- 4 条业务通知

重复执行不会增加重复记录。测试账号密码会先通过 bcryptjs 哈希，再写入 `passwordHash`。

## 启动与检查

开发启动：

```powershell
npm run dev
```

默认地址：<http://localhost:4000>

健康检查：<http://localhost:4000/api/health>

数据库可用时返回：

```json
{
  "status": "ok",
  "service": "LiangmuTrace API",
  "database": "connected",
  "timestamp": "..."
}
```

数据库不可用时返回 HTTP 503，并将状态标记为 `degraded`。

## 常用命令

```powershell
npm run typecheck
npm test
npm run build
npm run prisma:validate
npm run prisma:generate
npm run prisma:studio
```

`prisma:seed` 仅用于明确需要的开发数据初始化，不是常规校验；会按固定主键 upsert，可能覆盖现有开发记录。`migrate reset` 会清空数据库并重建结构，不能当作修复普通错误的命令。

修改 Schema 后，在交互式本地终端创建开发 migration：

```powershell
npm run prisma:migrate:dev -- --name 迁移名称
```

不要改写已经应用过的 migration。新环境或部署环境只应用仓库已有 migration，应使用 `prisma migrate deploy`。

## 鉴权接口

`POST /api/auth/login`，JSON 请求体：

```json
{ "account": "lijialin", "password": "lijialin123", "role": "admin" }
```

- `account` 支持用户名或邮箱，邮箱匹配不区分大小写。
- `role` 是登录页所选角色，后端会与数据库角色比较，不会据此授予权限。
- 不接受客户端传入 `organizationId` 等额外字段。
- 密码不做 trim；超过 bcrypt 的 72 字节限制直接拒绝。

成功返回 `{ accessToken, tokenType: "Bearer", expiresIn: 3600, user }`。
`user` 包含 `id / username / email / displayName / role / organizationId / organization`，不会返回 `passwordHash`。`organization` 为 `{ id, name, type }` 或 `null`。

`GET /api/auth/me`，请求头使用 `Authorization: Bearer <accessToken>`，成功返回 `{ user }`。Token 只携带用户 ID 等标准声明；每次请求重新读取用户角色、组织和禁用状态，禁用或改角色后旧 Token 也立即遵循新权限。

统一错误格式：`{ error: { code, message, details? } }`。前端以 HTTP 状态和 `error.code` 分支处理，不依赖中文消息内容。

| HTTP | 主要错误码 | 前端处理方向 |
| --- | --- | --- |
| 400 | VALIDATION_ERROR / INVALID_JSON | 展示输入错误 |
| 401 | INVALID_CREDENTIALS / UNAUTHENTICATED / INVALID_TOKEN | 登录失败或清理失效登录态 |
| 403 | FORBIDDEN / ACCOUNT_DISABLED / ORGANIZATION_DISABLED / INVALID_ORGANIZATION | 提示无权限或账号状态异常 |
| 404 | NOT_FOUND | 请求地址不存在 |
| 413 | PAYLOAD_TOO_LARGE | 提示请求体过大 |
| 429 | TOO_MANY_ATTEMPTS | 按 Retry-After 提示稍后重试 |
| 500 | INTERNAL_ERROR | 通用错误提示，不向客户端暴露内部异常 |

登录限流按 IP 计数：15 分钟内最多 20 次失败尝试，成功请求不持续计数。当前内存计数器仅适合单进程 MVP；反向代理部署时需按实际拓扑配置可信代理，不能盲设 `trust proxy = true`。

受保护的业务路由应先调用 `authenticate(service)`，再调用 `requireRoles(...)`；身份上下文在 `req.auth`。后续查询必须根据它的 `organizationId` 增加组织过滤，角色守卫不等于业务行级数据隔离。

测试位于 `tests/auth.test.ts`，使用 Node.js 内置测试器、真实 JWT/bcrypt 和内存用户模拟 HTTP 请求，无需数据库在线。`npm run typecheck` 同时覆盖运行代码、seed 和测试。

MVP 暂不实现 Refresh Token 和服务端登出撤销：客户端退出时删除本地凭证，不会撤销已泄漏的 Token；它仍可能在过期前使用。部署必须使用 HTTPS，JWT 密钥不得传入前端。

## 匿名公开溯源接口

`GET /api/public/trace/:traceCode` 不要求 JWT，也不因无效 JWT 拒绝公开查询。只接受完整溯源码，无额外查询参数，返回 `{ batch }`；前端 `/public/trace/:traceCode` 只使用白名单字段，完整详情、AI 和实时订阅仍要求登录及权限检查。

- 批次必须审核通过、种植组织启用且为种植机构；未知、未审、驳回、种植组织停用统一 404，不泄露具体拒绝原因
- 白名单：药材/批次号/溯源码、类别、省市区县、机构名称、种植日期、阶段/风险标记和登记/更新时间。没有地块地址、内部 ID、账号/姓名、自由文本、附件、审核意见或 AI 记录；白名单中的名称仍需人工审核，非自动个人信息检测或质量认证
- 节点仅建档/阶段变更/质检/仓储/运输，且 visibleRoles 为空。仅返回类型/时间/受控阶段，最多最近 100 条，`eventsTruncated` 表示截断；不返回原始标题/备注/操作人/payload
- 查询使用最小 select、同一只读数据库快照，service 再次核验公开资格；所有响应 no-store。每连接 IP 每分钟 60 次内存限流，429 带 Retry-After；多实例共享限流与可信代理部署另行配置，不能信任任意 X-Forwarded-For
- 没有匿名列表、AI 或写接口；已发送的公开内容不可撤回，客户端缓存策略不能代替服务器审核状态检查。静态 demo 原始 JSON 可下载，本地筛选不是服务端安全隔离

## 批次接口

本节 `/api/batches` 接口均要求 `Authorization: Bearer <accessToken>`，并设置 `Cache-Control: no-store`；上面的独立公开接口不是完整详情的免鉴权版本。

读取接口：

- `GET /api/batches`：支持 `page`、`pageSize`、`search`、`stage`、`auditStatus`、`riskLevel`
- `GET /api/batches/:identifier`：`identifier` 可为数据库 ID 或溯源码

列表响应为 `{ items, pagination: { page, pageSize, total, totalPages } }`，详情响应为 `{ batch }`。数据范围由服务端认证身份决定，不接受客户端传入组织 ID：

- admin：全部批次
- grower：本种植组织批次
- processor：本加工组织已认领的批次，以及审核通过、已采收且未分配的共享待认领批次
- buyer：审核通过的批次

详情继续按 `visibleRoles` 过滤事件，完整审核历史暂只向管理员返回。不可见批次与不存在批次统一返回 404，避免通过接口枚举其他组织的数据。

写入接口：

- `POST /api/batches`：仅种植商可调用；服务端从认证身份派生种植组织与创建人，固定生成 `planting + pending + normal` 初始状态，并原子写入建档事件
- `PATCH /api/batches/:identifier/audit`：仅管理员可调用；接收 `approved/rejected`、可选原因与风险等级，原子更新状态、审核记录、审核事件和版本号
- `POST /api/batches/:identifier/events`：仅所属种植组织可追加种植日志，操作人由登录身份生成
- `POST /api/batches/:identifier/harvest`：仅所属种植组织可登记采收，原子写入采收事件、阶段变更事件，并将 `planting` 推进为 `harvested`
- `POST /api/batches/:identifier/processing/receive`：加工商认领未分配批次，绑定当前加工组织并推进为 `processing`
- `POST /api/batches/:identifier/processing/complete`：本加工组织写入加工记录与阶段事件，推进为 `warehousing`
- `POST /api/batches/:identifier/processing/quality-report`：本加工组织为加工中或仓储批次保存质检文字摘要
- `GET /api/batches/dispatch-recipients`：仅管理员读取启用且至少有一名有效采购账号的采购组织 ID/名称，不接受额外 query；固定路径在 `/:identifier` 前注册
- `POST /api/batches/:identifier/shipping/dispatch`：仅管理员提交 `{ buyerOrganizationId }`，事务内重新校验目标组织，把未分配、审核通过的仓储批次推进为 `shipped` 并保存收货组织/事件；拒绝额外身份/阶段字段
- `POST /api/batches/:identifier/receipt/confirm`：请求体为空；仅指定采购组织可将审核通过的已出库批次推进为 `sold`，组织与操作人均由登录身份生成。不存在/非所属/历史未分配统一 404，重复或版本竞争 409

请求体使用 Zod 严格校验，不接受客户端伪造当前账号组织、创建人、事件操作人和初始审核状态等可信字段。出库的目标采购组织属于业务选择，并非当前账号身份，仍须服务端核验；加工与收货使用登录身份绑定组织。出库/收货使用数据库事务及 `version + 当前阶段 + 审核状态 + 收货组织` 条件更新，避免重复请求或并发覆盖；收货更新同时要求组织启用且类型为 buyer。业务日期按 `Asia/Shanghai` 判断。

批次可指定 `buyerOrganizationId` 收货组织，只有所属采购组织可以收货。列表/详情的 `canConfirmReceipt` 由服务端派生；收货组织 ID/名称只向管理员及所属采购商返回，其他角色置 null，匿名白名单不增加采购组织字段。历史未分配批次不能收货。这是组织归属，不是订单、支付或个人指定收货人。

## AI 风险审核接口

管理员可在风险审核抽屉中读取建议、发起真实 DeepSeek 分析并提交人工复核。开发时在 `server/.env` 设置 `DEEPSEEK_API_KEY` 后重启后端，`DEEPSEEK_MODEL` 默认 `deepseek-flash`，模型名称可以按账户支持情况调整。Key 只保存在服务端；模板中的 Key 必须保持为空。

前端停止分析或关闭抽屉会取消尚未完成的连接，重新打开只 GET 已保存建议，不自动重跑付费分析。停止不能撤销已经提交的建议；重新读取失败、暂停、正在读取或建议过期时不能提交人工结论，人工审核提交期间不允许关闭。

- `GET /api/batches/:identifier/risk-analysis`：查询最新建议，没有记录时返回 `{ analysis: null }`；批次版本变化或已审核时标记 `stale`
- `POST /api/batches/:identifier/risk-analysis`：管理员发起分析，返回 201 `{ analysis }`；仅允许待审核批次，请求体为空
- `POST /api/batches/:identifier/risk-analysis/stream`：同样要求管理员和待审核状态，请求体为空；成功响应为 `text/event-stream`，与非流式分析共用每用户限流
- `POST /api/batches/:identifier/risk-analysis/:analysisId/review`：管理员提交 `{ decision, riskLevel, reason }`，事务内更新审核状态并关联建议记录

Agent 使用 `get_batch_snapshot`、`inspect_trace_records` 两个只读工具。工具参数不接受其他批次 ID；最多三轮取数、六次工具执行和一次最终 JSON 输出。服务端使用 Zod 校验结果并检查引用 ID 来自本轮资料；资料缺失或已有风险不能被模型降低为“正常”。引用 ID 有效不等于模型结论绝对正确，人工仍需核对依据。没有药典或外部医学规则接入。

建议存放在 `BatchEvent.payload`（`kind=auditRiskAnalysis`），只对管理员可见；人工结论存放在 `BatchAudit`（`source=aiAssisted`），保存模型名与分析快照。无需新增 migration。分析不会改动 `auditStatus/riskLevel`，只记录建议并递增版本；人工复核通过版本条件更新拒绝旧建议和重复提交。

分析整体超时为 55 秒，每用户每分钟最多 5 次，单进程内同批次不能同时分析。上游 401 转为本系统 502，避免前端把 AI Key 配置错误当作登录失效。主要错误码包括 `AI_NOT_CONFIGURED`（503）、`AI_TIMEOUT`（504）、`AI_UPSTREAM_ERROR/AI_INVALID_RESULT`（502）、`AI_ANALYSIS_STALE/AI_ANALYSIS_RUNNING`（409）、`AI_RATE_LIMITED`（429）。

协议参考：[DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion)。模型仍以完整 JSON 返回；SSE 是服务端业务阶段事件，不是模型逐 token 输出或思维链。

### SSE 阶段与取消

前端使用 TanStack Query 管理请求与已保存建议，React state 保存本次临时进度，AbortController 保存在 ref 中；停止/失败后查询最近保存结果，不自动重跑分析。生产反向代理仍需配置 SSE 无缓冲、超时与断线取消。

- `progress`：`{ seq, stage, status, message, toolName?, at }`；stage 为 snapshot/model/tool/validate/save，status 为 running/completed，seq 在本次连接中连续递增
- `result`：`{ analysis }`，只在完整校验和保存后发送；建议仍待管理员人工审核
- `error`：`{ status, code, message }`，终态错误，不泄露上游或数据库内部诊断；开始 SSE 前的权限、入参、阶段等错误仍返回标准 HTTP JSON
- 采用 UTF-8 和空行分帧，每 10 秒发送注释心跳；使用 `no-transform` 与 `X-Accel-Buffering: no`，部署时仍需实际确认反向代理不会缓冲
- 不自动重连；单条 POST 代表一次付费分析。断流后先 GET 查询最新建议，必要时由用户手动重新分析
- 响应连接关闭会通过 AbortSignal 中断后续模型调用，服务在模型/工具/保存边界检查取消；事务内提交前观察到取消则回滚。客户端取消记为 `AI_CANCELLED`，整体超时仍为 `AI_TIMEOUT`
- 如果取消与数据库提交竞态，已经保存的建议不会自动删除；取消也不保证退还上游已产生的费用。MVP 没有后台任务队列、持久化运行进度或断点续传

格式参考：[MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。

## 单轮 RAG 资料问答

`POST /api/batches/:identifier/questions`：需要登录，请求体严格为 `{ "question": "2～500 字符的问题" }`，返回 `{ reply }`。四角色均使用现有 `BatchService.detail` 的组织/批次范围与事件裁剪，不接收前端批次快照、资料来源或角色。未知或无权访问均返回 404。

- `reply` 含问题、纯文本答案、answered/insufficient 状态、服务端映射的 citations、批次 ID、模型名、知识版本和时间；不修改批次、保存会话或自动审核
- 在 `src/knowledge/herbs.ts` 人工整理五味药材的 10 个非临床背景摘要（v2 增加黄精），链接到香港浸会大学中药材图像数据库的公开可检索记录；核对日期不是原文发布时间，不是完整药典或全量爬虫
- 中文双字片段/英文词 + BM25 词法检索与小量扩展，最多 6 个相关片段；没有依据则直接资料不足。Embedding/pgvector 后置，无新 Key、依赖、表或 migration。评分参数参考 [Elasticsearch BM25](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity)
- 批次事实来自权限裁剪后的 detail，排除 AI 审核建议、操作人和完整 payload；当前只查看基础字段及最近 20 条可见事件的有限文字摘要
- 模型仍使用既有 DeepSeek 原生 fetch 代理，一次 JSON 生成；Zod 校验结构，引用 ID 必须来自本轮召回且与正文对应，URL 由服务端映射，不由模型提供。检查引用存在不能证明内容完全受来源支持
- 55 秒超时、断线取消、每用户 10 次/分钟、单进程内每用户一次运行保护；返回前重新检查批次访问/版本与账号角色/组织变化。不是多实例共享队列或持久化任务
- 医疗关键词拒答和提示词隔离仅为 MVP 防护，不宣称完全解决医学安全、提示词注入或幻觉；不提供诊断、剂量、处方或治疗建议
- 前端 Hook/共用组件已接入详情与快速预览；本地浏览器采用 Mock 模型 + 真实 PostgreSQL 验收停止、失败、手动重试、来源展示与弹窗卸载，后端观察到两次取消。临时服务、脚本和标签已关闭/清理；不是生产环境或摄像头/微信真机扫码验收

新增错误码：`AI_QUESTION_RUNNING`（409）、`AI_QUESTION_STALE`（409）；AI 代理和取消错误沿用既有约定。问答与风险分析使用独立限流计数，两者不自动重试。

## 持久化通知与 Socket.IO

- `GET /api/notifications?page=1&pageSize=10&status=all` 返回 `{ items, total, unreadCount, page, pageSize }`；status 可为 all/unread/read，未读计数始终针对本人全部通知。用户 ID 来自登录身份，不接受 recipientId。未知查询字段返回 400
- `PATCH /api/notifications/:id/read` 接受空对象，返回 `{ item }`；四角色都只能标记本人消息，未知或其他收件人的 ID 统一返回 404。条件更新确保并发/重复点击不覆盖首次 readAt；通知内部 metadata/recipientId 不进入 DTO。通知路由响应设置 `Cache-Control: no-store`，避免私人数据被 HTTP 缓存保存
- 建档、首条事件与有效管理员的 batchSubmitted 通知在同一事务中写入；审核结果写给批次所属种植组织，审核通过的采收完成批次写给所有可接单有效加工商，加工完成进入仓储写给有效管理员
- 审核、采收、加工入库的批次状态/审核记录/事件和通知均在同一事务提交；允许先采收后审核，因此审核通过已采收批次时也会补发加工接收通知。事务完成后才发布提示，没有有效收件人时不创建空消息
- Express 与 Socket.IO 共用 HTTP Server；客户端使用 `/socket.io`，handshake.auth 仅接受 `{ token }`，JWT 验证与数据库 currentUser 检查独立于前端路由。服务端决定用户房间，不开放任意 join 指令；Origin 限定 CLIENT_ORIGIN，无 Origin 的 CLI 也必须有合法 JWT
- `notifications:changed` 只提醒前端缓存失效，不携带通知正文。JWT 到期主动断开；长连接每 30 秒检查账号、组织与角色变化，变化时发送 session:invalid 并断开（不是每帧实时检查）。每个 REST 请求仍独立认证
- 服务为单实例内存广播，没有 Redis adapter、outbox、持久化事件重放或必达保证。提示失败不撤销已提交业务；前端必须在连接/重连时查询 PostgreSQL 补齐，消息表是唯一持久化来源。参考 [Socket.IO 交付保证](https://socket.io/docs/v4/delivery-guarantees/)
- 前端数据源、Query Hook、App 全局订阅、消息中心与铃铛向四角色开放；账号缓存包含模式和用户 ID。首次连接/重连触发 REST 补查，旧连接通过 active 与 Token 检查丢弃回调，卸载移除监听并断开连接；铃铛合计业务通知与人工聊天未读数
- 人工聊天使用独立的会话接口；通知尚不覆盖质检/出库/收货或采购商关注关系。当前演示使用单实例 HTTP/WebSocket 服务，多实例共享广播和可靠投递仍未实现。

## 人工聊天 REST 与实时提示

| 接口 | 请求与用途 |
| --- | --- |
| `GET /api/chat/contacts?search=账号或姓名或组织` | 当前可联系账号，最多 30 条及 hasMore |
| `GET /api/chat/conversations` | 当前可访问的本人最近 100 个会话、预览、未读数及 hasMore |
| `POST /api/chat/conversations` | `{ recipientId }`，服务端检查联系人并创建/复用双方私聊 |
| `GET /api/chat/conversations/:id/messages?before=sequence` | 默认最新 40 条，升序返回，nextBefore 用于加载更早历史 |
| `POST /api/chat/conversations/:id/messages` | `{ clientMessageId: UUID, content }`，最多 2000 字符纯文本 |
| `PATCH /api/chat/conversations/:id/read` | `{ sequence }`，只推进本人的已读游标，不超过现有位置 |

- 所有请求独立认证、严格 Zod 校验与 no-store；不接受客户端发送人、组织、角色、sequence 或成员列表。未知与越权联系人/会话统一 404，UUID 复用改原文返回 409，非法已读位置 400
- `chatContactWhere` 查询有效账号与有效匹配组织：buyer 仅 admin；admin 可联系四角色；grower/processor 可联系同组织、admin 和已绑定批次合作组织。管理员也不能读取未参与的私聊；协作撤销后列表/历史/发送/已读均失去访问权
- 新增 `ChatConversation` / `ChatParticipant` / `ChatMessage`，不用 Notification 或 Assistant 表冒充人工聊天。双方排序 pairKey 唯一，senderId/clientMessageId 唯一，conversationId/sequence 唯一；发送在事务中原子递增会话序号，失败回滚。并发 UUID 唯一冲突后读取已提交结果，不重复保存
- 消息提交后只向双方 JWT 用户房间发布无正文的 `chat:changed`，与通知共用一个 Socket.IO Server。已读提示仅给本人；readSequence 条件更新保证只能前进，未读只统计另一人发送的消息
- 前端仅在会话可见且窗口聚焦时上报已拉取的最新 sequence，后台页面不自动清未读。超时/发送失败不自动重试；原文不变的手动重试复用 clientMessageId，避免服务端已保存但响应丢失时重复发消息
- 会话创建/消息发送共享单账号每分钟 30 次限流；没有多实例共享限流、Redis adapter/outbox、必达提示、群聊、附件、在线状态、撤回或客服排班。REST 是恢复记录的依据；前端重连/聚焦补查并对可见页面每 20 秒轮询兜底

## 普通聊天兼容接口

- `POST /api/assistant/chat` 请求 `{ question: string }`，去首尾空格后 2～500 字符，严格拒绝额外字段；四角色均需 Bearer 认证。响应 `{ reply: { id, scope: 'general', batchId: null, question, status, answer, citations: [], mode: 'api', modelName, createdAt } }`
- 只把系统说明与本轮问题交给 DeepSeek，要求 JSON 输出并用 Zod 校验，拒绝工具调用与额外生成字段。没有数据库读工具、检索、历史或医学能力，不冒充批次事实问答；医疗关键词拒答不产生模型费用，其他普通回复无 RAG 来源
- 接口每用户每分钟 10 次（普通聊天与旧批次问答分别计数）、该服务单用户同时一轮、55 秒超时，客户端断开向上游传递取消；取消不保证退还已产生费用。服务为单实例，限流/并发保护没有多实例共享
- `Cache-Control: no-store`；返回前重新读取当前用户，账号/组织停用或角色/组织变化不能返回旧身份结果。批次权限由原问答服务独立检查
- DeepSeek 请求层只在非 JSON 且确实传入 tools 时发送 tool_choice=required；普通无工具请求不再被强制工具调用，保留原 Agent/JSON 参数
- 该兼容接口不保存历史、不提供多轮上下文或编号定位；客户端应优先使用下方持久化会话端点，旧批次问答端点仅保留兼容

## 本人持久化会话

- `GET /api/assistant/conversation` 不接受查询字段，账号从 JWT/数据库身份派生，返回 `{ conversationId, mode: 'api', turns }`；按 sequence 返回最近 40 轮，每轮含 id（请求 UUID）、question、batch 标签、status、createdAt，完成轮带 reply，失败轮带安全 error。
- `POST /api/assistant/conversation/messages` 严格接收 `{ requestId: UUID, question: string, batchIdentifier?: string | null }`，返回 `{ turn }`；不接收客户端历史、角色、组织或检索资料。新端点与旧 `/chat` 共用每用户每分钟 10 次的内存限流，历史读取不调用模型；旧批次问答另计数。
- 新增 AssistantConversation（userId 唯一）与 AssistantTurn（会话/请求 UUID、会话/sequence 唯一）模型。事务通过 version 条件更新占用 65 秒租约；finish 同时核对账号、版本、请求与租约，旧结果不能覆盖后来请求。同请求返回已有记录，重用 UUID 改问题返回 409；失败/取消留痕，不自动再次执行模型。过期 pending 显示 stopped，下次新请求接管时标记中断。
- 新端点服务端最多取 4 轮/8 条相关历史，问题最多 500 字符，历史回答截取 1000 字符；普通聊天只取普通历史，批次追问只取同批次、同 version、同角色/组织记录。短追问用上一问补词法主题，事实与引用始终来自本轮按权限读取的 sources，旧回答不当知识库或事实。
- 普通问候/系统使用问题不强制 RAG；普通“刚才……”追问可沿用最近成功普通会话，但明确药材/批次主题仍走资料问答。问题中的 YM 批次号/溯源码优先于标签，经 detail 同一权限检查。多个编号、无编号或药材不匹配先澄清。规则分流不是通用意图识别；不做跨批次对比、模型写入工具或向量检索。
- 历史助手输出按当前 JSON 协议序列化，避免多轮模型仿照旧格式输出空白/缺字段；历史作为不可信对话，RAG 本轮引用只认可本轮 sources。召回前剔除定位编号/插入前缀，知识命中后补最小批次身份；“来源”与产地使用词法别名，不以通用产区替代具体批次产地。
- 读取/重放历史再次核对角色/组织和批次权限，删除/不可访问批次的原问题、答案、标签及来源全部隐藏。新会话 reply 只包含引用标题/发布者/链接，不包含检索 excerpt；生成期间身份/版本变化不能保存成功答案。医疗边界与注入隔离仍是 MVP 防护，不宣称完全安全。
- 新增错误：ASSISTANT_STORAGE_NOT_READY（503）、AI_REQUEST_CONFLICT/AI_REQUEST_STALE（409）；旧运行/版本冲突、取消/超时错误沿用。退出不删除数据库消息；历史撤权在重新读取时生效，不提供实时擦除已经显示的消息。旧兼容接口并发保护仍为单进程，限流没有共享 Redis。

## 管理员数据概览

`GET /api/dashboard/overview`：只允许已认证有效管理员，不接受查询参数。返回 mode/generatedAt/summary/stageDistribution/categoryDistribution/recentBatches/pendingBatches，响应 `Cache-Control: no-store`。

- 管理员范围与批次列表一致，统计全部批次，不从前端分页列表估算。按阶段/类别/审核/风险分组，汇总总数、待审、风险（低/中/高）、仓储；分布包含零值，仓储与审核互不替代
- Prisma 聚合、最近更新（最多 6 条）、待审（最多 5 条）在同一 RepeatableRead 快照中执行；列表按 updatedAt 倒序、id 稳定排序，只返回必要字段，时间为带时区 ISO 字符串。无事件/附件/审核理由或 AI 内部数据，不执行写入
- 统计通过 mutation 缓存失效、窗口聚焦和手动刷新更新，不是实时统计流；图表展示当前分布，不提供交易金额或趋势。

## 部署边界

前端开发服务器将 `/api` 和 `/socket.io` 代理到本服务；Cloudflare Pages 的静态 demo 不会部署 Node 后端。真实 API 模式需要独立 HTTPS Node 服务、可访问的 PostgreSQL、后端私密变量，以及 SSE/Socket 网关配置。

当前演示后端为 `https://liangmu-trace-api.onrender.com`，由 Render 新加坡单实例连接 Neon 演示库。根路径 `/` 没有首页，返回 JSON 404 正常；按需调用 `/api/health` 检查数据库连接，私有业务与 AI 接口需要真实 JWT。

服务使用单实例内存限流和实时广播，没有多实例共享限流或 Redis adapter。当前演示链路支持公网 HTTP、AI 问答、风险 SSE 与双账号人工消息提示；不能据此保证所有网络场景或推送必达。登录回跳、风险抽屉直接关闭取消与重开核验的前端改动尚未发布复验，微信/移动真机另验。`TRUST_PROXY` 暂为 `off`，不能宣称已按真实客户端 IP 正确区分代理后的 IP 限流。
