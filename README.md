# Pulse Personal Agent

Pulse 是一个本地优先、可自行访问、可迁移云端的个人管理 Agent。它以项目管理为第一个完整模块，同时统一处理飞书消息、文档、行动、搜索、汇报、Skill 和长期记忆。

当前代码已经从单体“项目 Bot”升级为五层架构：可替换飞书通信边缘、Pulse 业务编排、DeepSeek Harness 推理循环、受控 Tool Runtime、Hermes-inspired Memory 与 Claude-compatible Skill Registry。通信层同时支持飞书官方 SDK、飞书 CLI 和可选 OpenClaw；公司环境不允许 OpenClaw 时不影响任何核心能力。完整边界与数据流见 [Agent 架构说明](./docs/AGENT_ARCHITECTURE.md)。

## Skill 自进化

Pulse 同时支持人工触发与定时触发的 Skill 优化。`skill-curator` 只读取已发布 Skill、真实运行证据和用户明确指定的材料，通过受控工具生成候选版本并写入管理后台草稿箱。候选需要经过规则评测和人工审核后才能发布，模型无权直接覆盖生产版本、修改插件配置或扩大自身工具权限。

这套边界将“从证据中提炼可复用方法”交给模型，将版本存储、权限校验、评测、发布和回滚交给确定性工程服务。相关行为可以通过 `SKILL_EVOLUTION_ENABLED` 等环境变量控制，详细配置见 [本地运行说明](./LOCAL_SETUP.md)。

## 当前推荐：本地 Personal Agent

当前默认链路为 `飞书 → lark-cli → Pulse Gateway → DeepSeek Harness / Tool Runtime → SQLite → Web`。CLI 使用 `event consume` 接收消息、`docs +fetch` 读取用户投递的 Wiki / Docx、`im +messages-reply` 回复，并复用本机 Bot 配置。陌生 open_id 仍需六位配对码授权；官方 SDK 与 OpenClaw 只保留为回滚适配器，不会与 CLI 同时消费消息。

完整配置与启动步骤见 [LOCAL_SETUP.md](./LOCAL_SETUP.md)。本地运行不需要公网回调地址；没有模型密钥时仍可使用结构化降级整理，但不会伪装成真实模型结果。

第一次从虚拟机、飞书 Bot 和 DeepSeek API 开始部署，请直接阅读[从零部署教程](./docs/DEPLOYMENT_TUTORIAL.md)。

个人工作台位于 `http://localhost:3000`，普通文字和文档链接共用一个入口。控制中台位于 `http://localhost:3000/control`，提供模型路由与完整输入输出日志、插件库、Skill 编辑/评测/发布/回滚、持久化定时任务、每周 Memory 候选审批以及工具调用审计。API Key 只保存在环境变量中；数据库仅保存环境变量名称，运行日志会脱敏常见凭证字段。

在任意已启用群中，成员可以直接 `@Alex` 用自然语言创建任务，例如“每天晚上 9 点私聊我当天项目进度总结”或“每周五 18:00 在本群发送风险回顾”。任务按群和创建人隔离，服务器重启后仍会保留；创建、查询、暂停、恢复和删除均通过 `scheduled-task` Skill 的受控工具完成，并记录模型、工具与投递结果。

群聊上下文由两条链路合并：事件流持续保存 Bot 加入后的新消息；当用户询问历史、总结讨论、评价某人发言、手动同步或执行群定时任务时，Pulse 优先使用已授权飞书用户身份补采当前群最近的历史消息，权限不足时回退到群内 Bot 身份，并去重入库。默认读取最近 10 页（最多约 500 条），可用 `PULSE_GROUP_HISTORY_PAGE_LIMIT` 在 1–20 页之间调整；身份策略可用 `LARK_GROUP_HISTORY_IDENTITY=auto|user|bot` 控制。历史记录严格按 `chat_id` 隔离，不会跨群进入 Agent 上下文。

## 云端原型旧链路

Web 端与飞书 Bot 最终写入同一个 Sites 托管 D1 数据库，运行时绑定名为 `DB`。浏览器不会直接连接数据库，所有读写都经过 `/api/*` 服务端接口。

飞书同步链路：用户把 Wiki / Docx 链接发给 Bot → 飞书推送 `im.message.receive_v1` 到 `/api/integrations/feishu/events` → 服务端使用 `tenant_access_token` 解析 Wiki 节点并读取 Docx 纯文本 → 链接、正文、同步状态与消息来源写入 `assets.metadata_json` → 搜索和汇报读取同一份数据。事件 ID 会写入 `integration_events`，避免飞书重试造成重复同步。

汇报链路：`POST /api/reports` 聚合项目状态、Owner、进度、下一步、最近 20 条更新和最多 8 份已抽取文档。配置 `LLM_API_KEY` 后交给 OpenAI-compatible API 在事实约束下改写；没有密钥或模型暂时不可用时使用结构化模板降级。结果、引擎和证据数量会一起保存在 `reports`。

## 飞书连接配置

1. 在飞书开放平台创建企业自建应用并启用机器人。
2. 配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `FEISHU_VERIFICATION_TOKEN`。
3. 开通消息读取、知识库只读和 Docx 文档只读权限，并确保 Bot 对目标文档有访问权。
4. 订阅 `im.message.receive_v1`，请求地址使用资料页展示的 Webhook 地址。
5. 当前端点按非加密事件推送实现；如果开启 Encrypt Key，需要先增加事件解密。

