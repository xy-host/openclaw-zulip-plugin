---
name: zulip
description: "Interact with Zulip messaging. Use when: sending messages to Zulip streams/DMs, managing streams, looking up users, searching/editing messages, or responding in Zulip channels. Covers formatting, topic conventions, and tool usage."
metadata: { "openclaw": { "emoji": "💬" } }
---

# Zulip Skill

Guide for interacting with Zulip via the openclaw-zulip-plugin tools.

## Tools

The following tools are available. All tools accept an optional `accountId` parameter for multi-account setups:

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

### `zulip_drafts`
List, create, edit, or delete message drafts. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all drafts with their IDs, targets, and content previews |
| `create` | `content` + `streamName` or `userId` | Create a new draft for a stream or DM |
| `edit` | `draftId`, `content` (+ optional `streamName`/`userId`/`topic`) | Update draft content and/or target |
| `delete` | `draftId` | Delete a draft |

**Create/Edit parameters**:
- `streamName` — target stream name (mutually exclusive with `userId`)
- `topic` — topic within the stream (if omitted for stream drafts, defaults to "(no topic)")
- `userId` — target user ID for DM draft (mutually exclusive with `streamName`)
- `content` — draft message content in Zulip markdown

**Tips**:
- Use `list` to see all drafts with their IDs — you need `draftId` for edit/delete
- Drafts appear in the user's compose box in Zulip
- When editing, only `content` is required — the target (stream/DM) is preserved from the original draft unless you override it with `streamName` or `userId`
- Use drafts to prepare messages that need review before sending

### `zulip_upload`
Upload files to the Zulip server and get shareable URIs.

| Parameter | Required | Description |
|---|---|---|
| `url` | one of url/base64 | Public URL of the file to download and upload |
| `base64` | one of url/base64 | Base64-encoded file content (mutually exclusive with url) |
| `fileName` | no | Name for the uploaded file (derived from URL if omitted) |
| `contentType` | no | MIME type (inferred from response headers if omitted) |

**Tips**:
- The returned URI can be used in Zulip messages with markdown: `[filename](uri)`
- Supports any file type: images, PDFs, documents, archives, etc.
- For base64 input, data: URI format is also accepted (e.g. `data:image/png;base64,...`)
- File names without extensions get an extension added automatically based on content type
- Use this tool to upload files independently, then reference the URI in messages via `zulip_send`

### `zulip_topics`
Manage topics within streams: resolve, unresolve, rename, move, or delete. Actions:

| Action | Required params | Description |
|---|---|---|
| `resolve` | `streamName`, `topic` | Mark a topic as resolved by prepending ✔ to its name |
| `unresolve` | `streamName`, `topic` | Remove the ✔ resolved prefix from a topic |
| `rename` | `streamName`, `topic`, `newTopic` | Rename a topic within the same stream |
| `move` | `streamName`, `topic` + `targetStreamName` and/or `newTopic` | Move a topic to a different stream (and optionally rename it) |
| `delete` | `streamName`, `topic` | Delete all messages in a topic (admin-only) |

**Parameters**:
- `streamName` — the stream where the topic currently lives (required for all actions)
- `topic` — the current topic name (required for all actions; include the ✔ prefix for unresolve)
- `newTopic` — new topic name (for rename and optionally for move)
- `targetStreamName` — destination stream name (for move)
- `propagateMode` — how to apply changes: `change_all` (default), `change_later`, or `change_one`

**Tips**:
- Resolving adds `✔ ` (checkmark + space) to the topic name — this is Zulip's standard resolved topic convention
- To unresolve, pass the full topic name including the `✔ ` prefix as the `topic` parameter
- `move` can move a topic to another stream, rename it, or both
- `delete` permanently removes all messages in the topic — use with caution, typically admin-only
- The `propagateMode` parameter defaults to `change_all` which applies the change to all messages in the topic

### `zulip_linkifiers`
List, add, update, remove, or reorder linkifiers (auto-linking patterns) in the Zulip organization. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all configured linkifiers with their IDs, patterns, and URL templates |
| `add` | `pattern`, `urlTemplate` | Add a new linkifier |
| `update` | `filterId`, `pattern`, `urlTemplate` | Update an existing linkifier's pattern and URL template |
| `remove` | `filterId` | Remove a linkifier |
| `reorder` | `orderedIds` | Reorder linkifiers by providing all IDs in the desired order |

**Parameters**:
- `pattern` — Regular expression using re2 syntax. Use named groups like `(?P<id>[0-9]+)` to capture values
- `urlTemplate` — URL template using RFC 6570 syntax, referencing named groups from the pattern, e.g. `https://github.com/org/repo/issues/{id}`
- `filterId` — Linkifier ID (use `list` to find IDs)
- `orderedIds` — Array of all linkifier IDs in desired order (must include every existing ID exactly once)

**Tips**:
- Linkifiers automatically convert matching text in messages and topics into clickable links
- Common use cases: linking issue numbers (`#123`), ticket IDs (`JIRA-456`), commit hashes, etc.
- Patterns use re2 regex syntax (not PCRE) — some advanced features like backreferences are not available
- The order of linkifiers matters when patterns overlap — use `reorder` to prioritize
- Use `list` to find `filterId` values before updating or removing

### `zulip_user_status`
Get or set user status (emoji + text) in Zulip. User status appears next to the user's name. Actions:

| Action | Required params | Description |
|---|---|---|
| `get` | `userId` | Get the status (text + emoji) set by a specific user |
| `set` | `statusText` and/or `emojiName` | Set the bot's own status |
| `clear` | — | Clear the bot's status entirely |

