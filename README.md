# OpenClaw Zulip Plugin

A custom [Zulip](https://zulip.com) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Features

- **DM & Stream messaging** — receive and reply to both direct messages and stream topics
- **Pairing-based DM policy** — DM access requires explicit approval
- **Auto-reply streams** — configurable streams that don't require @mention
- **Typing indicators** — shows typing status in both DMs and stream topics
- **Stream management** — create, update, delete, join/leave streams via agent tools
- **Mention detection** — responds to @mentions in any stream

## Installation

1. Copy the plugin to `~/.openclaw/extensions/zulip/`
2. Add Zulip configuration to `openclaw.json`:

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "serverUrl": "https://your-org.zulipchat.com",
      "botEmail": "your-bot@your-org.zulipchat.com",
      "apiKey": "your-bot-api-key",
      "dmPolicy": "pairing",
      "autoReplyStreams": ["general"]
    }
  },
  "plugins": {
    "entries": {
      "zulip": { "enabled": true }
    }
  }
}
```

3. Restart OpenClaw gateway

## Agent Tools

| Tool | Description |
|------|-------------|
| `zulip_streams` | List, create, join, leave, update, delete streams; list topics and members |
| `zulip_send` | Send messages to streams (with topic) or DMs |

## Configuration

| Key | Type | Description |
|-----|------|-------------|
| `serverUrl` | string | Zulip server URL |
| `botEmail` | string | Bot email address |
| `apiKey` | string | Bot API key |
| `dmPolicy` | string | `"pairing"` \| `"open"` \| `"disabled"` |
| `autoReplyStreams` | string[] | Streams where bot auto-replies without @mention |

## Architecture

```
├── openclaw.plugin.json   # Plugin manifest
├── index.ts               # Entry point & tool registration
└── src/
    ├── channel.ts         # ChannelPlugin interface implementation
    ├── runtime.ts         # Runtime environment accessor
    └── zulip/
        ├── accounts.ts    # Account resolution & config merging
        ├── client.ts      # Zulip REST API client
        ├── monitor.ts     # Event queue polling & message handling
        └── send.ts        # Message sending logic
```

## License

MIT
