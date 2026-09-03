# Pulse Personal Agent 架构

## 1. 核心判断

Pulse 不再是“带聊天框的项目看板”，而是一套个人管理 Agent Runtime。项目管理仍然是第一业务模块，但消息、资料、任务、人物上下文、长期记忆和未来新增模块共享同一套接入、推理、工具、权限和审计基础设施。

系统采用五层解耦：飞书 Channel Adapter 只处理连接、消息标准化和回复投递，当前支持官方 SDK 与 `lark-cli`，OpenClaw 仅作可选兼容；Pulse Gateway 负责身份、幂等、排队、业务编排和权限边界；DeepSeek Harness 是唯一模型推理循环；Tool Runtime 提供稳定的业务工具协议；SQLite 保存事实、事件、记忆、Skill 版本和全部审计记录。任何一层都可以独立替换，不需要改写其他层的业务逻辑。

```text
飞书私聊 / Web 输入
        │
        ▼
Feishu Channel Adapter ─ lark-cli（默认唯一启用）/ 官方 SDK 与 OpenClaw（回滚）
        │  标准化事件 + Bridge Secret
        ▼
Pulse Gateway ────────── 身份配对、幂等、串行队列、业务路由
        │
        ├── Personal Orchestrator ─ 项目 / 资料 / 行动 / 搜索 / 汇报
        │          │
        │          ▼
        │    DeepSeek Harness ──── 会话、上下文、推理循环
        │          │
        │          ▼
        │    Pulse Tool Runtime ── 权限白名单、候选写入、调用审计
        │
        ├── Skill Registry ─────── Claude-compatible SKILL.md、评测、发布、回滚
        ├── Hermes Memory ──────── Session / USER.md / MEMORY.md / Monthly Curator
        └── Project Knowledge ──── 需求 / 进展 / Todo / 人物 / 群聊 / 文档
                          │
                          ▼
                    SQLite Fact Store
```

## 2. 关键运行契约

通信层不能直接决定项目状态，也不能调用业务数据库。当前 `PULSE_CHANNEL_DRIVER=lark-cli`：CLI 的 NDJSON 事件流只负责把标准化消息交给 Pulse，文档由 `docs +fetch` 读取，Pulse 返回最终文本后再由 CLI 回复。官方 SDK 与 OpenClaw 仅保留为显式回滚路径，不能和 CLI 同时消费同一个 Bot。项目、记忆和 Skill 不依赖通道实现。

DeepSeek Harness 不直接获得任意数据库或系统权限。模型只能从 Tool Runtime 暴露的工具目录中选择动作。当前个人 Agent 可检索工作区、读取已发布记忆、查看工作空间、写入收件箱和创建记忆候选；Skill Curator 与 Memory Curator 使用更窄的独立权限集合。每次调用记录工具名、Agent 角色、权限级别、输入、结果、耗时与错误。

写操作分为“事实写入”和“候选写入”。消息、原始文档、项目更新属于事实写入，需要保留来源；长期记忆和 Skill 变更只能先生成候选。候选不会进入生产检索上下文，只有用户在控制中台确认发布后才生效。

## 3. Hermes Memory 与项目知识模型

Pulse 直接采用 Hermes 的记忆运行契约，并在现有 Node Gateway 与 SQLite 中实现：每个飞书群聊或私聊对应一个确定性 Session；会话启动时冻结生产系统提示词、`USER.md` 与 `MEMORY.md`；近期消息自动进入当前会话上下文；较早或跨会话记录由 SQLite FTS5 驱动的 `session_search` 显式召回。模型不能自由改写冻结快照，也不能把普通对话自动提升为长期记忆。

长期用户记忆只接收当前用户跨任务稳定的 `preference`、已确认 `fact` 和长期 `goal`（包括明确 OKR）。每月 1 日 20:00，Memory Curator 读取真实 Session 证据与既有已发布记忆，生成候选；候选经人工确认后才进入下一周期的 `USER.md` / `MEMORY.md`。项目进展、人物评价、群聊发言、文档正文、临时 Todo 和一次性事件不进入长期记忆。

项目知识库与 Memory 完全独立。项目需求、子需求、进展、Todo、负责人、相关人物、群聊证据及飞书文档链接进入 `project_knowledge_items`，并由独立 FTS5 索引管理。生成周报时，Report Writer 必须逐项目调用 `project_knowledge_recall`，以项目为边界召回证据；长期用户记忆不能替代项目事实。旧项目型 Memory 在数据库初始化时迁移到项目知识库并退出长期上下文。

## 4. Skill 模型

Skill 使用 Claude Agent Skill 兼容的 YAML Frontmatter 和 Markdown 正文，至少包含 `name`、`description`、目标、执行规则与验证方式。数据库保留完整版本、评测结果、来源和生命周期。Skill Curator 只能读取真实运行日志与当前生产版本，输出候选；70 分以上仅表示通过基础门禁，不代表自动发布。管理员可以审批、拒绝或回滚。

插件与 Skill 严格分库。插件负责外部连接、模型运行时、工具运行时和存储；Skill 负责可编辑的业务做法。项目整理、Todo 提炼、周报、搜索、个人输入整理和月度记忆审阅都是 Skill，不应该写进通信插件。

## 5. 数据归属与未来扩展

当前本地版以单个个人空间运行，SQLite 文件由 `PULSE_DATABASE_PATH` 指定；Docker 默认位于 `pulse_data` volume。表中已经保留 `workspace_id`、身份和会话边界，因此迁移云端时可以将 SQLite 换为 PostgreSQL，并在所有查询上增加租户过滤，而不改变前端和 Agent 契约。

新增日程、邮件、健康、财务或知识管理模块时，应新增领域表、受控工具和对应 Skill，而不是继续扩大项目表。个人工作台只呈现统一输入、今日关注和模块摘要；完整配置、模型、Memory、Skill、插件及审计仍留在 `/control`。
