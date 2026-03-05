import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zulipPlugin } from "./src/channel.js";
import { setZulipRuntime } from "./src/runtime.js";
import {
  createZulipClient,
  listZulipStreams,
  listZulipSubscriptions,
  subscribeZulipStream,
  unsubscribeZulipStream,
  getZulipStreamTopics,
  updateZulipStream,
  deleteZulipStream,
  getZulipStreamMembers,
  sendZulipApiMessage,
  listZulipUsers,
  getZulipUser,
  getZulipUserByEmail,
  getZulipUserPresence,
  getZulipMessages,
  getZulipSingleMessage,
  updateZulipMessage,
  deleteZulipMessage,
  addZulipReaction,
  removeZulipReaction,
  listZulipScheduledMessages,
  createZulipScheduledMessage,
  updateZulipScheduledMessage,
  deleteZulipScheduledMessage,
  listZulipUserGroups,
  createZulipUserGroup,
  updateZulipUserGroup,
  deleteZulipUserGroup,
  getZulipUserGroupMembers,
  updateZulipUserGroupMembers,
  listZulipCustomEmoji,
  uploadZulipCustomEmoji,
  deactivateZulipCustomEmoji,
  listZulipDrafts,
  createZulipDraft,
  editZulipDraft,
  deleteZulipDraft,
  deleteZulipTopic,
} from "./src/zulip/client.js";
import { resolveZulipAccount } from "./src/zulip/accounts.js";

function getClient(cfg: any, accountId?: string) {
  const account = resolveZulipAccount({ cfg, accountId });
  return createZulipClient({
    serverUrl: account.serverUrl,
    botEmail: account.botEmail,
    apiKey: account.apiKey,
  });
}

