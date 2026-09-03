# Pulse DeepSeek Harness Runtime

独立部署的项目管理 Agent Runtime。Web 站点通过 `HARNESS_API_URL` 调用它；Harness 使用 JSONL 保存持久会话，并通过 DeepSeek adapter 驱动模型。

必需环境变量：

- `DEEPSEEK_API_KEY`：作为 Secret 注入，不写入镜像或配置文件。
- `DEEPSEEK_BASE_URL`：DeepSeek 官方为 `https://api.deepseek.com`；火山方舟 OpenAI-compatible 网关需按账号套餐选择对应地址。
- `DSH_MODEL`：必须与网关支持的模型 ID 一致。
- `HARNESS_SHARED_SECRET`：保护 Web 站点到 Runtime 的调用。

可选搜索能力：

- Harness 使用 Python 标准 HTTPS 客户端和锁定版本的 `lxml` 直接读取 Bing 搜索页；网络目标固定为 Bing，禁止搜索 SDK 静默回退到 Startpage、Brave 等未获准域名。
- 搜索端点 `/v1/tools/web-search` 与 Harness 共用 `HARNESS_SHARED_SECRET`，只监听生产机回环地址。
- 网页结果一律作为不可信外部证据返回；是否向模型暴露工具仍由 `PULSE_WEB_SEARCH_PROVIDER` 控制。

推荐为 `/data/sessions` 挂载持久卷。当前版本只读分析项目快照；写项目、发飞书消息等副作用应通过 Harness MCP 工具接入，并增加审批门禁。
