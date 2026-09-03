#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo bash deploy/linux/bootstrap.sh 运行" >&2
  exit 1
fi

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_user="${PULSE_RUN_USER:-${SUDO_USER:-}}"
if [[ -z "$run_user" || "$run_user" == "root" ]]; then
  echo "无法确定 Pulse 运行用户，请设置 PULSE_RUN_USER 后重试" >&2
  exit 1
fi

run_group="$(id -gn "$run_user")"
run_uid="$(id -u "$run_user")"
run_gid="$(id -g "$run_user")"
run_home="$(getent passwd "$run_user" | cut -d: -f6)"
node_bin="${PULSE_NODE_BIN:-$(command -v node || true)}"
pnpm_bin="${PULSE_PNPM_BIN:-$(command -v pnpm || true)}"
python_bin="${PULSE_PYTHON_BIN:-$(command -v python3 || true)}"

if [[ -z "$node_bin" ]]; then echo "缺少 Node.js 22.13+" >&2; exit 1; fi
node_major="$($node_bin -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then echo "Node.js 版本过低，需要 22.13+" >&2; exit 1; fi
if [[ -z "$pnpm_bin" ]]; then echo "缺少 pnpm" >&2; exit 1; fi
if [[ -z "$python_bin" ]]; then echo "缺少 Python 3" >&2; exit 1; fi
python_ok="$($python_bin -c 'import sys; print(1 if sys.version_info >= (3, 10) else 0)')"
if [[ "$python_ok" != "1" ]]; then echo "Python 版本过低，需要 3.10+" >&2; exit 1; fi

install -d -m 0750 -o "$run_user" -g "$run_group" /srv/pulse /srv/pulse/harness-sessions
install -d -m 0750 -o root -g "$run_group" /etc/pulse

if [[ ! -f /etc/pulse/pulse.env ]]; then
  sed "s|/home/REPLACE_USER|$run_home|g" "$app_dir/deploy/linux/pulse.env.example" >/etc/pulse/pulse.env
  chown root:"$run_group" /etc/pulse/pulse.env
  chmod 0640 /etc/pulse/pulse.env
  echo "已创建 /etc/pulse/pulse.env；请先填写真实密钥，再启动服务"
fi

if [[ ! -x "$app_dir/harness-service/.venv/bin/python" ]]; then
  sudo -u "$run_user" "$python_bin" -m venv "$app_dir/harness-service/.venv"
fi
sudo -u "$run_user" "$app_dir/harness-service/.venv/bin/python" -m pip install --disable-pip-version-check -r "$app_dir/harness-service/requirements.txt"
sudo -u "$run_user" env PATH="$(dirname "$node_bin"):$(dirname "$pnpm_bin"):/usr/local/bin:/usr/bin:/bin" "$pnpm_bin" install --frozen-lockfile
sudo -u "$run_user" env PATH="$(dirname "$node_bin"):$(dirname "$pnpm_bin"):/usr/local/bin:/usr/bin:/bin" "$pnpm_bin" build

sed \
  -e "s|__PULSE_UID__|$run_uid|g" \
  -e "s|__PULSE_GID__|$run_gid|g" \
  -e "s|__PULSE_HOME__|$run_home|g" \
  -e "s|__PULSE_APP_DIR__|$app_dir|g" \
  -e "s|__NODE_BIN__|$node_bin|g" \
  "$app_dir/deploy/linux/pulse.service.template" >/etc/systemd/system/pulse.service

systemctl daemon-reload
systemctl enable pulse.service
echo "基础环境和 systemd 服务已安装。完成 lark-cli 配置与 /etc/pulse/pulse.env 后运行：sudo systemctl start pulse"
