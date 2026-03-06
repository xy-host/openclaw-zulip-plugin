# OpenClaw Zulip Plugin

A custom [Zulip](https://zulip.com) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Features

- **DM & Stream messaging** — receive and reply to both direct messages and stream topics
- **Pairing-based DM policy** — DM access requires explicit approval
- **Auto-reply streams** — configurable streams that don't require @mention
- **Typing indicators** — shows typing status in both DMs and stream topics
- **Stream management** — create, update, delete, join/leave streams via agent tools
- **Mention detection** — responds to @mentions in any stream
- **Multi-bot conversation** — multiple bots can converse with loop prevention

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

## Multi-Bot Conversation

Multiple OpenClaw bot instances can converse with each other in the same stream/topic or DM. To enable:

```json
{
  "channels": {
    "zulip": {
      "multiBot": {
        "allowBotIds": [12345, 67890],
        "maxBotChainLength": 3,
        "botCooldownMs": 60000
      }
    }
  }
}
```

### Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `multiBot.allowBotIds` | `(string\|number)[]` | `[]` | Bot user IDs allowed to trigger this bot. Use `"*"` to allow all bots. |
| `multiBot.maxBotChainLength` | `number` | `3` | Max consecutive bot-to-bot replies per conversation before pausing. |
| `multiBot.botCooldownMs` | `number` | `60000` | Cooldown (ms) after chain limit is reached before allowing again. |

### How it works

1. **Allowed bot list** — Messages from bots whose user IDs are in `allowBotIds` are processed instead of being silently dropped.
2. **@mention override** — If any bot @mentions this bot, the message is processed regardless of `allowBotIds` (single response, no chain tracking).
3. **Loop prevention** — A per-conversation chain counter tracks consecutive bot-to-bot exchanges. After `maxBotChainLength` bot replies, further bot messages are dropped until:
   - A human sends a message in that conversation (resets the counter), or
   - The `botCooldownMs` cooldown period elapses.
4. **DM bypass** — Allowed bots bypass DM pairing/policy checks.

### Example: Two bots discussing in a stream

- Bot A sends a message in `#experiment > discussion`
- Bot B (with `allowBotIds: [botA_id]`) receives and responds
- Bot A (with `allowBotIds: [botB_id]`) receives and responds
- After 3 exchanges (default), further bot messages are dropped for 60s

## Agent Tools

All agent tools accept an optional `accountId` parameter to target a specific Zulip account in multi-account setups.


| Tool | Description |
|------|-------------|
| `zulip_streams` | List, create, join, leave, update, delete streams; list topics and members |
| `zulip_send` | Send messages to streams (with topic) or DMs |
| `zulip_users` | List users, look up by ID or email, check presence status |
| `zulip_messages` | Search/fetch messages, edit/delete bot messages, add/remove emoji reactions |
| `zulip_scheduled_messages` | Create, list, edit, or delete scheduled messages for future delivery |
| `zulip_user_groups` | List, create, update, delete user groups and manage group members |
| `zulip_custom_emoji` | List, upload, or deactivate custom emoji in the organization |
| `zulip_drafts` | List, create, edit, or delete message drafts for later review |
| `zulip_upload` | Upload files to Zulip server and get shareable URIs for use in messages |
| `zulip_topics` | Resolve/unresolve, rename, move, or delete topics within streams |
| `zulip_linkifiers` | List, add, update, remove, or reorder auto-linking patterns (linkifiers) |
| `zulip_user_status` | Get or update user status (text and emoji) shown next to user names |
| `zulip_server_settings` | Query server info, list custom profile fields, get user profile data |
| `zulip_message_flags` | Star/unstar messages, mark read/unread, check read receipts |
| `zulip_alert_words` | List, add, or remove alert words that trigger notifications on keyword matches |

## Configuration

| Key | Type | Description |
|-----|------|-------------|
| `serverUrl` | string | Zulip server URL |
| `botEmail` | string | Bot email address |
| `apiKey` | string | Bot API key |
| `dmPolicy` | string | `"pairing"` \| `"open"` \| `"disabled"` |
| `autoReplyStreams` | string[] | Streams where bot auto-replies without @mention |
| `multiBot` | object | Multi-bot conversation settings (see above) |

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
