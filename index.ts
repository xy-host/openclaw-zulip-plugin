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
        const client = getClient(cfg);

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
        const client = getClient(cfg);

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
        const client = getClient(cfg);

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
        const client = getClient(cfg);

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
              "Topic within the stream (for create/edit, required when targeting a stream).",
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
        const client = getClient(cfg);

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

            if (params.streamName) {
              // Need to resolve stream name to stream ID
              const streams = await listZulipStreams(client);
              const stream = streams.find(
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
              const result = await createZulipScheduledMessage(client, {
                type: "direct",
                to: [Number(params.userId)],
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
  },
};

export default plugin;