function formatUserDetails(user: {
  full_name: string;
  user_id: number;
  email: string;
  is_active: boolean;
  is_bot: boolean;
  timezone?: string;
  date_joined?: string;
}): string {
  return [
    `**${user.full_name}**`,
    `- ID: ${user.user_id}`,
    `- Email: ${user.email}`,
    `- Active: ${user.is_active ? "Yes" : "No"}`,
    `- Bot: ${user.is_bot ? "Yes" : "No"}`,
    user.timezone ? `- Timezone: ${user.timezone}` : null,
    user.date_joined ? `- Joined: ${user.date_joined}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMessageDetails(msg: {
  id: number;
  sender_full_name: string;
  sender_id: number;
  type: string;
  display_recipient: string | Array<{ id: number; email: string; full_name: string }>;
  subject: string;
  content: string;
  timestamp: number;
}): string {
  const date = new Date(msg.timestamp * 1000).toISOString();
  const location =
    msg.type === "stream"
      ? `#${typeof msg.display_recipient === "string" ? msg.display_recipient : "?"} > ${msg.subject}`
      : "DM";
  const preview =
    msg.content.length > 300
      ? msg.content.slice(0, 300) + "…"
      : msg.content;
  return `**[${msg.id}]** ${msg.sender_full_name} (${date}) in ${location}:\n${preview}`;
}

const plugin = {
  id: "zulip",
  name: "Zulip",
  description: "Zulip channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZulipRuntime(api.runtime);
    api.registerChannel({ plugin: zulipPlugin });

    // ── Agent Tools ──

    api.registerTool({
      name: "zulip_streams",
      description:
        "List, create, join, leave, update, or delete Zulip streams/channels. " +
        "Also list topics and members of a stream.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: [
              "list_all",
              "list_subscribed",
              "create",
              "join",
              "leave",
              "update",
              "delete",
              "topics",
              "members",
            ],
            description: "Action to perform",
          },
          name: {
            type: "string",
            description: "Stream name (for create/join/leave)",
          },
          streamId: {
            type: "number",
            description: "Stream ID (for update/delete/topics/members)",
          },
          description: {
            type: "string",
            description: "Stream description (for create/update)",
          },
          isPrivate: {
            type: "boolean",
            description: "Whether the stream is private (for create/update)",
          },
          newName: {
            type: "string",
            description: "New name (for update)",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list_all": {
            const streams = await listZulipStreams(client);
            const lines = streams.map(
              (s) =>
                `- **${s.name}** (id:${s.stream_id}) — ${s.description || "(no description)"}${s.invite_only ? " 🔒" : ""}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: lines.length > 0 ? lines.join("\n") : "No streams found.",
                },
              ],
            };
          }

          case "list_subscribed": {
            const subs = await listZulipSubscriptions(client);
            const lines = subs.map(
              (s) =>
                `- **${s.name}** (id:${s.stream_id}) — ${s.description || "(no description)"}${s.is_muted ? " 🔇" : ""}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: lines.length > 0 ? lines.join("\n") : "Not subscribed to any streams.",
                },
              ],
            };
          }

          case "create":
          case "join": {
            if (!params.name) {
              return {
                content: [{ type: "text", text: "Error: stream name is required." }],
              };
            }
            const result = await subscribeZulipStream(client, {
              name: params.name,
              description: params.description,
              isPrivate: params.isPrivate,
            });
            const subscribed = Object.keys(result.subscribed ?? {}).length > 0;
            const already = Object.keys(result.already_subscribed ?? {}).length > 0;
            const msg = subscribed
              ? `Created/joined stream **${params.name}** ✅`
              : already
                ? `Already subscribed to **${params.name}**`
                : `Subscribed to **${params.name}**`;
            return { content: [{ type: "text", text: msg }] };
          }

          case "leave": {
            if (!params.name) {
              return {
                content: [{ type: "text", text: "Error: stream name is required." }],
              };
            }
            await unsubscribeZulipStream(client, params.name);
            return {
              content: [
                { type: "text", text: `Left stream **${params.name}** ✅` },
              ],
            };
          }

          case "update": {
            if (!params.streamId) {
              return {
                content: [
                  { type: "text", text: "Error: streamId is required for update." },
                ],
              };
            }
            await updateZulipStream(client, params.streamId, {
              description: params.description,
              newName: params.newName,
              isPrivate: params.isPrivate,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Stream ${params.streamId} updated ✅`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.streamId) {
              return {
                content: [
                  { type: "text", text: "Error: streamId is required for delete." },
                ],
              };
            }
            await deleteZulipStream(client, params.streamId);
            return {
              content: [
                { type: "text", text: `Stream ${params.streamId} deleted ✅` },
              ],
            };
          }

          case "topics": {
            if (!params.streamId) {
              return {
                content: [
                  { type: "text", text: "Error: streamId is required for topics." },
                ],
              };
            }
            const topics = await getZulipStreamTopics(client, params.streamId);
            const lines = topics.map((t) => `- ${t.name}`);
            return {
              content: [
                {
                  type: "text",
                  text:
                    lines.length > 0
                      ? lines.join("\n")
                      : "No topics found in this stream.",
                },
              ],
            };
          }

          case "members": {
            if (!params.streamId) {
              return {
                content: [
                  { type: "text", text: "Error: streamId is required for members." },
                ],
              };
            }
            const members = await getZulipStreamMembers(client, params.streamId);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream has ${members.length} members: ${members.join(", ")}`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${params.action}` },
              ],
            };
        }
      },
    });

    api.registerTool({
      name: "zulip_send",
      description:
        "Send a message to a Zulip stream (with topic) or DM. " +
        "For streams: provide streamName and topic. For DMs: provide userId.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          streamName: {
            type: "string",
            description: "Stream name to send to",
          },
          topic: {
            type: "string",
            description: "Topic within the stream",
          },
          userId: {
            type: "string",
            description: "User ID for direct message",
          },
          content: {
            type: "string",
            description: "Message content (Zulip markdown)",
          },
        },
        required: ["content"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        if (params.streamName) {
          const result = await sendZulipApiMessage(client, {
            type: "stream",
            to: params.streamName,
            topic: params.topic ?? "(no topic)",
            content: params.content,
          });
          return {
            content: [
              {
                type: "text",
                text: `Sent to #${params.streamName} > ${params.topic ?? "(no topic)"} (id:${result.id}) ✅`,
              },
            ],
          };
        } else if (params.userId) {
          const result = await sendZulipApiMessage(client, {
            type: "direct",
            to: JSON.stringify([Number(params.userId)]),
            content: params.content,
          });
          return {
            content: [
              {
                type: "text",
                text: `Sent DM to user ${params.userId} (id:${result.id}) ✅`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide either streamName or userId.",
              },
            ],
          };
        }
      },
    });

    api.registerTool({
      name: "zulip_users",
      description:
        "List, look up, or check presence of Zulip users. " +
        "Use to find user IDs for DMs, look up user details, or check who is online.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: ["list", "get", "get_by_email", "presence"],
            description: "Action to perform",
          },
          userId: {
            type: "number",
            description: "User ID (for get/presence)",
          },
          email: {
            type: "string",
            description: "User email address (for get_by_email)",
          },
          includeDeactivated: {
            type: "boolean",
            description:
              "Include deactivated users in list results (default: false)",
          },
          includeBots: {
            type: "boolean",
            description: "Include bot users in list results (default: false)",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const users = await listZulipUsers(client);
            const includeDeactivated = params.includeDeactivated === true;
            const includeBots = params.includeBots === true;
            const filtered = users.filter((u) => {
              if (!includeDeactivated && !u.is_active) return false;
              if (!includeBots && u.is_bot) return false;
              return true;
            });
            const lines = filtered.map(
              (u) =>
                `- **${u.full_name}** (id:${u.user_id}, email:${u.email})${u.is_bot ? " 🤖" : ""}${!u.is_active ? " ⛔" : ""}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text:
                    lines.length > 0
                      ? `${lines.length} users found:\n${lines.join("\n")}`
                      : "No users found.",
                },
              ],
            };
          }

          case "get": {
            if (!params.userId) {
              return {
                content: [
                  { type: "text", text: "Error: userId is required for get." },
                ],
              };
            }
            const user = await getZulipUser(client, params.userId);
            return {
              content: [
                {
                  type: "text",
                  text: formatUserDetails(user),
                },
              ],
            };
          }

          case "get_by_email": {
            if (!params.email) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: email is required for get_by_email.",
                  },
                ],
              };
            }
            const user = await getZulipUserByEmail(client, params.email);
            return {
              content: [
                {
                  type: "text",
                  text: formatUserDetails(user),
                },
              ],
            };
          }

          case "presence": {
            if (!params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userId is required for presence.",
                  },
                ],
              };
            }
            const { presence } = await getZulipUserPresence(
              client,
              params.userId,
            );
            const entries = Object.entries(presence);
            if (entries.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No presence data for user ${params.userId}.`,
                  },
                ],
              };
            }
            const lines = entries.map(([clientName, info]) => {
              const ts = new Date(info.timestamp * 1000).toISOString();
              const emoji =
                info.status === "active"
                  ? "🟢"
                  : info.status === "idle"
                    ? "🟡"
                    : "⚫";
              return `- ${emoji} **${clientName}**: ${info.status} (last seen: ${ts})`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Presence for user ${params.userId}:\n${lines.join("\n")}`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${params.action}` },
              ],
            };
        }
      },
    });

    api.registerTool({
      name: "zulip_messages",
      description:
        "Search, fetch, edit, delete Zulip messages, and manage reactions. " +
        "Use to retrieve message history from streams/topics/DMs, look up a specific message, " +
        "edit or delete messages the bot has sent, or add/remove emoji reactions.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: [
              "get",
              "search",
              "edit",
              "delete",
              "add_reaction",
              "remove_reaction",
            ],
            description: "Action to perform",
          },
          messageId: {
            type: "number",
            description: "Message ID (for get/edit/delete/add_reaction/remove_reaction)",
          },
          query: {
            type: "string",
            description:
              "Search query string for Zulip search (for search action). " +
              "Supports Zulip search operators like 'stream:', 'topic:', 'sender:', 'has:', 'is:', etc.",
          },
          streamName: {
            type: "string",
            description:
              "Filter messages by stream name (for search). Adds a 'stream' narrow.",
          },
          topic: {
            type: "string",
            description:
              "Filter messages by topic (for search). Adds a 'topic' narrow.",
          },
          senderId: {
            type: "number",
            description:
              "Filter messages by sender user ID (for search). Adds a 'sender' narrow.",
          },
          limit: {
            type: "number",
            description:
              "Maximum number of messages to return (for search, default: 20, max: 100)",
          },
          content: {
            type: "string",
            description: "New message content (for edit)",
          },
          newTopic: {
            type: "string",
            description: "New topic for the message (for edit, stream messages only)",
          },
          propagateMode: {
            type: "string",
            enum: ["change_one", "change_later", "change_all"],
            description:
              "How to propagate topic changes (for edit with newTopic). " +
              "'change_one' = only this message, 'change_later' = this and later, 'change_all' = all in topic. Default: 'change_one'",
          },
          emojiName: {
            type: "string",
            description:
              "Emoji name without colons (for add_reaction/remove_reaction), e.g. 'thumbs_up', 'check', 'eyes'",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "get": {
            if (!params.messageId) {
              return {
                content: [
                  { type: "text", text: "Error: messageId is required for get." },
                ],
              };
            }
            const msg = await getZulipSingleMessage(client, params.messageId);
            return {
              content: [
                {
                  type: "text",
                  text: formatMessageDetails(msg),
                },
              ],
            };
          }

          case "search": {
            const narrow: Array<{ operator: string; operand: string | number }> = [];
            if (params.streamName) {
              narrow.push({ operator: "stream", operand: params.streamName });
            }
            if (params.topic) {
              narrow.push({ operator: "topic", operand: params.topic });
            }
            if (params.senderId) {
              narrow.push({ operator: "sender", operand: params.senderId });
            }
            if (params.query) {
              narrow.push({ operator: "search", operand: params.query });
            }

            const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
            const result = await getZulipMessages(client, {
              anchor: "newest",
              numBefore: limit,
              numAfter: 0,
              narrow: narrow.length > 0 ? narrow : undefined,
            });

            const messages = result.messages;
            if (messages.length === 0) {
              return {
                content: [
                  { type: "text", text: "No messages found matching the criteria." },
                ],
              };
            }

            const lines = messages.map((m) => formatMessageDetails(m));
            return {
              content: [
                {
                  type: "text",
                  text: `${messages.length} message(s) found:\n\n${lines.join("\n\n---\n\n")}`,
                },
              ],
            };
          }

          case "edit": {
            if (!params.messageId) {
              return {
                content: [
                  { type: "text", text: "Error: messageId is required for edit." },
                ],
              };
            }
            if (!params.content && !params.newTopic) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide content and/or newTopic to edit.",
                  },
                ],
              };
            }
            await updateZulipMessage(client, params.messageId, {
              content: params.content,
              ...(params.newTopic
                ? {
                    topic: params.newTopic,
                    propagateMode: params.propagateMode ?? "change_one",
                  }
                : {}),
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Message ${params.messageId} updated ✅`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.messageId) {
              return {
                content: [
                  { type: "text", text: "Error: messageId is required for delete." },
                ],
              };
            }
            await deleteZulipMessage(client, params.messageId);
            return {
              content: [
                {
                  type: "text",
                  text: `Message ${params.messageId} deleted ✅`,
                },
              ],
            };
          }

          case "add_reaction": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for add_reaction.",
                  },
                ],
              };
            }
            if (!params.emojiName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emojiName is required for add_reaction.",
                  },
                ],
              };
            }
            await addZulipReaction(client, params.messageId, params.emojiName);
            return {
              content: [
                {
                  type: "text",
                  text: `Added :${params.emojiName}: to message ${params.messageId} ✅`,
                },
              ],
            };
          }

          case "remove_reaction": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for remove_reaction.",
                  },
                ],
              };
            }
            if (!params.emojiName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emojiName is required for remove_reaction.",
                  },
                ],
              };
            }
            await removeZulipReaction(
              client,
              params.messageId,
              params.emojiName,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Removed :${params.emojiName}: from message ${params.messageId} ✅`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${params.action}` },
              ],
            };
        }
      },
    });

    api.registerTool({
      name: "zulip_scheduled_messages",
      description:
        "Create, list, edit, or delete scheduled messages in Zulip. " +
        "Use to schedule messages for future delivery to streams or DMs, " +
        "view pending scheduled messages, reschedule them, or cancel them.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: ["list", "create", "edit", "delete"],
            description: "Action to perform",
          },
          scheduledMessageId: {
            type: "number",
            description:
              "Scheduled message ID (for edit/delete). This is different from a regular message ID.",
          },
          streamName: {
            type: "string",
            description:
              "Stream name to send to (for create). Mutually exclusive with userId.",
          },
          topic: {
            type: "string",
            description:
              "Topic within the stream (for create/edit when targeting a stream). If omitted for a stream target, the topic defaults to \"(no topic)\".",
          },
          userId: {
            type: "string",
            description:
              "User ID for direct message (for create). Mutually exclusive with streamName.",
          },
          content: {
            type: "string",
            description: "Message content in Zulip markdown (for create/edit).",
          },
          scheduledAt: {
            type: "string",
            description:
              "ISO 8601 datetime string for when the message should be sent (for create/edit), " +
              "e.g. '2025-12-31T09:00:00Z'. Must be in the future.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const scheduled = await listZulipScheduledMessages(client);
            if (scheduled.length === 0) {
              return {
                content: [
                  { type: "text", text: "No scheduled messages found." },
                ],
              };
            }
            const lines = scheduled.map((sm) => {
              const deliverAt = new Date(
                sm.scheduled_delivery_timestamp * 1000,
              ).toISOString();
              const target =
                sm.type === "stream"
                  ? `stream (id:${sm.to})${sm.topic ? ` > ${sm.topic}` : ""}`
                  : `DM to ${JSON.stringify(sm.to)}`;
              const preview =
                sm.content.length > 200
                  ? sm.content.slice(0, 200) + "…"
                  : sm.content;
              const status = sm.failed ? " ❌ FAILED" : "";
              return `- **[${sm.scheduled_message_id}]** → ${target} at ${deliverAt}${status}\n  ${preview}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `${scheduled.length} scheduled message(s):\n\n${lines.join("\n\n")}`,
                },
              ],
            };
          }

          case "create": {
            if (!params.content) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: content is required for create.",
                  },
                ],
              };
            }
            if (!params.scheduledAt) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledAt is required for create (ISO 8601 datetime).",
                  },
                ],
              };
            }
            const deliverTimestamp = Math.floor(
              new Date(params.scheduledAt).getTime() / 1000,
            );
            if (isNaN(deliverTimestamp) || deliverTimestamp <= 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledAt is not a valid datetime.",
                  },
                ],
              };
            }
            if (deliverTimestamp <= Math.floor(Date.now() / 1000)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledAt must be in the future.",
                  },
                ],
              };
            }

            if (params.streamName && params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide only one of streamName or userId for create.",
                  },
                ],
              };
            }

            if (params.streamName) {
              // Resolve stream name to ID; try subscriptions first (includes private streams),
              // then fall back to all public streams
              const stream =
                (await listZulipSubscriptions(client)).find(
                  (s) =>
                    s.name.toLowerCase() ===
                    params.streamName.toLowerCase(),
                ) ??
                (await listZulipStreams(client)).find(
                  (s) =>
                    s.name.toLowerCase() ===
                    params.streamName.toLowerCase(),
                );

              if (!stream) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: stream "${params.streamName}" not found.`,
                    },
                  ],
                };
              }
              const result = await createZulipScheduledMessage(client, {
                type: "stream",
                to: stream.stream_id,
                content: params.content,
                scheduledDeliveryTimestamp: deliverTimestamp,
                topic: params.topic ?? "(no topic)",
              });
              const deliverAt = new Date(
                deliverTimestamp * 1000,
              ).toISOString();
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Scheduled message (id:${result.scheduled_message_id}) ` +
                      `to #${params.streamName} > ${params.topic ?? "(no topic)"} ` +
                      `at ${deliverAt} ✅`,
                  },
                ],
              };
            } else if (params.userId) {
              const userId = Number(params.userId);
              if (!Number.isFinite(userId) || userId <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: userId must be a valid positive numeric user ID.",
                    },
                  ],
                };
              }
              const result = await createZulipScheduledMessage(client, {
                type: "direct",
                to: [userId],
                content: params.content,
                scheduledDeliveryTimestamp: deliverTimestamp,
              });
              const deliverAt = new Date(
                deliverTimestamp * 1000,
              ).toISOString();
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Scheduled DM (id:${result.scheduled_message_id}) ` +
                      `to user ${params.userId} at ${deliverAt} ✅`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide either streamName or userId for create.",
                  },
                ],
              };
            }
          }

          case "edit": {
            if (!params.scheduledMessageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledMessageId is required for edit.",
                  },
                ],
              };
            }
            if (!params.content && !params.scheduledAt && !params.topic) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide content, scheduledAt, and/or topic to edit.",
                  },
                ],
              };
            }
            const updateParams: {
              content?: string;
              topic?: string;
              scheduledDeliveryTimestamp?: number;
            } = {};
            if (params.content) updateParams.content = params.content;
            if (params.topic) updateParams.topic = params.topic;
            if (params.scheduledAt) {
              const ts = Math.floor(
                new Date(params.scheduledAt).getTime() / 1000,
              );
              if (isNaN(ts) || ts <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: scheduledAt is not a valid datetime.",
                    },
                  ],
                };
              }
              if (ts <= Math.floor(Date.now() / 1000)) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: scheduledAt must be in the future.",
                    },
                  ],
                };
              }
              updateParams.scheduledDeliveryTimestamp = ts;
            }
            await updateZulipScheduledMessage(
              client,
              params.scheduledMessageId,
              updateParams,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Scheduled message ${params.scheduledMessageId} updated ✅`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.scheduledMessageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledMessageId is required for delete.",
                  },
                ],
              };
            }
            await deleteZulipScheduledMessage(
              client,
              params.scheduledMessageId,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Scheduled message ${params.scheduledMessageId} deleted ✅`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action: ${params.action}`,
                },
              ],
            };
        }
      },
    });

    api.registerTool({
      name: "zulip_user_groups",
      description:
        "List, create, update, or delete Zulip user groups, and manage group members. " +
        "User groups can be mentioned with @*group_name* and are useful for organizing teams.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: [
              "list",
              "create",
              "update",
              "delete",
              "members",
              "add_members",
              "remove_members",
            ],
            description: "Action to perform",
          },
          groupId: {
            type: "number",
            description:
              "User group ID (for update/delete/members/add_members/remove_members)",
          },
          name: {
            type: "string",
            description: "Group name (for create/update)",
          },
          description: {
            type: "string",
            description: "Group description (for create/update)",
          },
          members: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of user IDs to set as initial members (for create) or to add/remove (for add_members/remove_members)",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const groups = await listZulipUserGroups(client);
            // Filter out system groups by default for cleaner output
            const userGroups = groups.filter((g) => !g.is_system_group);
            const lines = userGroups.map(
              (g) =>
                `- **${g.name}** (id:${g.id}) — ${g.description || "(no description)"} [${g.members.length} members]`,
            );
            return {
              content: [
                {
                  type: "text",
                  text:
                    lines.length > 0
                      ? `${lines.length} user group(s):\n${lines.join("\n")}`
                      : "No user groups found (excluding system groups).",
                },
              ],
            };
          }

          case "create": {
            if (!params.name) {
              return {
                content: [
                  { type: "text", text: "Error: name is required for create." },
                ],
              };
            }
            await createZulipUserGroup(client, {
              name: params.name,
              description: params.description,
              members: params.members ?? [],
            });
            return {
              content: [
                {
                  type: "text",
                  text: `User group **${params.name}** created ✅${params.members?.length ? ` with ${params.members.length} member(s)` : ""}`,
                },
              ],
            };
          }

          case "update": {
            if (!params.groupId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: groupId is required for update.",
                  },
                ],
              };
            }
            if (!params.name && !params.description) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide name and/or description to update.",
                  },
                ],
              };
            }
            await updateZulipUserGroup(client, params.groupId, {
              name: params.name,
              description: params.description,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `User group ${params.groupId} updated ✅`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.groupId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: groupId is required for delete.",
                  },
                ],
              };
            }
            await deleteZulipUserGroup(client, params.groupId);
            return {
              content: [
                {
                  type: "text",
                  text: `User group ${params.groupId} deleted ✅`,
                },
              ],
            };
          }

          case "members": {
            if (!params.groupId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: groupId is required for members.",
                  },
                ],
              };
            }
            const members = await getZulipUserGroupMembers(
              client,
              params.groupId,
            );
            return {
              content: [
                {
                  type: "text",
                  text:
                    members.length > 0
                      ? `Group has ${members.length} member(s): ${members.join(", ")}`
                      : "Group has no members.",
                },
              ],
            };
          }

          case "add_members": {
            if (!params.groupId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: groupId is required for add_members.",
                  },
                ],
              };
            }
            if (!params.members || params.members.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: members array is required for add_members.",
                  },
                ],
              };
            }
            await updateZulipUserGroupMembers(client, params.groupId, {
              add: params.members,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Added ${params.members.length} member(s) to group ${params.groupId} ✅`,
                },
              ],
            };
          }

          case "remove_members": {
            if (!params.groupId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: groupId is required for remove_members.",
                  },
                ],
              };
            }
            if (!params.members || params.members.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: members array is required for remove_members.",
                  },
                ],
              };
            }
            await updateZulipUserGroupMembers(client, params.groupId, {
              remove: params.members,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Removed ${params.members.length} member(s) from group ${params.groupId} ✅`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action: ${params.action}`,
                },
              ],
            };
        }
      },
    });
    api.registerTool({
      name: "zulip_custom_emoji",
      description:
        "List, upload, or deactivate custom emoji in the Zulip organization. " +
        "Custom emoji can be used in messages with :emoji_name: syntax. " +
        "Upload accepts a public image URL which will be fetched and uploaded to Zulip.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: ["list", "upload", "deactivate"],
            description: "Action to perform",
          },
          emojiName: {
            type: "string",
            description:
              "Emoji name (for upload/deactivate). Must be unique, lowercase, and use only alphanumeric characters and underscores.",
          },
          imageUrl: {
            type: "string",
            description:
              "Public URL of the image to upload as custom emoji (for upload). " +
              "Supported formats: PNG, GIF, JPEG. Max recommended size: 256KB.",
          },
          includeDeactivated: {
            type: "boolean",
            description:
              "Include deactivated emoji in list results (default: false)",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const allEmoji = await listZulipCustomEmoji(client);
            const includeDeactivated = params.includeDeactivated === true;
            const filtered = includeDeactivated
              ? allEmoji
              : allEmoji.filter((e) => !e.deactivated);
            if (filtered.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: includeDeactivated
                      ? "No custom emoji found."
                      : "No active custom emoji found.",
                  },
                ],
              };
            }
            const lines = filtered.map(
              (e) =>
                `- :${e.name}: — **${e.name}** (id:${e.id})${e.deactivated ? " ⛔ deactivated" : ""}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `${filtered.length} custom emoji:\n${lines.join("\n")}`,
                },
              ],
            };
          }

          case "upload": {
            if (!params.emojiName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emojiName is required for upload.",
                  },
                ],
              };
            }
            if (!params.imageUrl) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: imageUrl is required for upload.",
                  },
                ],
              };
            }

            // Validate emoji name format
            const nameRegex = /^[a-z0-9_]+$/;
            if (!nameRegex.test(params.emojiName)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emojiName must be lowercase and contain only alphanumeric characters and underscores.",
                  },
                ],
              };
            }

            // Fetch the image from URL
            let imageBuffer: Buffer;
            let contentType: string | undefined;
            let fileName: string;
            try {
              const response = await fetch(params.imageUrl);
              if (!response.ok) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: failed to fetch image from URL (HTTP ${response.status}).`,
                    },
                  ],
                };
              }
              contentType = response.headers.get("content-type") ?? undefined;
              const arrayBuffer = await response.arrayBuffer();
              imageBuffer = Buffer.from(arrayBuffer);

              // Derive file extension from content type
              const extMap: Record<string, string> = {
                "image/png": ".png",
                "image/gif": ".gif",
                "image/jpeg": ".jpg",
                "image/webp": ".webp",
              };
              const ext = contentType ? (extMap[contentType.split(";")[0].trim()] ?? ".png") : ".png";
              fileName = `${params.emojiName}${ext}`;
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: failed to fetch image from URL: ${String(err)}`,
                  },
                ],
              };
            }

            await uploadZulipCustomEmoji(
              client,
              params.emojiName,
              imageBuffer,
              fileName,
              contentType,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Custom emoji :${params.emojiName}: uploaded ✅`,
                },
              ],
            };
          }

          case "deactivate": {
            if (!params.emojiName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emojiName is required for deactivate.",
                  },
                ],
              };
            }

            // Look up emoji ID by name
            const allEmoji = await listZulipCustomEmoji(client);
            const target = allEmoji.find(
              (e) => e.name === params.emojiName && !e.deactivated,
            );
            if (!target) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: active custom emoji ":${params.emojiName}:" not found.`,
                  },
                ],
              };
            }

            await deactivateZulipCustomEmoji(client, target.id);
            return {
              content: [
                {
                  type: "text",
                  text: `Custom emoji :${params.emojiName}: deactivated ✅`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action: ${params.action}`,
                },
              ],
            };
        }
      },
    });


    api.registerTool({
      name: "zulip_drafts",
      description:
        "List, create, edit, or delete message drafts in Zulip. " +
        "Drafts are unsent messages saved on the server that appear in the user's compose box. " +
        "Use to prepare messages for later review, save work-in-progress messages, or manage existing drafts.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: ["list", "create", "edit", "delete"],
            description: "Action to perform",
          },
          draftId: {
            type: "number",
            description: "Draft ID (for edit/delete)",
          },
          streamName: {
            type: "string",
            description:
              "Stream name for the draft target (for create/edit). Mutually exclusive with userId.",
          },
          topic: {
            type: "string",
            description:
              "Topic within the stream (for create/edit when targeting a stream).",
          },
          userId: {
            type: "string",
            description:
              "User ID for a DM draft (for create/edit). Mutually exclusive with streamName.",
          },
          content: {
            type: "string",
            description: "Draft message content in Zulip markdown (for create/edit).",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const drafts = await listZulipDrafts(client);
            if (drafts.length === 0) {
              return {
                content: [{ type: "text", text: "No drafts found." }],
              };
            }
            const lines: string[] = [];
            for (const d of drafts) {
              const date = new Date(d.timestamp * 1000).toISOString();
              let target: string;
              if (d.type === "stream") {
                const streams = await listZulipStreams(client).catch(() => []);
                const streamId = d.to[0];
                const stream = streams.find((s) => s.stream_id === streamId);
                const streamLabel = stream ? stream.name : String(streamId);
                target = `#${streamLabel}${d.topic ? ` > ${d.topic}` : ""}`;
              } else {
                target = `DM to ${JSON.stringify(d.to)}`;
              }
              const preview =
                d.content.length > 200
                  ? d.content.slice(0, 200) + "\u2026"
                  : d.content;
              lines.push(`- **[${d.id}]** \u2192 ${target} (${date})\n  ${preview}`);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `${drafts.length} draft(s):\n\n${lines.join("\n\n")}`,
                },
              ],
            };
          }

          case "create": {
            if (!params.content) {
              return {
                content: [
                  { type: "text", text: "Error: content is required for create." },
                ],
              };
            }
            if (params.streamName && params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide only one of streamName or userId for create.",
                  },
                ],
              };
            }
            if (!params.streamName && !params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide either streamName or userId for create.",
                  },
                ],
              };
            }

            if (params.streamName) {
              const stream =
                (await listZulipSubscriptions(client)).find(
                  (s) =>
                    s.name.toLowerCase() === params.streamName.toLowerCase(),
                ) ??
                (await listZulipStreams(client)).find(
                  (s) =>
                    s.name.toLowerCase() === params.streamName.toLowerCase(),
                );
              if (!stream) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: stream "${params.streamName}" not found.`,
                    },
                  ],
                };
              }
              const ids = await createZulipDraft(client, {
                type: "stream",
                to: [stream.stream_id],
                topic: params.topic ?? "(no topic)",
                content: params.content,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Draft created (id:${ids[0]}) for ` +
                      `#${params.streamName} > ${params.topic ?? "(no topic)"} \u2705`,
                  },
                ],
              };
            } else {
              const userId = Number(params.userId);
              if (!Number.isFinite(userId) || userId <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: userId must be a valid positive numeric user ID.",
                    },
                  ],
                };
              }
              const ids = await createZulipDraft(client, {
                type: "private",
                to: [userId],
                content: params.content,
              });
              return {
                content: [
                  {
                    type: "text",
                    text: `Draft created (id:${ids[0]}) for DM to user ${params.userId} \u2705`,
                  },
                ],
              };
            }
          }

          case "edit": {
            if (!params.draftId) {
              return {
                content: [
                  { type: "text", text: "Error: draftId is required for edit." },
                ],
              };
            }
            if (!params.content) {
              return {
                content: [
                  { type: "text", text: "Error: content is required for edit." },
                ],
              };
            }
            if (params.streamName && params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide only one of streamName or userId for edit.",
                  },
                ],
              };
            }

            // Fetch the existing draft to get its current target if not overridden
            const existingDrafts = await listZulipDrafts(client);
            const existing = existingDrafts.find((d) => d.id === params.draftId);
            if (!existing) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: draft ${params.draftId} not found.`,
                  },
                ],
              };
            }

            let draftType = existing.type;
            let draftTo = existing.to;
            let draftTopic = existing.topic;

            if (params.streamName) {
              const stream =
                (await listZulipSubscriptions(client)).find(
                  (s) =>
                    s.name.toLowerCase() === params.streamName.toLowerCase(),
                ) ??
                (await listZulipStreams(client)).find(
                  (s) =>
                    s.name.toLowerCase() === params.streamName.toLowerCase(),
                );
              if (!stream) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: stream "${params.streamName}" not found.`,
                    },
                  ],
                };
              }
              draftType = "stream";
              draftTo = [stream.stream_id];
              draftTopic = params.topic ?? "(no topic)";
            } else if (params.userId) {
              const userId = Number(params.userId);
              if (!Number.isFinite(userId) || userId <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: userId must be a valid positive numeric user ID.",
                    },
                  ],
                };
              }
              draftType = "private";
              draftTo = [userId];
              draftTopic = "";
            } else if (params.topic) {
              draftTopic = params.topic;
            }

            await editZulipDraft(client, params.draftId, {
              type: draftType,
              to: draftTo,
              topic: draftTopic,
              content: params.content,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Draft ${params.draftId} updated \u2705`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.draftId) {
              return {
                content: [
                  { type: "text", text: "Error: draftId is required for delete." },
                ],
              };
            }
            await deleteZulipDraft(client, params.draftId);
            return {
              content: [
                {
                  type: "text",
                  text: `Draft ${params.draftId} deleted \u2705`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${params.action}` },
              ],
            };
        }
      },
    });

    api.registerTool({
      name: "zulip_topics",
      description:
        "Manage Zulip topics: resolve/unresolve, rename, move to another stream, or delete. " +
        "Topics are central to Zulip's organization model. Resolving a topic marks it as done " +
        "with a ✔ prefix. Moving topics lets you reorganize conversations across streams.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          action: {
            type: "string",
            enum: ["resolve", "unresolve", "rename", "move", "delete"],
            description: "Action to perform",
          },
          streamName: {
            type: "string",
            description: "Current stream name where the topic lives (required for all actions)",
          },
          topic: {
            type: "string",
            description: "Current topic name (required for all actions)",
          },
          newTopic: {
            type: "string",
            description: "New topic name (for rename action)",
          },
          targetStreamName: {
            type: "string",
            description:
              "Destination stream name to move the topic into (for move action). " +
              "If omitted during move, the topic stays in the same stream but is renamed (equivalent to rename).",
          },
          propagateMode: {
            type: "string",
            enum: ["change_all", "change_later", "change_one"],
            description:
              "How to propagate topic changes (for resolve/unresolve/rename/move). " +
              "'change_all' = all messages in topic (default), " +
              "'change_later' = this and later messages, " +
              "'change_one' = only the anchor message.",
          },
        },
        required: ["action", "streamName", "topic"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);
        const propagateMode = params.propagateMode ?? "change_all";

        // Cached stream lookups to avoid repeated API calls within one execution
        let cachedSubscriptions: any[] | null = null;
        let cachedStreams: any[] | null = null;

        const findStreamByName = async (name: string) => {
          const lowerName = name.toLowerCase();

          if (!cachedSubscriptions) {
            cachedSubscriptions = await listZulipSubscriptions(client);
          }
          let found =
            cachedSubscriptions.find(
              (s) => s.name.toLowerCase() === lowerName,
            ) ?? null;

          if (!found) {
            if (!cachedStreams) {
              cachedStreams = await listZulipStreams(client);
            }
            found =
              cachedStreams.find(
                (s) => s.name.toLowerCase() === lowerName,
              ) ?? null;
          }

          return found;
        };

        // Resolve stream name to stream object
        const stream = await findStreamByName(params.streamName);
        if (!stream) {
          return {
            content: [
              {
                type: "text",
                text: `Error: stream "${params.streamName}" not found.`,
              },
            ],
          };
        }

        // For resolve/unresolve/rename/move we need a message ID in the topic
        // to use as an anchor for the PATCH /messages/{id} endpoint.
        const findAnchorMessage = async (): Promise<number | null> => {
          const result = await getZulipMessages(client, {
            anchor: "newest",
            numBefore: 1,
            numAfter: 0,
            narrow: [
              { operator: "stream", operand: params.streamName },
              { operator: "topic", operand: params.topic },
            ],
          });
          if (result.messages.length === 0) return null;
          return result.messages[0].id;
        };

        switch (params.action) {
          case "resolve": {
            const RESOLVED_PREFIX = "\u2714 ";
            if (params.topic.startsWith(RESOLVED_PREFIX)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Topic "${params.topic}" is already resolved.`,
                  },
                ],
              };
            }
            const msgId = await findAnchorMessage();
            if (msgId === null) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: no messages found in #${params.streamName} > ${params.topic}.`,
                  },
                ],
              };
            }
            const resolvedTopic = `${RESOLVED_PREFIX}${params.topic}`;
            await updateZulipMessage(client, msgId, {
              topic: resolvedTopic,
              propagateMode,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Topic resolved: #${params.streamName} > ${resolvedTopic} \u2705`,
                },
              ],
            };
          }

          case "unresolve": {
            const RESOLVED_PREFIX = "\u2714 ";
            if (!params.topic.startsWith(RESOLVED_PREFIX)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Topic "${params.topic}" is not resolved (no \u2714 prefix).`,
                  },
                ],
              };
            }
            const msgId = await findAnchorMessage();
            if (msgId === null) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: no messages found in #${params.streamName} > ${params.topic}.`,
                  },
                ],
              };
            }
            const unresolvedTopic = params.topic.slice(RESOLVED_PREFIX.length);
            await updateZulipMessage(client, msgId, {
              topic: unresolvedTopic,
              propagateMode,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Topic unresolved: #${params.streamName} > ${unresolvedTopic} \u2705`,
                },
              ],
            };
          }

          case "rename": {
            if (!params.newTopic) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: newTopic is required for rename.",
                  },
                ],
              };
            }
            const msgId = await findAnchorMessage();
            if (msgId === null) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: no messages found in #${params.streamName} > ${params.topic}.`,
                  },
                ],
              };
            }
            await updateZulipMessage(client, msgId, {
              topic: params.newTopic,
              propagateMode,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Topic renamed: #${params.streamName} > ${params.topic} \u2192 ${params.newTopic} \u2705`,
                },
              ],
            };
          }

          case "move": {
            if (!params.targetStreamName && !params.newTopic) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide targetStreamName and/or newTopic for move.",
                  },
                ],
              };
            }
            const msgId = await findAnchorMessage();
            if (msgId === null) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: no messages found in #${params.streamName} > ${params.topic}.`,
                  },
                ],
              };
            }

            // Build the PATCH body manually since updateZulipMessage
            // doesn't support stream_id changes
            const body = new URLSearchParams();
            if (params.newTopic) {
              body.set("topic", params.newTopic);
            }
            body.set("propagate_mode", propagateMode);

            let targetLabel = params.streamName;
            if (params.targetStreamName) {
              const targetStream = await findStreamByName(params.targetStreamName);
              if (!targetStream) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: target stream "${params.targetStreamName}" not found.`,
                    },
                  ],
                };
              }
              body.set("stream_id", String(targetStream.stream_id));
              targetLabel = params.targetStreamName;
            }

            await client.request<{ result: string }>(
              `/messages/${msgId}`,
              { method: "PATCH", body: body.toString() },
            );

            const finalTopic = params.newTopic ?? params.topic;
            const scopeLabel =
              propagateMode === "change_one" ? "Message moved" : "Topic moved";
            const scopeNote =
              propagateMode === "change_one"
                ? " (only the anchor message was moved; the topic may now be split)"
                : "";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `${scopeLabel}: #${params.streamName} > ${params.topic} ` +
                    `\u2192 #${targetLabel} > ${finalTopic}${scopeNote} \u2705`,
                },
              ],
            };
          }

          case "delete": {
            // Use the dedicated delete_topic endpoint which deletes all messages in the topic.
            // It processes in batches; this action performs a single batch per invocation.
            const result = await deleteZulipTopic(
              client,
              stream.stream_id,
              params.topic,
            );
            return {
              content: [
                {
                  type: "text",
                  text: result.complete
                    ? `Topic deleted: #${params.streamName} > ${params.topic} \u2705`
                    : `Topic deletion in progress (batch processed). ` +
                      `Some messages may remain; repeat the action to continue.`,
                },
              ],
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${params.action}` },
              ],
            };
        }
      },
    });

  },
};

export default plugin;
