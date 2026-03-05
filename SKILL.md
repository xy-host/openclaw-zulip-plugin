---
name: zulip
description: "Interact with Zulip messaging. Use when: sending messages to Zulip streams/DMs, managing streams, looking up users, searching/editing messages, or responding in Zulip channels. Covers formatting, topic conventions, and tool usage."
metadata: { "openclaw": { "emoji": "💬" } }
---

# Zulip Skill

Guide for interacting with Zulip via the openclaw-zulip-plugin tools.

## Tools

Seven tools are available. All tools accept an optional `accountId` parameter for multi-account setups:

### `zulip_send`
Send a message to a stream or DM.

- **Stream message**: provide `streamName`, `topic`, and `content`
- **DM**: provide `userId` and `content`
- `content` must not be empty
- If `topic` is omitted for stream messages, it defaults to "(no topic)" — always provide a topic

### `zulip_streams`
Manage streams. Actions:

| Action | Required params |
|---|---|
| `list_all` | — |
| `list_subscribed` | — |
| `create` / `join` | `name` |
| `leave` | `name` |
| `update` | `streamId` (+ `description`/`newName`/`isPrivate`) |
| `delete` | `streamId` |
| `topics` | `streamId` |
| `members` | `streamId` |

**Note**: `create` and `join` use the same action — subscribing to a non-existent stream creates it.

### `zulip_users`
Look up and manage users. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all users (use `includeBots`/`includeDeactivated` to filter) |
| `get` | `userId` | Get a single user's details by ID |
| `get_by_email` | `email` | Get a single user's details by email |
| `presence` | `userId` | Check a user's online/idle/offline status |

**Tips**:
- Use `list` to find user IDs when you need to send a DM
- Use `get_by_email` when you know someone's email but not their Zulip ID
- The `presence` action shows per-client status (web, desktop, mobile) with last-seen timestamps
- By default, `list` excludes bots and deactivated users — set `includeBots: true` or `includeDeactivated: true` to include them

### `zulip_messages`
Search, fetch, edit, delete messages and manage emoji reactions. Actions:

| Action | Required params | Description |
|---|---|---|
| `get` | `messageId` | Fetch a single message by ID with full details |
| `search` | (see filters below) | Search/retrieve messages with optional filters |
| `edit` | `messageId` + `content` and/or `newTopic` | Edit a message the bot sent |
| `delete` | `messageId` | Delete a message the bot sent |
| `add_reaction` | `messageId`, `emojiName` | Add an emoji reaction to a message |
| `remove_reaction` | `messageId`, `emojiName` | Remove an emoji reaction from a message |

**Search filters** (all optional, combine as needed):
- `streamName` — filter by stream
- `topic` — filter by topic within the stream
- `senderId` — filter by sender user ID
- `query` — free-text search (supports Zulip search operators)
- `limit` — max results (default: 20, max: 100)

**Tips**:
- Use `search` with `streamName` + `topic` to get recent message history for a conversation
- Use `search` with `query` for full-text search across all accessible messages
- `edit` and `delete` only work on messages the bot has permission to modify (typically its own messages)
- When editing a topic, use `propagateMode` to control how the rename applies: `change_one` (default), `change_later`, or `change_all`
- `emojiName` should be without colons, e.g. `thumbs_up`, `check`, `eyes`, `tada`
- Use `get` to fetch full message details including content, sender info, and reactions

### `zulip_scheduled_messages`
Create, list, edit, or delete scheduled messages. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all pending scheduled messages |
| `create` | `content`, `scheduledAt`, + `streamName` or `userId` | Schedule a message for future delivery |
| `edit` | `scheduledMessageId` (+ `content`/`scheduledAt`/`topic`) | Update a pending scheduled message |
| `delete` | `scheduledMessageId` | Cancel/delete a scheduled message |

**Create parameters**:
- `streamName` — target stream name (mutually exclusive with `userId`)
- `topic` — topic within the stream (for stream messages; if omitted, defaults to "(no topic)" — always provide a topic)
- `userId` — target user ID for DM (mutually exclusive with `streamName`)
- `content` — message content in Zulip markdown
- `scheduledAt` — ISO 8601 datetime string for delivery, e.g. `2025-12-31T09:00:00Z` (must be in the future)

**Tips**:
- Use `list` to see all pending scheduled messages with their IDs
- The `scheduledMessageId` is different from a regular message ID
- Failed scheduled messages (shown with ❌) can be rescheduled by editing with a new `scheduledAt`
- Use `delete` to cancel a scheduled message before it is sent

### `zulip_user_groups`
Manage user groups. User groups can be @mentioned with `@*group_name*`. Actions:
| Action | Required params | Description |
|---|---|---|
| `list` | — | List all user groups (excludes system groups) |
| `create` | `name` (+ optional `description`, `members`) | Create a new user group |
| `update` | `groupId` (+ `name` and/or `description`) | Update group name or description |
| `delete` | `groupId` | Delete a user group |
| `members` | `groupId` | List member user IDs of a group |
| `add_members` | `groupId`, `members` | Add users to a group |
| `remove_members` | `groupId`, `members` | Remove users from a group |
**Tips**:
- Use `list` to find group IDs — you need the numeric `groupId` for most actions
- The `members` param is an array of numeric user IDs, e.g. `[12345, 67890]`
- System groups (built-in Zulip groups) are excluded from `list` output for clarity
- Use `zulip_users` → `list` to find user IDs before adding members

