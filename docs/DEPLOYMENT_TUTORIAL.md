# Pulse 从零部署教程

这份教程面向第一次部署 Pulse 的使用者，目标是在一台 Linux 虚拟机上完成以下闭环：

```text
飞书用户 @Bot
      ↓
lark-cli 长连接接收消息
      ↓
Pulse Gateway → Agent / Skill / Tool → DeepSeek Harness
      ↓
SQLite 持久化 → 飞书回复 + Web 管理后台
```

真实密钥、飞书授权令牌、聊天记录、数据库和模型会话均不应提交到 GitHub。开始部署前，请先确认组织允许将相关代码、数据和第三方模型服务用于目标场景。

## 1. 准备账号与资源

需要准备：

- 一台 Linux 虚拟机。推荐 Ubuntu 24.04 LTS，测试环境至少 2 vCPU / 4 GB 内存；正式规格应根据并发、文档长度和模型调用量压测后决定。
- 一个可管理的域名，用于正式 HTTPS 访问。DigitalOcean 提供 DNS 管理，但不负责注册域名。
- 一个飞书企业自建应用和机器人。
- 一个 DeepSeek Platform 账号、可用余额和 API Key。
- 一个用于存放 Pulse 的 Git 仓库。

参考入口：

- [DigitalOcean 创建 Droplet](https://docs.digitalocean.com/products/droplets/how-to/create/)
- [DigitalOcean 生产级 Droplet 建议](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)
- [飞书开放平台](https://open.feishu.cn/app)
- [lark-cli 官方 npm 包](https://www.npmjs.com/package/@larksuite/cli)
- [DeepSeek Platform](https://platform.deepseek.com/)
- [DeepSeek API 文档](https://api-docs.deepseek.com/)

## 2. 创建并连接 Linux 虚拟机

在 DigitalOcean 创建 Droplet 时选择 Ubuntu 24.04、离主要用户较近的区域，并使用 SSH Key 登录。不要把私钥上传到服务器、GitHub 或聊天工具。

本机尚无 SSH Key 时执行：

```bash
ssh-keygen -t ed25519 -C "pulse-deployment"
```

把生成的 `.pub` 公钥添加到 DigitalOcean，创建 Droplet 后连接：

```bash
ssh root@YOUR_DROPLET_IP
```

参考：[DigitalOcean SSH 连接说明](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/)。生产环境建议创建独立的非 root 用户、关闭 root 密码登录，并通过 Cloud Firewall 只开放必要端口。

## 3. 安装基础运行环境

Pulse 需要 Node.js 22.13+、pnpm 11、Python 3.10+、Git、curl 和 Python venv。先检查现有版本：

```bash
node --version
npm --version
python3 --version
git --version
curl --version
```

Node.js 和 Python 的安装方式随 Linux 发行版而异。安装完成后启用项目声明的 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm --version
```

## 4. 下载并构建 Pulse

下载 Pulse 开源仓库：

```bash
git clone https://github.com/Seajelly-foever/Pulse-agent.git pulse
cd pulse
pnpm install --frozen-lockfile

python3 -m venv harness-service/.venv
harness-service/.venv/bin/python -m pip install \
  --disable-pip-version-check \
  -r harness-service/requirements.txt

CI=true pnpm test
```

只有构建和测试全部通过后再配置生产服务。

## 5. 申请飞书 Bot

1. 进入[飞书开放平台](https://open.feishu.cn/app)，创建企业自建应用。
2. 在应用能力中启用“机器人”，设置名称和头像。
3. 在权限管理中按实际用途申请最小权限。Pulse 的基础链路通常需要接收消息、以机器人身份回复消息、读取新版文档和知识库节点；需要补采历史群消息时再增加对应只读权限。
4. 在“事件与回调”中选择长连接接收事件，并订阅 `im.message.receive_v1`。
5. 创建应用版本、发布，并把测试用户或目标组织加入应用可用范围。
6. 从“凭证与基础信息”取得 App ID 和 App Secret。App Secret 只写入服务器 Secret 文件。

权限名称和审核规则会随飞书开放平台调整，应以应用控制台当前显示为准。不要为了省事直接申请全量权限。

## 6. 安装并授权飞书 CLI

Pulse 使用官方 `@larksuite/cli` 维护飞书长连接和用户授权。安装：

```bash
npx @larksuite/cli@latest install
lark-cli --version
```

首次配置应用：

```bash
lark-cli config init --new
```

命令会输出浏览器验证地址。打开地址并完成应用配置后，再为文档、群聊历史等用户身份能力授权：

```bash
lark-cli auth login --recommend
lark-cli auth status --json --verify
```

官方安装、授权和命令说明见 [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli)。机器人身份负责接收和回复；只有需要访问用户本人可见的文档或历史记录时，才使用用户授权。多人使用时必须进行账号隔离、权限校验和审计，不能让所有成员共享一个不受限制的用户身份。

## 7. 申请 DeepSeek API

1. 登录 [DeepSeek Platform](https://platform.deepseek.com/)。
2. 完成账号设置和充值。
3. 在 API Keys 页面创建新的 API Key，并在创建时立即安全保存。
4. 不要把 API Key 写入源代码、README、截图、Git commit 或前端环境变量。

Pulse 使用 OpenAI-compatible API 地址：

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY
DSH_MODEL=deepseek-v4-flash
```

模型名称可能更新，应以 [DeepSeek API 文档](https://api-docs.deepseek.com/)当前列出的可用模型为准。

## 8. 配置 Pulse Secret

先执行安装脚本：

```bash
sudo PULSE_RUN_USER="$USER" bash deploy/linux/bootstrap.sh
```

如果服务器使用用户目录中的 Python 或 pnpm，可显式传入路径：

```bash
sudo PULSE_RUN_USER="$USER" \
  PULSE_PYTHON_BIN="$HOME/.local/bin/python3.12" \
  PULSE_PNPM_BIN="$HOME/.local/bin/pnpm" \
  bash deploy/linux/bootstrap.sh
```

然后编辑 `/etc/pulse/pulse.env`。至少确认以下值已经替换，且没有重复定义：

```dotenv
PULSE_RUN_USER=YOUR_LINUX_USER
LARK_CLI_BIN=/home/YOUR_LINUX_USER/.local/bin/lark-cli
FEISHU_APP_ID=YOUR_FEISHU_APP_ID
FEISHU_APP_SECRET=YOUR_FEISHU_APP_SECRET
DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY
HARNESS_SHARED_SECRET=GENERATE_A_LONG_RANDOM_SECRET
LOCAL_GATEWAY_SECRET=GENERATE_ANOTHER_LONG_RANDOM_SECRET
```

可以用以下命令生成随机值：

```bash
openssl rand -hex 32
```

确保 Secret 文件只能由 root 和服务进程需要的用户读取，不要复制回项目目录。

## 9. 启动与验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pulse
sudo systemctl status pulse --no-pager -l
bash deploy/linux/healthcheck.sh
```

健康检查必须依次显示：

```text
harness: ok
gateway: ok
web: ok
Pulse healthcheck: ok
```

继续检查日志：

```bash
sudo journalctl -u pulse -n 100 --no-pager
```

最后在飞书私聊 Bot 发送 `/whoami` 或普通消息，完成账号配对，再测试：

- 普通问答是否进入 Root Agent Loop；
- 文档链接是否被读取并保留来源；
- 项目指令是否调用项目 Skill 和受控工具；
- “优化 weekly-report Skill”是否只生成草稿而不自动发布；
- 管理后台是否能看到路由、上下文、工具输入输出和最终回答。

## 10. 启用 Skill 自进化

Skill 自进化默认关闭。启用前必须确认：运行日志和指定材料可以发送到当前模型服务，并且管理后台只允许可信管理员发布候选。

编辑 `/etc/pulse/pulse.env`：

```dotenv
SKILL_EVOLUTION_ENABLED=true
SKILL_EVOLUTION_DAY=0
SKILL_EVOLUTION_HOUR=21
SKILL_EVOLUTION_MIN_RUNS=5
```

重启服务：

```bash
sudo systemctl restart pulse
bash deploy/linux/healthcheck.sh
```

其工作边界是：

```text
真实运行证据 / 用户指定材料
              ↓
       Skill Curator 分析
              ↓
       生成候选 + 规则评测
              ↓
          管理后台草稿箱
              ↓
         管理员审核并发布
```

模型不能直接发布、覆盖生产 Skill、修改插件配置或扩大工具权限。

## 11. 配置域名与 HTTPS

域名需要从独立注册商购买，再把 DNS `A` 记录指向 Droplet 公网 IP。建议使用：

```text
agent.example.com   → 用户工作台
admin.example.com   → 管理后台
api.example.com     → 外部回调与 API
```

使用 Caddy 或 Nginx 反向代理 Web 服务并签发 HTTPS 证书。Gateway 和 Harness 端口应继续只监听 `127.0.0.1`；管理后台必须有登录鉴权，不能裸露在公网。

## 12. 后续更新

每次更新遵循同一流程：

```bash
cd "$HOME/pulse"
git status --short
git pull --ff-only
pnpm install --frozen-lockfile
harness-service/.venv/bin/python -m pip install \
  --disable-pip-version-check \
  -r harness-service/requirements.txt
CI=true pnpm test
sudo systemctl restart pulse
bash deploy/linux/healthcheck.sh
```

如果 `git status --short` 显示服务器上存在未提交修改，应停止更新并先确认来源，避免覆盖生产机上的临时改动。数据库和 Secret 不跟随 Git 更新，应单独备份和管理。
