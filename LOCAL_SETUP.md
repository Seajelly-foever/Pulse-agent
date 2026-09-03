# Pulse 本地 Personal Agent：飞书、OpenClaw 与 Harness

本地版由 Web、Pulse Gateway、DeepSeek Harness 与飞书 CLI Channel Adapter 组成。`lark-cli` 负责保持消息事件流、读取飞书文档并完成 Bot 回复；Pulse 负责授权、幂等、排队、业务编排与落库，Harness 负责模型推理。SQLite 默认保存在 `local-runtime/data/pulse.db`，因此重启不会丢失项目、资料、消息、记忆、Skill 或审计日志。

## 1. 配置飞书自建应用

在[飞书开放平台](https://open.feishu.cn/app)创建“企业自建应用”，开启“机器人”能力。在“权限管理”至少申请并发布以下权限：读取用户发给机器人的消息、以机器人身份发送消息、读取知识库节点、读取新版文档正文。控制台对应的常见权限标识为 `im:message`、`im:message:readonly`、`im:message:send_as_bot`、`wiki:wiki:readonly`、`docx:document:readonly`；如目标文档受云空间权限控制，还需按控制台提示补充只读 Drive 权限。

在“事件与回调”中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。长连接模式不需要公网回调地址，适合本地运行。随后创建并发布应用版本，确保你的飞书账号位于应用可用范围内。

从“凭证与基础信息”复制 App ID 和 App Secret。请只把它们写进本机环境文件，不能放进前端、Git 或聊天消息。已经在聊天中出现过的模型密钥应先到提供方后台撤销并重新生成。

## 2. 启动飞书 CLI Agent

```bash
cp .env.local-agent.example .env.local-agent
# 编辑 .env.local-agent，填入新生成的飞书与模型凭证
npm run local:up
```

启动完成后打开 <http://localhost:3000>。健康检查位于 <http://127.0.0.1:8789/health>，Harness 位于 <http://127.0.0.1:8090/health>。

默认配置就是：

```bash
PULSE_CHANNEL_DRIVER=lark-cli
LARK_CLI_BIN=lark-cli
LARK_DOC_IDENTITY=auto
```

CLI 使用已有的应用配置和 Bot 身份，不需要用户 OAuth。启动前可执行 `lark-cli config show` 与 `lark-cli event status --json`；飞书开放平台仍需发布应用、启用长连接并订阅 `im.message.receive_v1`。CLI Adapter 会等待标准 ready marker，再读取 stdout 的 NDJSON；异常退出后指数退避重启。接收事件和回复都使用消息 ID 做幂等控制。文档读取通过 `lark-cli docs +fetch --as bot` 完成，因此目标 Wiki / Docx 必须对 Bot 可见。

`npm run local:up` 会在本机同时启动 Harness、Gateway、Web 和 CLI 消息监听。这里不能把 Gateway 放进普通 Docker 容器，因为容器默认无法直接复用 macOS 上的 CLI 凭证与事件总线；Docker Compose 只保留给后续把通信边缘独立部署的场景。

若需要在关闭终端或结束 Codex 对话后继续接收飞书消息，以后台守护方式启动 Pulse：

```bash
pnpm local:daemon:start
pnpm local:daemon:status
```

启动命令会立即返回，服务继续在后台运行，日志位于 `local-runtime/data/pulse-service.log`。需要完全停止时执行 `pnpm local:daemon:stop`。电脑重启后需要重新执行一次启动命令。

## 3. 将自己的飞书账号与本地空间绑定

在飞书中私聊 Bot，发送 `/whoami` 可查看当前 open_id 和授权状态。首次发送普通消息时，Bot 会返回六位配对码。在项目目录执行：

```bash
npm run local:pair -- 123456
```

配对命令直接操作本地 SQLite，不依赖 Docker。

配对完成后，再把项目文档链接发给 Bot。Gateway 会先保存原始事件并去重，再读取飞书文档正文、建立或匹配项目、提炼核心进展和 Todo、调用 Harness，最后把结果回复到同一个飞书会话。发送 `/status` 查看本地数据状态，发送 `/weekly` 生成当前周报。

普通消息会进入个人收件箱并由 Agent 分析；发送 `记住：内容` 会创建长期记忆候选；发送 `/memory-review` 会立即运行一次每周记忆审阅。候选需要在 <http://localhost:3000/control> 确认后才会进入后续 Agent 上下文。

项目管理现在是独立的 `project-management` Skill。只有模型识别到“创建、更新、同步或整理项目与 Todo”的明确意图时，才进入 `project-manager` 角色，并通过受权限约束的 `sync_project` 工具落库；普通解释和写作仍由通用 Agent 直接处理。控制台的模型日志会按一轮任务拆分展示模型输入、路由与角色、注入记忆/画像、ReAct 观察轨迹、工具输入与工具返回，以及最终模型输出。

管理后台的“系统提示词”页面控制 Agent 的稳定角色、人设、工作方法和行为边界。编辑内容先保存为草稿，人工发布后下一次模型请求即时生效；Gateway 会把已发布版本作为 DeepSeek Harness 的真实 system prompt 传入，同时在 Run Context 中记录版本和正文，便于审计。具体任务流程仍由 Skill 管理，不应把周报、项目整理等细节全部堆进系统提示词。

任务后 Dreaming 与定时 Skill 自进化默认关闭，因为它们会把任务输入输出或历史 Run 证据再次发送给当前模型服务。完成数据范围确认后，可在 `.env.local-agent` 中分别设置 `POST_TASK_DREAMING_ENABLED=true` 与 `SKILL_EVOLUTION_ENABLED=true`；Dreaming 还需要在 Skill 中台手动启用 `post-task-dreaming`。两者都只生成候选，记忆、用户画像和 Skill 版本仍需在管理后台人工发布。

已审计的 DeepSeek Harness 社区插件通过以下命令按锁定提交下载：

```bash
pnpm local:plugins:sync
```

版本锁位于 `integrations/dsh-community/plugins.lock.json`。这些插件会出现在插件中台，但默认停用；当前 Pulse 的 Harness SDK 版本、额外模型权限或现有 Memory 去重策略未验证通过前，不应直接启用。

## 4. 无飞书账号时验证完整业务链路

本地模拟接口与真实飞书事件走同一套 Gateway 逻辑：

```bash
curl -X POST http://127.0.0.1:8789/v1/simulate \
  -H 'Authorization: Bearer change-this-to-a-long-random-string' \
  -H 'Content-Type: application/json' \
  -d '{"senderId":"local-owner","text":"/status"}'
```

首次模拟同样会返回配对码；完成配对后即可发送文本或飞书文档链接。这能验证“消息进入 → 授权 → 落库 → Agent → 回复”的闭环，而不依赖飞书后台是否已经审核完权限。

## 5. 可选：切换到 OpenClaw 通信层

如果公司环境禁用 OpenClaw，完全跳过本节。只有允许使用时，才把 `openclaw/openclaw.json.example` 复制为 `openclaw/state/openclaw.json`，将 `PULSE_CHANNEL_DRIVER` 改为 `openclaw`，并为两个 Token 设置不同的长随机值。

```bash
docker compose -f docker-compose.local.yml --env-file .env.local-agent --profile openclaw up --build
```

按照 OpenClaw 官方流程在容器内执行 `openclaw channels login --channel feishu`，选择手动设置并输入飞书 App ID / App Secret；配置写入 `openclaw/state`，不会提交 Git。Bridge 插件通过 `before_agent_reply` 接管飞书用户消息，把标准化事件发送到 Pulse 内网端点，再将 Pulse 的最终结果交回 OpenClaw 投递。`18789` 只绑定本机，不应直接暴露公网。

验证时依次检查 `openclaw gateway status`、`openclaw logs --follow`、Pulse 的 `/health` 和控制中台工具日志。需要回滚时只把 `PULSE_CHANNEL_DRIVER` 改回 `native-feishu` 并不启动 OpenClaw profile，数据库无需迁移。

## 6. 数据位置与后续迁移云端

本机模式的 SQLite 由 `PULSE_DATABASE_PATH` 指定，默认是 `local-runtime/data/pulse.db`；Harness 会话保存在 `harness-service/data/sessions`。`openclaw/state` 仅为历史兼容层并已被 Git 忽略。

云端不需要改产品逻辑，只需把 Gateway、Web 和 Harness 部署为长期运行的容器，并把 SQLite 替换为托管 PostgreSQL。飞书仍使用 WebSocket 长连接；如果部署平台不允许长期连接，再切换为带签名校验的 Webhook。密钥应迁入云密钥管理服务，Gateway 仅开放内部 API，Web 通过服务网络访问它。