本地开发可复制 `.dev.vars.example` 为 `.dev.vars`。生产环境在 Sites 项目的环境变量中配置相同键名，真实 Secret 不应提交到仓库。

## 信息架构

1. **同步台**：只呈现新增变化、阻塞、待确认事项；选中项目后在同屏展示 Owner、节奏、下一步和证据文档。
2. **项目矩阵**：沿用“核心工作 → 子项目 → Owner → 周节奏”的业务结构，支持跨周查看与状态扫描。
3. **统一搜索**：按项目、Owner、实验、指标、决策和文档正文检索，并生成跨来源整合答案。
4. **相关资料**：将项目进展、产品方案、实验文档、数据看板与项目实体关联，而不是作为孤立附件。
5. **智能汇报**：双日会简报、管理层周报、项目专项汇报和风险决策摘要。

## 系统架构

```text
飞书消息 / 文档 / 表格 / Web 管理端
                  │
          Ingestion Adapter
     事件验签 · 去重 · 身份映射 · 原文归档
                  │
              Event Queue
                  │
       Project Intelligence Service
 抽取更新 · 合并状态 · 风险识别 · 指标判断 · 节奏对齐
                  │
 Search Index + Skill Runtime + LLM Gateway
 标题/正文/实体索引 · 权限过滤 · 混合召回 · 答案引用
 模板版本 · 检索上下文 · 生成 · 评审 · 可观测
                  │
       API / Web Application Layer
                  │
       D1(SQLite) + Object Storage
```

建议生产环境将模型厂商封装在 LLM Gateway 后，Skill 只描述输入、输出、提示模板、质量标准和允许调用的工具。自适应更新采用“生成候选版本 → 离线评测 → 管理员确认 → 灰度发布”，不允许模型直接覆盖线上 Skill。

## 数据模型

核心表定义位于 `db/schema.ts`：

- `users`：账号、显示名、飞书 open_id、角色。
- `projects`：项目状态、健康度、进度、预期、负责人和配置。
- `project_updates`：原始同步内容、AI 摘要、进度变化、同步人。
- `metrics`：指标值、目标、单位、状态和观测时间。
- `risks`：风险等级、状态、负责人和截止日期。
- `assets`：项目/实验/看板链接及其创建人。
- `skill_definitions`：Skill 版本、提示模板、配置和生命周期。
- `reports`：报告类型、内容、生成范围、模型和生成人。
- `integrations`：飞书与其他外部连接的状态和安全引用。

生产版可继续增加 `project_members`、`milestones`、`skill_runs`、`skill_evaluations`、`audit_logs` 和 `webhook_events`。

## MVP 范围

本原型已经覆盖：

- 高级极简的响应式管理端与六个主模块。
- 项目组合、健康度、核心关注、风险、指标摘要。
- 四类汇报配置与服务端生成接口示例。
- Skill 管理、自适应建议的审核式交互。
- 人员归属、更新记录和资料链接管理界面。
- D1 持久化模型与可部署的 Cloudflare Worker 构建。

正式上线的下一阶段：

- 飞书应用发布、消息卡片、OAuth/租户安装与加密事件解密。
- 模型流式生成、引用跳转和质量评测。
- 完整 CRUD、行级权限、审计日志、加密密钥和对象存储。
- 后台任务队列、Webhook 幂等、失败重试、监控告警。
- 文档增量抓取、分块索引、向量与关键词混合检索、结果权限裁剪和答案引用。

## 仅启动前端开发模式

要求 Node.js 22.13+。

```bash
pnpm install
pnpm dev
```

访问 `http://localhost:3000`。部署构建使用：

```bash
pnpm build
```

## 部署与配置

项目使用 Sites / Cloudflare Worker 兼容结构，`.openai/hosting.json` 已声明 D1 绑定 `DB`。实际接入时在托管平台设置：

- `OPENAI_API_KEY` 或所选模型厂商密钥
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_ENCRYPT_KEY`

密钥只存托管平台 Secret，不写入源码。飞书事件回调应指向 `/api/integrations/feishu/events`，生产实现必须完成签名校验、事件去重、快速响应和异步处理。

## DeepSeek Harness Agent

项目管理 Agent 采用双层部署：Sites 站点负责 UI、身份与 D1 项目数据；`harness-service/` 是独立 DeepSeek Harness Runtime，负责持久会话、上下文压缩、模型步骤和未来的 MCP 项目工具。站点通过 `HARNESS_API_URL` 与 `HARNESS_SHARED_SECRET` 调用 Runtime。

没有连接 Runtime 时，Agent 页面仍可基于 D1 给出结构化摘要；配置 `LLM_API_KEY` 时也可使用一次性模型降级。只有 Runtime 连接成功后，界面才会显示“Harness 已连接”，不会把普通模型调用伪装成 Harness。

Runtime 使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 和 `DSH_MODEL`。模型名、网关地址与密钥必须来自同一服务商；不要把凭证写进仓库。当前 Runtime 为只读分析模式，项目写入和飞书发送应在后续通过 MCP 工具与 Harness 审批门禁开放。

## License

项目使用 [MIT License](./LICENSE)。第三方项目与架构参考的版权说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
