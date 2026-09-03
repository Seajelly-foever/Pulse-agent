# Pulse Linux 云主机部署

这套部署用于 Linux 虚拟机。代码、密钥和业务数据彼此分离：源码位于部署目录，密钥只位于 `/etc/pulse/pulse.env`，SQLite 与 Harness 会话位于 `/srv/pulse`。`pulse.service` 由 systemd 保持运行，退出 IDE 或服务器重启后会自动恢复。

## 服务器要求

- Linux x86_64
- Node.js 22.13 或更高版本
- pnpm 11
- Python 3 和 `venv`
- curl、git
- lark-cli（使用飞书 CLI Channel 时）
- 当前用户拥有 sudo 权限

## 首次安装

把源码解压到服务器，例如 `$HOME/pulse`，进入目录后执行：

```bash
sudo PULSE_RUN_USER="$USER" bash deploy/linux/bootstrap.sh
```

如果系统 Python 低于 3.10，可先在当前用户目录安装 Python 3.12，并显式把路径传给安装器；不要替换系统 `/usr/bin/python3`：

```bash
sudo PULSE_RUN_USER="$USER" \
  PULSE_PYTHON_BIN="$HOME/.local/bin/python3.12" \
  PULSE_PNPM_BIN="$HOME/.local/bin/pnpm" \
  bash deploy/linux/bootstrap.sh
```

安装器会创建 `/etc/pulse/pulse.env`，但不会代填或打印真实密钥。使用服务器编辑器填写该文件后，将飞书 CLI 安装到当前用户的 `$HOME/.local/bin/lark-cli`，完成应用配置和用户授权。

配置完成后启动：

```bash
sudo systemctl start pulse
sudo systemctl status pulse --no-pager
bash deploy/linux/healthcheck.sh
```

日志查看：

```bash
sudo journalctl -u pulse -f
```

停止和重启：

```bash
sudo systemctl stop pulse
sudo systemctl restart pulse
```

Web 默认监听 `0.0.0.0:3000`；Gateway 和 Harness 只监听 `127.0.0.1`，不应直接对外开放。公司内网访问前需要在安全组或主机防火墙中仅向可信网段开放 TCP 3000，正式使用时应接入公司 HTTPS 网关。

## 启用公开网页搜索

Pulse 的搜索能力是受审计工具，不是 Harness 的隐式联网。Root Agent 只有在 Provider 已配置且 `web-access` 插件启用时，才能在 ReAct 循环中调用 `web_search`；调用输入、返回结果、耗时与错误都会进入 `tool_runs`。

当前公司网络可访问 Bing 和 PyPI，但无法访问 DuckDuckGo、Startpage、Brave、GitHub 源码和 Docker Hub。生产机因此使用 Harness 内置的严格 Bing Provider：Python 标准 HTTPS 客户端只访问 Bing，`lxml` 负责解析结果，不允许跨搜索引擎回退。代码更新后先同步 Python 依赖：

```bash
cd "$HOME/pulse"
harness-service/.venv/bin/python -m pip install --disable-pip-version-check -r harness-service/requirements.txt
```

编辑 `/etc/pulse/pulse.env`，确认以下配置存在且没有重复定义：

```dotenv
PULSE_WEB_SEARCH_PROVIDER=bing
PULSE_BING_SEARCH_URL=http://127.0.0.1:8090/v1/tools/web-search
PULSE_BING_REGION=cn-zh
PULSE_WEB_FETCH_ENABLED=true
PULSE_WEB_TOOL_TIMEOUT_MS=15000
```

重启并先检查运行时声明。`web_search_available`、`webAccess.search` 与 `webAccess.fetch` 必须都为 `true`，`web_search_backends` 必须只包含 `bing`，Provider 必须为 `bing`：

```bash
sudo systemctl restart pulse
curl -fsS http://127.0.0.1:8090/health
curl -fsS http://127.0.0.1:8789/health
```

最后执行一次真实搜索。命令只在服务器内部读取共享密钥，不会把密钥写入仓库或命令历史：

```bash
sudo bash -lc '
set -a
. /etc/pulse/pulse.env
set +a
curl -fsS \
  -H "Authorization: Bearer $HARNESS_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  --data '"'"'{"query":"DeepSeek Harness","count":3,"region":"cn-zh","backend":"bing"}'"'"' \
  http://127.0.0.1:8090/v1/tools/web-search
'
```

返回 JSON 中应包含 `provider: "bing"`、`backend: "bing"`，并且 `results` 至少有一条。然后在飞书中向 Alex 发送“搜索 DeepSeek Harness 最新信息并给出来源链接”，管理后台本轮日志应出现 `web_search` 的完整输入与结果；只有这一层也成功，才能判定 Agent 搜索已启用。

## 数据迁移

第一次验证建议使用空数据库。需要迁移本地数据时，先停止本地和云端 Pulse，再把 `local-runtime/data/pulse.db` 复制为 `/srv/pulse/pulse.db`，并把 `harness-service/data/sessions` 复制为 `/srv/pulse/harness-sessions`。迁移前后都要保留备份，避免两个实例同时消费同一个飞书事件流。