**Set parameters**:
- `statusText` — Status text to display (max 60 characters), e.g. "In a meeting", "On vacation"
- `emojiName` — Emoji name without colons, e.g. `calendar`, `palm_tree`, `hammer_and_wrench`

**Tips**:
- Use `get` to check what someone is up to before messaging them
- Use `set` to update the bot's own status — useful for indicating what the bot is working on
- Use `clear` to remove the bot's status entirely
- The `emojiName` can be a standard Unicode emoji name or a custom emoji name (use `zulip_custom_emoji` list to find available custom emoji)
- Status text is limited to 60 characters

### `zulip_server_settings`
Query server/organization info and custom profile fields. Actions:

| Action | Required params | Description |
|---|---|---|
| `server_info` | — | Get server version, feature level, and organization metadata |
| `profile_fields` | — | List custom profile fields configured for the organization |
| `user_profile` | `userId` | Get a specific user's custom profile data |

**Tips**:
- Use `server_info` to check the Zulip server version and feature level — useful for knowing which API features are available
- Use `profile_fields` to discover what custom fields the organization has configured (e.g., Team, Role, Phone, Pronouns)
- Use `user_profile` with a user ID to read that user's custom profile field values — great for looking up team membership, roles, etc.
- Fields of type "List of options" (type 3) show their available options in the `profile_fields` output
- Fields marked with ⭐ are displayed in profile summaries

### `zulip_message_flags`
Manage personal message flags (star, read) and check read receipts. Actions:

| Action | Required params | Description |
|---|---|---|
| `star` | `messageIds` | Add the starred flag to one or more messages |
| `unstar` | `messageIds` | Remove the starred flag from messages |
| `mark_read` | `messageIds` | Mark specific messages as read |
| `mark_unread` | `messageIds` | Mark specific messages as unread |
| `mark_topic_read` | `streamName` (+ optional `topic`) | Mark all messages in a stream or topic as read |
| `read_receipts` | `messageId` | Get user IDs who have read a specific message |

**Parameters**:
- `messageIds` — Array of numeric message IDs (max 100 per call), for star/unstar/mark_read/mark_unread
- `messageId` — Single message ID, for read_receipts
- `streamName` — Stream name for mark_topic_read
- `topic` — Optional topic filter for mark_topic_read; if omitted, the entire stream is marked read

**Tips**:
- Use `star` to bookmark important messages for later reference — starred messages appear in Zulip's "Starred messages" view
- Use `mark_topic_read` with `streamName` + `topic` to efficiently clear unread counts for a conversation
- Use `mark_topic_read` with only `streamName` (no topic) to mark an entire stream as read
- `read_receipts` requires the organization to have read receipts enabled — if disabled, it returns an empty list
- Use `zulip_messages` → `search` to find message IDs before starring or marking them

### `zulip_alert_words`
List, add, or remove alert words for the bot user. Alert words trigger notifications whenever any message in the organization contains one of these words/phrases. Actions:

| Action | Required params | Description |
|---|---|---|
| `list` | — | List all currently configured alert words |
| `add` | `words` | Add one or more alert words/phrases |
| `remove` | `words` | Remove one or more alert words/phrases |

**Parameters**:
- `words` — Array of strings, each being a word or phrase to add/remove, e.g. `["deploy", "incident", "production down"]`

**Tips**:
- Alert words are case-insensitive — "Deploy" and "deploy" are treated the same
- Alert words can be multi-word phrases like "production incident" or "release candidate"
- When a message contains an alert word, the bot receives a notification similar to an @mention
- Use alert words to monitor keywords across all streams without subscribing to every conversation
- The `add` and `remove` actions return the total count of alert words after the operation
- Adding a word that already exists is a no-op (no error, no duplicate)
- Removing a word that doesn't exist is also a no-op (no error)


### `zulip_user_preferences`
Manage personal preferences: topic visibility and user muting. Actions:

| Action | Required params | Description |
|---|---|---|
| `mute_topic` | `streamName`, `topic` | Mute a topic — silences notifications for it |
| `unmute_topic` | `streamName`, `topic` | Unmute a topic (useful in muted streams to get notifications for specific topics) |
| `follow_topic` | `streamName`, `topic` | Follow a topic — get notified about all messages, not just mentions |
| `reset_topic` | `streamName`, `topic` | Remove any visibility policy, restoring default behavior |
| `list_muted_users` | — | List all users the bot has muted |
| `mute_user` | `userId` | Mute a user — their messages are auto-read and hidden |
| `unmute_user` | `userId` | Unmute a previously muted user |

**Topic action parameters**:
- `streamName` — the stream where the topic lives (plain name, no `#` or `**`)
- `topic` — the topic name to set the visibility policy for

**User action parameters**:
- `userId` — the numeric user ID to mute/unmute (use `zulip_users` to find IDs)

**Tips**:
- Muting a topic silences all notifications for it — messages still exist but won't trigger alerts
- Unmuting a topic is especially useful when the entire stream is muted but you want notifications for one specific topic
- Following a topic enables notifications for every message, similar to being @mentioned on each one
- Resetting a topic removes any custom visibility policy, returning to the stream's default behavior
- Muted users' messages are automatically marked as read and hidden from the UI
- Use `list_muted_users` to see all currently muted users with timestamps
- Muting yourself is not allowed and will return an error

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

All tools accept an optional `accountId` parameter. When your configuration defines multiple Zulip accounts under `channels.zulip.accounts`, pass `accountId` to target a specific account. If omitted, the primary/default account is used.

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