### `zulip_custom_emoji`
List, upload, or deactivate custom emoji in the Zulip organization. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all active custom emoji (use `includeDeactivated` to show all) |
| `upload` | `emojiName`, `imageUrl` | Upload a new custom emoji from an image URL |
| `deactivate` | `emojiName` | Deactivate (soft-delete) a custom emoji |

**Tips**:
- `emojiName` must be lowercase and contain only alphanumeric characters and underscores (e.g. `party_parrot`, `thumbs_up_green`)
- `imageUrl` must be a publicly accessible URL to a PNG, GIF, JPEG, or WebP image
- Recommended image size: under 256KB, ideally square
- Deactivated emoji are soft-deleted — they can still appear in old messages but cannot be used in new ones
- Use `list` with `includeDeactivated: true` to see all emoji including deactivated ones

## Formatting (Zulip Markdown)

Zulip uses its own markdown variant. Key differences from other platforms:

### Supported
- **Bold** (`**bold**`), *italic* (`*italic*`), ~~strikethrough~~ (`~~strike~~`)
- Code blocks with language hints: ` ```python `
- LaTeX: `$$e^{i\pi} + 1 = 0$$`
- Tables (standard markdown tables work)
- Bulleted and numbered lists
- Block quotes (`> text` or nested `>> text`)
- Spoiler/collapsible blocks:
  ````
  ```spoiler Header text
  Hidden content here
  ```
  ````
- User mentions: `@**Username**`
- Stream links: `#**stream-name**` or `#**stream-name>topic**`
- Linkified URLs (automatic)
- Emoji: `:emoji_name:` or Unicode

### Not Supported
- Inline buttons (unless explicitly enabled in plugin config `capabilities.inlineButtons`)
- Message effects

### Best Practices
- Use collapsible blocks (`spoiler`) for long output (logs, traces, large code)
- Keep messages under 10,000 characters (Zulip hard limit)
- For very long content, split into multiple messages
- Prefer bullet lists over dense paragraphs for readability

## Topic Conventions

Topics are central to Zulip's organization model:

- **Always specify a topic** when sending to a stream — never rely on the default
- **Stay in the current topic** when replying in a conversation; do not create a new topic unless the subject genuinely changes
- Topic names should be concise and descriptive (e.g., `deployment issues`, `PR #42 review`)
- Avoid generic topics like `general` or `misc` when a specific name fits

## Replying in Conversations

When the agent receives a message from a Zulip stream:

1. The reply is automatically routed to the same stream and topic — just respond normally
2. Use `zulip_send` only for **proactive** messages or sending to a **different** stream/topic/DM
3. If using `zulip_send` to deliver your reply, respond with `NO_REPLY` to avoid duplicates

## Direct Messages

- Use `zulip_send` with `userId` (numeric Zulip user ID, as a string)
- You need the user's Zulip ID — use `zulip_users` → `list` or `get_by_email` to find IDs

## Multi-Account

All six tools accept an optional `accountId` parameter. When your configuration defines multiple Zulip accounts under `channels.zulip.accounts`, pass `accountId` to target a specific account. If omitted, the primary/default account is used.

Example: `{ "action": "list_all", "accountId": "work" }` — lists streams on the "work" Zulip account.

## Common Pitfalls

1. **Empty content**: `zulip_send` will error if `content` is empty or whitespace-only
2. **Stream name case**: Stream names are case-sensitive — use exact names
3. **Missing topic**: Omitting `topic` results in "(no topic)" which looks unprofessional
4. **Duplicate replies**: If you use `zulip_send` to reply in the same conversation, you must return `NO_REPLY` as your response text
5. **Long messages**: Messages over 10,000 chars are rejected — split or use collapsible blocks
6. **streamId vs name**: `zulip_streams` actions like `update`, `delete`, `topics`, `members` require `streamId` (number), not stream name. Use `list_all` or `list_subscribed` to find IDs first
7. **Stream name must be plain**: `streamName` is the raw stream name only — no `#`, no `**`, no topic suffix. Common mistakes:
   - ❌ `streamName="engineering:weekly-sync"` (includes topic — use `topic` param instead)
   - ❌ `streamName="#engineering"` or `streamName="#engineering"` (includes `#` prefix)
   - ❌ `streamName="#**engineering**"` (includes Zulip markdown formatting)
   - ✅ `streamName="engineering"`, `topic="weekly-sync"`
8. **Don't parse Zulip markdown refs as names**: Stream links like `#**general>announcements**` are display formatting. Extract the plain name and topic separately
9. **Finding user IDs for DMs**: Use `zulip_users` with `list` or `get_by_email` to find user IDs — don't guess or hardcode them
10. **Message editing scope**: `zulip_messages` `edit` and `delete` require appropriate permissions — bots can typically only edit/delete their own messages
