# OpenClaw channel setup

OpenClaw is the communication edge only. Pulse remains the business agent and DeepSeek Harness remains the reasoning runtime.

1. Copy `openclaw.json.example` to `state/openclaw.json`.
2. Set `PULSE_CHANNEL_DRIVER=openclaw` and configure `OPENCLAW_BRIDGE_SECRET` in `.env.local-agent`.
3. Start the OpenClaw profile with Docker Compose.
4. Run the OpenClaw Feishu channel login wizard in the container and restart the gateway.
5. Keep port `18789` bound to loopback. The Pulse bridge calls `gateway:8789` over the private Compose network.

The `pulse-bridge` plugin claims Feishu user turns through OpenClaw's typed `before_agent_reply` hook, sends the normalized sender/chat/session context to Pulse, and returns Pulse's final answer to OpenClaw for delivery. Native Feishu mode remains available as a rollback path.
