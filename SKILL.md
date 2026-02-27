---
name: zulip
description: "Interact with Zulip messaging. Use when: sending messages to Zulip streams/DMs, managing streams, or responding in Zulip channels. Covers formatting, topic conventions, and tool usage."
metadata: { "openclaw": { "emoji": "💬" } }
---

# Zulip Skill

Guide for interacting with Zulip via the openclaw-zulip-plugin tools.

## Tools

Two tools are available:

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
  ```
  ```spoiler Header text
  Hidden content here
  ```​
  ```
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
- You need the user's Zulip ID — use `zulip_streams` → `members` to find IDs if needed

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
