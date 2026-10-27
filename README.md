# 良木药谷 LiangmuTrace

良木药谷是使用 React、TypeScript、Node.js 和 PostgreSQL 构建的中药材全链路智能溯源平台。项目围绕种植商、加工商、平台管理员和采购商四类角色，展示药材从建档、审核、种植、采收、加工、质检到下游溯源的协作流程。

项目面向前端与 AI 应用开发岗位作品集，提供批次溯源、AI 风险审核与人工复核、RAG 问答、多轮 AI 会话、看板、业务通知和协作聊天。前端支持真实 API 与静态 demo 两种数据源；出库/收货表示批次流转，项目不包含订单和支付。

## 在线演示

- Cloudflare Pages：<https://liangmutrace.pages.dev>
- 后端 API：<https://liangmu-trace-api.onrender.com/api/health>
- 当前线上使用 API 模式，连接 Render 后端、Neon PostgreSQL 演示库与 DeepSeek；不与本机开发数据库互通。静态 demo 保留为独立离线兜底。
- Cookie 认证要求同源访问。源码附带 Pages `/api`、`/socket.io` 代理；生产构建须设置 `VITE_AUTH_MODE=api`、`VITE_API_BASE_URL=/api` 并重新发布。旧构建直连 Render 会出现登录成功但无法验证状态；本地修改不代表线上已修复。
- 已审核档案可匿名访问，例如 [黄精公开溯源](https://liangmutrace.pages.dev/public/trace/YM-TRACE-2026-0015)。完整详情与 AI 需要登录；演示数据不代表真实药材质量认证。

## 核心业务链路

```text
种植商创建批次
  → 管理员审核
  → 种植商记录种植日志和采收信息
  → 加工商接收、加工、记录质检摘要并完成入库
  → 管理员确认出库
  → 采购商确认收货
```

采购商可在有权查看时通过药材列表、扫码或溯源码查询进入溯源详情；这些访问入口独立于上面的阶段流转。demo 模式的跨角色变化由同一浏览器的本地覆盖层模拟；API 模式已通过 Express 与 PostgreSQL 实现从建档到收货的跨账号业务流转。

### 溯源与智能问答的入口

药材列表点击、二维码扫描和溯源码查询是并列的批次访问入口，扫码不是查看溯源信息的前提。扫码保留连接实体药材与线上批次、快速定位批次的价值；列表则支持日常浏览、搜索后直接查看详情。

扫码抽屉支持摄像头、图片本地识别和手动输码。识别结果交给所在入口打开对应溯源信息，采购商列表可先展示预览，再进入完整档案。摄像头启停串行执行，关闭或切换标签后丢弃迟到结果，并在启动完成后释放旧实例；图片预览在替换/卸载时释放，不上传服务器，无二维码时提供中文提示并允许重新选图。二维码链接指向公开档案，复制失败时提供手动复制，窄屏允许文字和按钮换行。摄像头需要安全上下文和设备授权，手机/微信兼容性仍需真机核验。

批次详情页与快速预览的「问问 AI」打开同一个全局聊天抽屉，并带入所选批次。可见信息和可用操作由身份与权限决定。公开溯源页面只展示允许公开的字段；完整详情与真实 AI 服务需要登录。

AI 聊天支持可移除的批次标签和完整 YM 编号定位。API 模式按账号保存历史，刷新/重登读取最近 40 轮，服务端最多使用 4 轮相关历史；批次事实每轮重新按权限读取。直接发送查询码可查看概况，“黄芪的溯源信息”等按药名查可见批次，多条结果先选择，不能借用不相关标签。

聊天查码没有找到当前账号可查看的批次时，正常提示“未查到该溯源码相关的药材批次信息，请核对后再试～”，保存本轮记录但不调用模型；不把查询无结果当成系统故障。兼容复制时的大小写、全角字符和横线差异，不猜测或纠正编号中的数字；残缺或多个编号先澄清，普通数字不强制查询批次。

药材与中医健康科普无需批次：优先检索小型人工知识库（17味36片段，含百合），缺少主题覆盖时用同一服务端 Key 调用 [DeepSeek 搜索 API](https://api-docs.deepseek.com/guides/search/)，只取 HKBU、植物智、香港卫生署中医药规管办公室等已允许站点的有限摘要，再由模型依据来源回答。两种来源共用聊天与“查看依据”，联网摘要保留来源标识，不伪装为人工收录；暂存有时效的内存缓存，不自动永久入库。知识库和网络都缺依据时说明限制，不编造。支持问候、轻量日常聊天和平台帮助；医学科普不替代个人诊断、处方或剂量建议。旧无关历史保留展示但不进入模型上下文，静态 demo 不联网、不调用真实 AI。

“脾虚可以吃什么中药”等问题可按科普方式介绍有来源的常见药材及传统用途，不再直接返回医疗拒答模板；不据症状替用户诊断、推荐个人方案或给出精确剂量、频次、疗程等可照做内容。医学流式预览先检查完整句子；轻量输出检查尽量只移除具体方案，保留其余科普和相应来源，不代表完整医学安全保证。界面使用自然提示，内部规则、校验状态和模型上下文限制不作为聊天说明展示。

回答支持基础 Markdown 与 GFM 表格，解析器在有回答时懒加载；表格和代码块在自己的区域横向滚动。正文不执行原始 HTML，不提供模型生成的可点击链接或图片，来源仍由校验后的“查看依据”展示。复制保留原始 Markdown 和友好引用编号。API 聊天接收 DeepSeek 的真实增量正文，经 POST SSE 展示“生成中”预览；只有结构、引用和权限校验通过且数据库保存后才显示正式回答。停止/关闭取消未完成请求，失败与中止不自动重跑；客户端展示友好提示，模型 JSON/引用等诊断码仍在服务端保留。风险审核 SSE 仍是步骤进度，不是聊天正文流。

平台使用帮助与批次事实采用有限规则分流，例如「平台登记的批次产地」仍读取批次资料，不因包含「平台」而当作普通聊天。当前阶段、审核、风险标记及事件类型以中文交给模型；数据库/API 枚举不变，低风险或审核通过均不代表医疗安全结论。

窄屏或短视口默认收起批次前缀工具，批次标签仍显示，工具可手动展开；聊天记录独立滚动。详情与时间线统一判断附件地址，没有可打开地址的登记记录标为「仅元数据，暂无文件」，不提供占位链接。地址格式检查不证明文件存在，也不替代服务端授权；项目尚未接入对象存储上传。

登录回跳只接受安全且当前角色可进入的已知页面，保留合法目标的查询参数与锚点；其他角色或未知页面回到当前角色工作台。此逻辑只改善导航体验，不替代前端 403 守卫或后端角色、组织与资源权限。

API 登录由后端通过 `Set-Cookie` 签发一小时 JWT，保存在 `HttpOnly; SameSite=Lax; Path=/` Cookie 中，生产环境附加 `Secure`。前端不接收、保存或解码真实 token；登录后再次调用 `/auth/me` 确认 Cookie 生效，刷新也通过此接口恢复身份。普通请求、AI SSE 和 Socket.IO 共用 Cookie，业务权限仍由后端独立检查。HttpOnly 限制脚本读取凭证，不消除 XSS，也不代替 CSRF 防护。[Cookie 属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

退出等待 `/auth/logout` 清 Cookie，失败提供重试；401/账号失效只清前端状态和私有缓存，不自动调用退出接口。前端以内存身份版本隔离旧请求、旧流与旧连接；同一浏览器配置中的标签页共享登录，通过 BroadcastChannel 通知重新核验，回到页面时也会验证身份。私有请求额外核对期待的用户 ID，该 ID 不能授予身份或权限。登录/退出串行执行，支持原生 Web Locks 时也协调同源标签页。演示管理员和采购商双账号请使用不同浏览器或独立浏览器配置。

未提供 Refresh Token、自动续期、设备管理或服务端 token 吊销；清 Cookie 不会撤销已泄漏的 JWT。demo 仍使用独立的 `sessionStorage` 模拟身份和本地业务数据，不能当作安全鉴权；迁移只清理旧认证键，不清业务样例、用户偏好或数据库 AI 历史。

API 模式提供最小账号开通：在登录页采购商标签下注册，服务端固定采购商角色并创建独立采购组织，成功后返回登录；不能自行加入已有组织。管理员从药材管理页的「账号管理」创建三类业务账号，选择已有启用且类型匹配的组织，或停用/启用账号。停用阻止登录与后续受保护请求，不删除历史批次或消息，也不管理其他管理员。弹窗按需加载，离线 demo 不模拟注册或管理；邮箱未验证，资料编辑、改密和找回密码尚未提供。

管理员的风险审核抽屉支持停止分析或关闭窗口取消未完成请求；重新打开时读取最近已保存建议，不自动重新调用模型。只有本次读取成功、未暂停且建议未过期时才能提交人工结论，人工提交期间禁止关闭；取消分析不会撤销已提交的结果。

药材管理顶部提供 Agent 资料审核工作台，可筛选待审或直接打开最近的待审批次。已审核/驳回批次的入口为「查看 AI 建议」，窗口明确显示不能分析的原因；读取失败或暂停时先恢复读取，不重复付费分析。报告以单栏工具过程、建议版本和“模型判断／服务端资料”对照展示；填入建议只是预填，人工复核建议不会预选通过或驳回。运行过程是实际阶段事件，不是思维链。

风险 Agent 使用阶段化的资料检查规则：当前缺失项由后端生成，模型解释文本一致性和疑点，不把未来流程或未接入的医学检测当作建档缺失。v2 报告同时展示模型判断与服务端资料快照，兼容旧 v1 报告；正常仅表示当前登记检查未发现问题，不是药材安全认证。前后端需共同发布支持 v2 的版本，来源有效仍不能保证判断正确。

### 业务通知与人工沟通

业务通知提供全部、未读、已读筛选，人工沟通使用独立联系人和私聊页面。采购商仅联系平台管理员兼任的客服；种植商和加工商按同组织、已分配批次协作关系及平台权限访问联系人，每次读取和发送仍由后端检查。

人工消息通过 HTTP 保存于 PostgreSQL，Socket.IO 只提示相关账号重新查询，不用推送数组代替数据库。通知与聊天共用一条 App 连接，铃铛合计两类未读；连接/重连重新查询，聊天另有可见页面的 20 秒轮询兜底。发送失败重试复用原消息 UUID，已读游标只前进；只有会话页面正在被查看时自动上报已拉取位置。当前是单实例最小私聊，不包含群聊、附件或必达推送保证。

业务通知使用批次 ID 定位完整详情，列表与扫码使用溯源码；页面通过统一数据源读取同一档案。数据库 ID 保留原大小写，溯源码按约定规范化，入口不同不改变服务端访问权限。源码修改需重新构建并发布前端后，才会影响在线站点。

## 技术栈

### 前端

- React 19 + TypeScript
- Vite
- Ant Design + Less
- React Router
- TanStack Query
- ECharts
- html5-qrcode + qrcode.react
- socket.io-client

### 后端与数据

- Node.js + Express + TypeScript
- PostgreSQL
- Prisma + `@prisma/adapter-pg` + `pg`
- bcryptjs
- jose（JWT）+ express-rate-limit（登录限流）
- Zod
- Socket.IO

### 部署

- Cloudflare Pages：前端静态站点 + Pages Function 同源 API/Socket 代理
- GitHub：代码托管与自动部署触发

Pages 托管前端，`public/_worker.js` 固定转发 `/api`、`/socket.io` 到 Render，其余路径继续静态托管；`_routes.json` 只让这两类路径调用函数。代理保留 Cookie/Set-Cookie、来源与 CSRF 头，禁止 API 缓存，直接转发 SSE 正文流和 WebSocket 升级。浏览器不直连跨站 Render；认证、数据库与 AI 仍由 Node 后端处理。生产配置见 [后端 README](server/README.md)。

`wrangler.json` 固定 Pages 产物目录与兼容日期，并启用请求中止信号转发，避免旧运行时不支持 `cache: no-store`，以及停止流式请求后上游仍继续处理。该文件只配置 Pages Function，不包含密钥；`VITE_*` 构建变量仍由平台设置。

## 当前数据架构

```text
React 页面
  → TanStack Query hooks
  → herbDataSource.ts（按 VITE_AUTH_MODE 切换）
      ├─ api：services/api.ts → Express → Prisma → PostgreSQL
      └─ demo：herbStorage.ts → JSON 样例 + localStorage 覆盖层
```

API 模式下，批次列表、列表点击详情、扫码/输码查询和直接溯源链接均读取 PostgreSQL。列表接口只返回摘要，依赖事件链的页面再按需查询详情。种植商可建档、记录日志和登记采收，管理员可审核并确认出库，加工商可从共享待认领池接收批次、完成加工并记录质检摘要，采购商可确认收货。组织、操作人、阶段规则与并发版本均由服务端身份与当前数据库状态决定。

管理员出库时指定有效采购组织，只有该组织可以确认收货。API 模式的候选组织、收货能力和数据访问范围由服务端校验，API 请求失败不会退回 demo。

## 项目目录

```text
LiangmuTrace/
├─ public/                 # 静态资源、药材图片和 JSON 样例数据
├─ src/
│  ├─ components/         # 公共组件、扫码与溯源组件
│  ├─ hooks/              # TanStack Query 数据 hooks
│  ├─ mock/               # 账号、看板、消息等演示数据
│  ├─ pages/              # admin、buyer、grower、processor 页面
│  ├─ config/             # API 地址与认证模式
│  ├─ services/           # 请求层、认证状态、本地数据访问与 QueryClient
│  ├─ types/              # 认证与药材业务类型
│  └─ utils/              # 鉴权、溯源码和业务辅助函数
├─ server/
│  ├─ prisma/             # Prisma schema、migrations 与 seed
│  └─ src/                # Express 应用、配置和路由
├─ tests/                  # 前端认证与请求层自动化测试
└─ README.md
```

## 本地运行

### 1. 启动前端

```powershell
npm ci
npm run dev
```

默认地址：<http://localhost:5173>

开发默认使用真实 API，需另开终端启动后端。Vite 将 `/api` 和 `/socket.io`（含实时连接）代理到 `http://localhost:4000`；代理只在开发服务器生效。

认证模式配置：

| 文件 | 默认行为 |
| --- | --- |
| `.env.development` | `npm run dev` 使用 `VITE_AUTH_MODE=api` |
| `.env.production` | `npm run build` 使用 `VITE_AUTH_MODE=demo`，可静态部署 |
| `.env.example` | 本地开发覆盖模板，按需复制为不提交的 `.env.development.local` |

只体验前端时，在 `.env.development.local` 设置 `VITE_AUTH_MODE=demo` 后重启 Vite。生产覆盖用 `.env.production.local` 或平台构建环境变量；模式专用文件优先于通用 `.env.local`，进程环境变量优先级最高，不能误认为 `.env.local` 总会覆盖 `.env.production`。[Vite 配置优先级](https://vite.dev/guide/env-and-mode)

本地接后端使用 `VITE_AUTH_MODE=api`、`VITE_API_BASE_URL=/api`，统一从 `http://localhost:5173` 打开，不混用 `127.0.0.1`；后端 `CLIENT_ORIGIN=http://localhost:5173`。Vite 同时代理 REST、SSE 和 `/socket.io`。Pages 生产使用相同前端变量，由随构建发布的 `_worker.js` 代理，Render 设置 `NODE_ENV=production`、`CLIENT_ORIGIN=https://liangmutrace.pages.dev`。生产 API 模式只接受 `/api`，旧 Render 绝对地址会在构建时失败；其他托管方式也必须提供真正的同源代理。发布后仍需验证 HTTPS Cookie、来源检查、AI 流式及 Socket，不能把本地检查记成线上或真机通过。

`VITE_*` 会进入浏览器构建产物，禁止填写数据库密码、JWT 密钥或 AI Key。仓库 `.env.production` 保持 demo 默认值；托管平台变量可覆盖它，修改变量后必须重新构建，不能只刷新旧页面。

### 2. 准备 PostgreSQL

全新本地环境创建数据库；现有环境继续使用原库，不因项目更名另建数据库：

```text
liangmu_medicine
```

首次配置且 `server/.env` 不存在时，复制后端环境变量模板：

```powershell
Copy-Item .\server\.env.example .\server\.env
```

在 `server/.env` 中填写本机数据库连接串。真实密码和 API Key 只能保存在 `.env`，不得提交到 Git。

### 3. 首次安装与初始化后端

```powershell
cd server
npm ci
npm run prisma:validate
npm run prisma:generate
npx prisma migrate deploy
```

仅全新开发数据库需要样例数据时，另行执行 `npm run prisma:seed`。它会按固定主键更新数据，不用于已有数据库的日常启动或生产上线。

### 4. 日常启动后端

在独立终端进入 `server` 后执行 `npm run dev`，无需重复运行 migration 或 seed。

默认地址：<http://localhost:4000>

健康检查：<http://localhost:4000/api/health>

开发环境未配置 `JWT_SECRET` 时使用进程级随机密钥，重启后旧 Token 失效，需要重新登录。生产环境必须设置 `NODE_ENV=production`、显式 HTTPS `CLIENT_ORIGIN` 和至少 32 字符的随机 `JWT_SECRET`；可信代理默认关闭，上线按实际网关核对。接口契约与错误码见 [后端 README](server/README.md)。

## 演示账号

以下账号同时存在于前端 Mock 与本地数据库 seed 中。API 模式由数据库校验（只保存 bcrypt 哈希）；demo 模式仅做本地演示校验，不能当作安全鉴权。API 失败不会回退到 Mock。

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 管理员 | `lijialin` | `lijialin123` |
| 采购商 | `chenjingxuan` | `chenjingxuan123` |
| 种植商 | `yuanyuhang` | `yuanyuhang123` |
| 加工商 | `haorunyuan` | `haorunyuan123` |

## 常用校验命令

前端：

```powershell
npm run lint
npm test
npm run build
npm run check:bundle
```

测试使用 Node.js 内置测试器和 Vite，覆盖认证、业务数据源、AI/实时消息、公开溯源与工程化规则。运行测试不需要真实数据库或模型调用。

后端：

```powershell
cd server
npm run typecheck
npm test
npm run build
npm run prisma:validate
```
