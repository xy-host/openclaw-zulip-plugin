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
  subscribeUsersToZulipStream,
  unsubscribeUsersFromZulipStream,
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
  listZulipLinkifiers,
  addZulipLinkifier,
  updateZulipLinkifier,
  removeZulipLinkifier,
  reorderZulipLinkifiers,
  getZulipUserStatus,
  getZulipServerSettings,
  listZulipCustomProfileFields,
  getZulipUserProfileData,
  getProfileFieldTypeName,
  updateZulipOwnStatus,
  updateZulipMessageFlags,
  updateZulipMessageFlagsForNarrow,
  getZulipReadReceipts,
  uploadZulipFile,
  listZulipAlertWords,
  addZulipAlertWords,
  removeZulipAlertWords,
  updateZulipUserTopic,
  TOPIC_VISIBILITY_POLICIES,
  TOPIC_VISIBILITY_LABELS,
  listZulipMutedUsers,
  muteZulipUser,
  unmuteZulipUser,
  updateZulipSubscriptionProperties,
  listZulipAttachments,
  deleteZulipAttachment,
  getZulipMessageHistory,
  listZulipUserTopics,
  type ZulipSubscriptionProperty,
  sendZulipTyping,
  getZulipOwnUser,
  listZulipSavedSnippets,
  createZulipSavedSnippet,
  editZulipSavedSnippet,
  deleteZulipSavedSnippet,
  listZulipReminders,
  createZulipReminder,
  deleteZulipReminder,
  listZulipInvites,
  sendZulipInvites,
  createZulipInviteLink,
  revokeZulipInvite,
  revokeZulipInviteLink,
  resendZulipInvite,
  INVITE_AS_LABELS,
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

/**
 * Group reactions by emoji name, returning a Map of emoji → user IDs.
 * Shared helper used by both the compact summary formatter and the
 * detailed reactions action.
 */
function groupReactionsByEmoji(
  reactions: Array<{ emoji_name: string; user_id: number }>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const r of reactions) {
    const existing = groups.get(r.emoji_name);
    if (existing) {
      existing.push(r.user_id);
    } else {
      groups.set(r.emoji_name, [r.user_id]);
    }
  }
  return groups;
}

function formatReactionSummary(
  reactions?: Array<{ emoji_name: string; user_id: number }>,
): string {
  if (!reactions || reactions.length === 0) return "";
  const groups = groupReactionsByEmoji(reactions);
  const parts: string[] = [];
  for (const [emoji, userIds] of groups) {
    parts.push(`:${emoji}: \u00d7${userIds.length}`);
  }
  return parts.join("  ");
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
  reactions?: Array<{ emoji_name: string; user_id: number }>;
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
  const reactionLine = formatReactionSummary(msg.reactions);
  const base = `**[${msg.id}]** ${msg.sender_full_name} (${date}) in ${location}:\n${preview}`;
  return reactionLine ? `${base}\nReactions: ${reactionLine}` : base;
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
        "Also list topics and members of a stream, and subscribe/unsubscribe other users.",
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
              "subscribe_users",
              "unsubscribe_users",
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
            description: "Whether the stream is private (for create/update/subscribe_users)",
          },
          userIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of user IDs to subscribe or unsubscribe (for subscribe_users/unsubscribe_users). " +
              "Use zulip_users to find user IDs.",
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

          case "subscribe_users": {
            if (!params.name) {
              return {
                content: [{ type: "text", text: "Error: stream name is required." }],
              };
            }
            if (!params.userIds || !Array.isArray(params.userIds) || params.userIds.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userIds array with at least one user ID is required for subscribe_users.",
                  },
                ],
              };
            }
            const invalidIds = params.userIds.filter(
              (id: unknown) =>
                typeof id !== "number" ||
                !Number.isFinite(id) ||
                !Number.isInteger(id) ||
                (id as number) <= 0,
            );
            if (invalidIds.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: invalid user ID(s): ${JSON.stringify(invalidIds)}. All IDs must be positive integers.`,
                  },
                ],
              };
            }
            const uniqueUserIds = [...new Set(params.userIds as number[])];
            const subResult = await subscribeUsersToZulipStream(client, {
              name: params.name,
              userIds: uniqueUserIds,
              description: params.description,
              isPrivate: params.isPrivate,
            });
            const subscribedCount = Object.values(subResult.subscribed ?? {}).flat().length;
            const alreadyCount = Object.values(subResult.already_subscribed ?? {}).flat().length;
            const parts: string[] = [];
            if (subscribedCount > 0) {
              parts.push(`subscribed ${subscribedCount} user(s)`);
            }
            if (alreadyCount > 0) {
              parts.push(`${alreadyCount} already subscribed`);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Stream **${params.name}**: ${parts.join(", ") || "no changes"} ✅`,
                },
              ],
            };
          }

          case "unsubscribe_users": {
            if (!params.name) {
              return {
                content: [{ type: "text", text: "Error: stream name is required." }],
              };
            }
            if (!params.userIds || !Array.isArray(params.userIds) || params.userIds.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userIds array with at least one user ID is required for unsubscribe_users.",
                  },
                ],
              };
            }
            const invalidIds = params.userIds.filter(
              (id: unknown) =>
                typeof id !== "number" ||
                !Number.isFinite(id) ||
                !Number.isInteger(id) ||
                (id as number) <= 0,
            );
            if (invalidIds.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: invalid user ID(s): ${JSON.stringify(invalidIds)}. All IDs must be positive integers.`,
                  },
                ],
              };
            }
            const uniqueUserIds = [...new Set(params.userIds as number[])];
            await unsubscribeUsersFromZulipStream(client, params.name, uniqueUserIds);
            return {
              content: [
                {
                  type: "text",
                  text: `Unsubscribed ${uniqueUserIds.length} user(s) from **${params.name}** ✅`,
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
        "For streams: provide streamName and topic. " +
        "For 1:1 DMs: provide userId. " +
        "For group DMs (huddles): provide userIds array with multiple user IDs.",
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
            description:
              "User ID for a 1:1 direct message. Mutually exclusive with userIds and streamName.",
          },
          userIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of user IDs for a group DM (huddle). Must contain at least 2 distinct user IDs. " +
              "Mutually exclusive with userId and streamName. Use zulip_users to find user IDs.",
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

        // Validate mutual exclusivity of target parameters
        const targetCount = [params.streamName, params.userId, params.userIds].filter(Boolean).length;
        if (targetCount > 1) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide only one of streamName, userId, or userIds.",
              },
            ],
          };
        }

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
        } else if (params.userIds) {
          if (!Array.isArray(params.userIds) || params.userIds.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userIds must be an array with at least 2 user IDs for a group DM. For 1:1 DMs, use userId instead.",
                },
              ],
            };
          }
          const invalidIds = params.userIds.filter(
            (id: unknown) => typeof id !== "number" || !Number.isFinite(id) || id <= 0,
          );
          if (invalidIds.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: invalid user ID(s) in userIds: ${JSON.stringify(invalidIds)}. All IDs must be positive numbers.`,
                },
              ],
            };
          }
          // Deduplicate to ensure we have at least 2 distinct recipients
          const uniqueIds = [...new Set(params.userIds as number[])];
          if (uniqueIds.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userIds must contain at least 2 distinct user IDs for a group DM. For 1:1 DMs, use userId instead.",
                },
              ],
            };
          }
          const result = await sendZulipApiMessage(client, {
            type: "direct",
            to: JSON.stringify(uniqueIds),
            content: params.content,
          });
          return {
            content: [
              {
                type: "text",
                text: `Sent group DM to users [${uniqueIds.join(", ")}] (id:${result.id}) ✅`,
              },
            ],
          };
        } else if (params.userId) {
          const parsedUserId = Number(params.userId);
          if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userId must be a valid positive numeric user ID.",
                },
              ],
            };
          }
          const result = await sendZulipApiMessage(client, {
            type: "direct",
            to: JSON.stringify([parsedUserId]),
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
                text: "Error: provide streamName, userId, or userIds.",
              },
            ],
          };
        }
      },
    });

    api.registerTool({
      name: "zulip_users",
      description:
        "List, look up, or check presence of Zulip users, or get the bot's own user info. " +
        "Use to find user IDs for DMs, look up user details, check who is online, " +
        "or discover the bot's own user ID and profile.",
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
            enum: ["list", "get", "get_by_email", "presence", "get_own_user"],
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

          case "get_own_user": {
            const ownUser = await getZulipOwnUser(client);
            return {
              content: [
                {
                  type: "text",
                  text: formatUserDetails(ownUser),
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
        "Search, fetch, edit, delete Zulip messages, manage reactions, and view edit history. " +
        "Use to retrieve message history from streams/topics/DMs, look up a specific message, " +
        "edit or delete messages the bot has sent, add/remove emoji reactions, " +
        "list all reactions on a message (emoji names, counts, and reacting user IDs), " +
        "view the edit history of a message to see past versions and changes, " +
        "or forward a message to another stream/topic or DM with sender attribution. " +
        "Supports DM conversation search: use dmUserId for 1:1 DM history, " +
        "dmUserIds for group DM (huddle) history, or isDm to search across all DMs.",
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
              "reactions",
              "history",
              "forward",
            ],
            description: "Action to perform",
          },
          messageId: {
            type: "number",
            description: "Message ID (for get/edit/delete/add_reaction/remove_reaction/reactions/history/forward)",
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
          anchor: {
            type: "string",
            description:
              "Message ID or special value to anchor the search (for search). " +
              "Use a numeric message ID to fetch messages around that point, " +
              "'newest' (default) to start from the most recent, " +
              "'oldest' to start from the earliest, " +
              "or 'first_unread' to start from the first unread message. " +
              "Combine with 'before'/'after' for pagination.",
          },
          before: {
            type: "number",
            description:
              "Number of messages to fetch before the anchor (for search). " +
              "Default: equal to 'limit' when anchor is 'newest' or a message ID, 0 when anchor is 'oldest'. " +
              "Use with 'anchor' to paginate backwards through message history.",
          },
          after: {
            type: "number",
            description:
              "Number of messages to fetch after the anchor (for search). " +
              "Default: 0 when anchor is 'newest', equal to 'limit' when anchor is 'oldest'. " +
              "Use with 'anchor' to paginate forwards through message history.",
          },
          includeAnchor: {
            type: "boolean",
            description:
              "Whether to include the anchor message in results (for search, default: true when using a message ID anchor). " +
              "Set to false when paginating to avoid re-fetching the last seen message.",
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
          dmUserId: {
            type: "number",
            description:
              "Filter messages to a 1:1 DM conversation with this user ID (for search). " +
              "Adds a 'dm' narrow to show only messages between the bot and this user. " +
              "Mutually exclusive with streamName and dmUserIds.",
          },
          dmUserIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Filter messages to a group DM (huddle) with these user IDs (for search). " +
              "Must include all participants in the huddle (including the bot's own user ID). " +
              "Mutually exclusive with streamName and dmUserId.",
          },
          isDm: {
            type: "boolean",
            description:
              "Filter to only DM messages (for search). When true, narrows to all DM conversations " +
              "(both 1:1 and group). Use dmUserId or dmUserIds instead for a specific conversation. " +
              "Mutually exclusive with streamName, dmUserId, and dmUserIds.",
          },
          forwardTo: {
            type: "string",
            description:
              "Target for forwarding a message (for forward action). " +
              "For streams: provide the stream name (also set forwardTopic). " +
              "For DMs: provide as 'dm:<userId>' (e.g. 'dm:12345').",
          },
          forwardTopic: {
            type: "string",
            description:
              "Topic in the target stream to forward the message to (for forward action, when forwarding to a stream). " +
              "If omitted when forwarding to a stream, defaults to '(no topic)'.",
          },
          includeAttribution: {
            type: "boolean",
            description:
              "Whether to include attribution header when forwarding (for forward action, default: true). " +
              "When true, the forwarded message includes the original sender, timestamp, and location.",
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
            // Validate mutual exclusivity of stream vs DM filters
            const hasStreamFilter = Boolean(params.streamName);
            const hasDmUserFilter = params.dmUserId !== undefined;
            const hasDmUsersFilter = Array.isArray(params.dmUserIds) && params.dmUserIds.length > 0;
            const hasDmFilter = params.isDm === true;
            if (hasStreamFilter && (hasDmUserFilter || hasDmUsersFilter || hasDmFilter)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: streamName cannot be combined with dmUserId, dmUserIds, or isDm. Use one conversation filter type.",
                  },
                ],
              };
            }
            if ([hasDmUserFilter, hasDmUsersFilter, hasDmFilter].filter(Boolean).length > 1) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: dmUserId, dmUserIds, and isDm are mutually exclusive. Use only one DM filter.",
                  },
                ],
              };
            }
            if (params.topic && (hasDmUserFilter || hasDmUsersFilter || hasDmFilter)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: topic cannot be combined with DM filters (dmUserId, dmUserIds, isDm). DMs do not have topics in Zulip.",
                  },
                ],
              };
            }

            const narrow: Array<{ operator: string; operand: string | number }> = [];
            if (params.streamName) {
              narrow.push({ operator: "stream", operand: params.streamName });
            }
            if (params.topic) {
              narrow.push({ operator: "topic", operand: params.topic });
            }
            if (params.dmUserId !== undefined) {
              const dmId = Number(params.dmUserId);
              if (!Number.isFinite(dmId) || !Number.isInteger(dmId) || dmId <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: dmUserId must be a valid positive integer.",
                    },
                  ],
                };
              }
              narrow.push({ operator: "dm", operand: String(dmId) });
            }
            if (Array.isArray(params.dmUserIds) && params.dmUserIds.length > 0) {
              const invalidIds = params.dmUserIds.filter(
                (id: unknown) =>
                  typeof id !== "number" ||
                  !Number.isFinite(id) ||
                  !Number.isInteger(id) ||
                  (id as number) <= 0,
              );
              if (invalidIds.length > 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: invalid user ID(s) in dmUserIds: ${JSON.stringify(invalidIds)}. All IDs must be positive integers.`,
                    },
                  ],
                };
              }
              // Zulip dm narrow with multiple users: comma-separated user IDs
              const uniqueIds = [...new Set(params.dmUserIds as number[])];
              narrow.push({ operator: "dm", operand: uniqueIds.join(",") });
            }
            if (params.isDm === true) {
              narrow.push({ operator: "is", operand: "dm" });
            }
            if (params.senderId) {
              narrow.push({ operator: "sender", operand: params.senderId });
            }
            if (params.query) {
              narrow.push({ operator: "search", operand: params.query });
            }

            const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

            // Resolve anchor — default to "newest" for backwards compat
            const rawAnchor = params.anchor?.toString().trim() ?? "newest";
            const anchor: string | number =
              rawAnchor === "newest" || rawAnchor === "oldest" || rawAnchor === "first_unread"
                ? rawAnchor
                : Number(rawAnchor) || "newest";

            // Resolve numBefore / numAfter based on anchor direction
            let numBefore: number;
            let numAfter: number;
            if (params.before !== undefined || params.after !== undefined) {
              const rawBefore = Math.min(Math.max(params.before ?? 0, 0), 100);
              const rawAfter = Math.min(Math.max(params.after ?? 0, 0), 100);
              const totalRequested = rawBefore + rawAfter;
              // Enforce total does not exceed limit to avoid surprising response sizes
              if (totalRequested <= limit) {
                numBefore = rawBefore;
                numAfter = rawAfter;
              } else {
                // Proportionally scale down to fit within limit
                const scale = limit / totalRequested;
                numBefore = Math.floor(rawBefore * scale);
                numAfter = Math.floor(rawAfter * scale);
                const remaining = limit - (numBefore + numAfter);
                if (remaining > 0) {
                  if (rawBefore >= rawAfter) {
                    numBefore += remaining;
                  } else {
                    numAfter += remaining;
                  }
                }
              }
            } else if (anchor === "oldest") {
              numBefore = 0;
              numAfter = limit;
            } else {
              // "newest", "first_unread", or a message ID
              numBefore = limit;
              numAfter = 0;
            }

            const result = await getZulipMessages(client, {
              anchor,
              numBefore,
              numAfter,
              narrow: narrow.length > 0 ? narrow : undefined,
              includeAnchor: params.includeAnchor,
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

            // Build pagination info for the agent
            const paginationParts: string[] = [];
            if (result.found_oldest) {
              paginationParts.push("⬆ Reached oldest message");
            }
            if (result.found_newest) {
              paginationParts.push("⬇ Reached newest message");
            }
            if (messages.length > 0) {
              const oldestMsg = messages[0];
              const newestMsg = messages[messages.length - 1];
              if (!result.found_oldest) {
                paginationParts.push(
                  `To load older: use anchor="${oldestMsg.id}", before=${limit}, after=0, includeAnchor=false`,
                );
              }
              if (!result.found_newest) {
                paginationParts.push(
                  `To load newer: use anchor="${newestMsg.id}", before=0, after=${limit}, includeAnchor=false`,
                );
              }
            }
            const paginationInfo =
              paginationParts.length > 0
                ? `\n\n---\n📄 **Pagination**: ${paginationParts.join(" | ")}`
                : "";

            return {
              content: [
                {
                  type: "text",
                  text: `${messages.length} message(s) found:\n\n${lines.join("\n\n---\n\n")}${paginationInfo}`,
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

          case "reactions": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for reactions.",
                  },
                ],
              };
            }
            const msg = await getZulipSingleMessage(client, params.messageId);
            const reactions = msg.reactions;
            if (!reactions || reactions.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No reactions on message ${params.messageId}.`,
                  },
                ],
              };
            }

            // Use shared grouping helper
            const groups = groupReactionsByEmoji(reactions);

            const lines: string[] = [];
            for (const [emoji, userIds] of groups) {
              lines.push(
                `:${emoji}: (${userIds.length}) — user IDs: ${userIds.join(", ")}`,
              );
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Reactions on message ${params.messageId} (${reactions.length} total):\n\n` +
                    lines.join("\n") +
                    "\n\nUse zulip_users \u2192 get to look up user details by ID.",
                },
              ],
            };
          }

          case "history": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for history.",
                  },
                ],
              };
            }
            const history = await getZulipMessageHistory(client, params.messageId);
            if (history.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No edit history found for message ${params.messageId} (edit history may be disabled by the organization).`,
                  },
                ],
              };
            }

            const lines: string[] = [];
            for (let i = 0; i < history.length; i++) {
              const entry = history[i];
              const date = new Date(entry.timestamp * 1000).toISOString();
              const editor = entry.user_id != null ? `user ${entry.user_id}` : "unknown";

              if (i === 0) {
                // First entry is the original message
                const contentPreview = (entry.content ?? "(no content)")
                  .slice(0, 500);
                const topicInfo = entry.topic ? ` | Topic: ${entry.topic}` : "";
                lines.push(
                  `**Original** (${date}) by ${editor}${topicInfo}:\n${contentPreview}`,
                );
              } else {
                // Subsequent entries are edits
                const parts: string[] = [];
                if (entry.prev_content !== undefined && entry.content !== undefined) {
                  const prevPreview = entry.prev_content.slice(0, 300);
                  const newPreview = entry.content.slice(0, 300);
                  parts.push(`Content changed:\n  Before: ${prevPreview}\n  After: ${newPreview}`);
                }
                if (entry.prev_topic !== undefined && entry.topic !== undefined) {
                  parts.push(`Topic changed: "${entry.prev_topic}" → "${entry.topic}"`);
                }
                if (entry.prev_stream !== undefined && entry.stream !== undefined) {
                  parts.push(`Stream changed: ${entry.prev_stream} → ${entry.stream}`);
                }
                if (parts.length === 0) {
                  parts.push("(metadata-only change)");
                }
                lines.push(
                  `**Edit ${i}** (${date}) by ${editor}:\n${parts.join("\n")}`,
                );
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Edit history for message ${params.messageId} (${history.length} version${history.length > 1 ? "s" : ""}):\n\n` +
                    lines.join("\n\n---\n\n"),
                },
              ],
            };
          }

          case "forward": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for forward.",
                  },
                ],
              };
            }
            if (!params.forwardTo) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: forwardTo is required for forward. " +
                      "Provide a stream name (with optional forwardTopic) or \"dm:<userId>\" for a DM.",
                  },
                ],
              };
            }

            // Fetch the original message
            const origMsg = await getZulipSingleMessage(client, params.messageId);
            const origDate = new Date(origMsg.timestamp * 1000).toISOString();
            const origLocation =
              origMsg.type === "stream"
                ? `#**${typeof origMsg.display_recipient === "string" ? origMsg.display_recipient : "?"}>${origMsg.subject}**`
                : "a DM";

            // Build forwarded content with optional attribution
            const includeAttribution = params.includeAttribution !== false;
            let forwardContent: string;
            if (includeAttribution) {
              forwardContent =
                `**Forwarded message** from **${origMsg.sender_full_name}** ` +
                `(${origDate}) in ${origLocation}:\n` +
                `\n---\n\n` +
                origMsg.content;
            } else {
              forwardContent = origMsg.content;
            }

            // Determine target
            const forwardToTrimmed = params.forwardTo.trim();
            const isDmTarget = forwardToTrimmed.toLowerCase().startsWith("dm:");
            if (isDmTarget) {
              const prefix = forwardToTrimmed.indexOf(":");
              const rawId = forwardToTrimmed.slice(prefix + 1).trim();
              const userId = Number(rawId);
              if (!Number.isFinite(userId) || userId <= 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Error: forwardTo DM target must be a valid positive user ID (e.g. \"dm:12345\").",
                    },
                  ],
                };
              }
              const fwdResult = await sendZulipApiMessage(client, {
                type: "direct",
                to: JSON.stringify([userId]),
                content: forwardContent,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Forwarded message ${params.messageId} to DM with user ${userId} ` +
                      `(new message id:${fwdResult.id}) \u2705`,
                  },
                ],
              };
            } else {
              // Stream target
              const topic = params.forwardTopic ?? "(no topic)";
              const fwdResult = await sendZulipApiMessage(client, {
                type: "stream",
                to: forwardToTrimmed,
                topic,
                content: forwardContent,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Forwarded message ${params.messageId} to #${forwardToTrimmed} > ${topic} ` +
                      `(new message id:${fwdResult.id}) \u2705`,
                  },
                ],
              };
            }
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
              "e.g. '2099-12-31T09:00:00Z'. Must be in the future.",
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


    api.registerTool({
      name: "zulip_linkifiers",
      description:
        "List, add, update, remove, or reorder linkifiers (auto-linking patterns) in the Zulip organization. " +
        "Linkifiers automatically convert text patterns in messages and topics into clickable links. " +
        "For example, a pattern like '#(?P<id>[0-9]+)' with a URL template " +
        "'https://github.com/org/repo/issues/{id}' will auto-link '#123' to the corresponding GitHub issue.",
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
            enum: ["list", "add", "update", "remove", "reorder"],
            description: "Action to perform",
          },
          filterId: {
            type: "number",
            description:
              "Linkifier ID (for update/remove). Use 'list' to find IDs.",
          },
          pattern: {
            type: "string",
            description:
              "Regular expression pattern using re2 syntax (for add/update). " +
              "Use named groups like (?P<id>[0-9]+) to capture values for the URL template.",
          },
          urlTemplate: {
            type: "string",
            description:
              "URL template using RFC 6570 syntax (for add/update). " +
              "Reference named groups from the pattern, e.g. 'https://github.com/org/repo/issues/{id}'.",
          },
          orderedIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of all linkifier IDs in the desired order (for reorder). " +
              "Must include every existing linkifier ID exactly once.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const linkifiers = await listZulipLinkifiers(client);
            if (linkifiers.length === 0) {
              return {
                content: [
                  { type: "text", text: "No linkifiers configured." },
                ],
              };
            }
            const lines = linkifiers.map(
              (lf, idx) =>
                `${idx + 1}. **[${lf.id}]** \`${lf.pattern}\` → ${lf.url_template}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `${linkifiers.length} linkifier(s):\n\n${lines.join("\n")}`,
                },
              ],
            };
          }

          case "add": {
            if (!params.pattern) {
              return {
                content: [
                  { type: "text", text: "Error: pattern is required for add." },
                ],
              };
            }
            if (!params.urlTemplate) {
              return {
                content: [
                  { type: "text", text: "Error: urlTemplate is required for add." },
                ],
              };
            }
            const result = await addZulipLinkifier(client, {
              pattern: params.pattern,
              urlTemplate: params.urlTemplate,
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Linkifier added [${result.id}] ✅\n` +
                    `Pattern: \`${params.pattern}\`\n` +
                    `URL template: ${params.urlTemplate}`,
                },
              ],
            };
          }

          case "update": {
            if (params.filterId == null || typeof params.filterId !== "number") {
              return {
                content: [
                  { type: "text", text: "Error: filterId is required for update." },
                ],
              };
            }
            if (!params.pattern) {
              return {
                content: [
                  { type: "text", text: "Error: pattern is required for update." },
                ],
              };
            }
            if (!params.urlTemplate) {
              return {
                content: [
                  { type: "text", text: "Error: urlTemplate is required for update." },
                ],
              };
            }
            await updateZulipLinkifier(client, params.filterId, {
              pattern: params.pattern,
              urlTemplate: params.urlTemplate,
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Linkifier [${params.filterId}] updated ✅\n` +
                    `Pattern: \`${params.pattern}\`\n` +
                    `URL template: ${params.urlTemplate}`,
                },
              ],
            };
          }

          case "remove": {
            if (params.filterId == null || typeof params.filterId !== "number") {
              return {
                content: [
                  { type: "text", text: "Error: filterId is required for remove." },
                ],
              };
            }
            await removeZulipLinkifier(client, params.filterId);
            return {
              content: [
                {
                  type: "text",
                  text: `Linkifier [${params.filterId}] removed ✅`,
                },
              ],
            };
          }

          case "reorder": {
            if (!params.orderedIds || !Array.isArray(params.orderedIds) || params.orderedIds.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: orderedIds array is required for reorder. Must include all linkifier IDs.",
                  },
                ],
              };
            }
            await reorderZulipLinkifiers(client, params.orderedIds);
            return {
              content: [
                {
                  type: "text",
                  text: `Linkifiers reordered ✅ (new order: ${params.orderedIds.join(", ")})`,
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
      name: "zulip_user_status",
      description:
        "Get or update user status in Zulip. " +
        "User status includes a text message and an optional emoji, shown next to the user's name. " +
        "Use to check what someone is up to, set the bot's own status, or clear the status.",
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
            enum: ["get", "set", "clear"],
            description: "Action to perform",
          },
          userId: {
            type: "number",
            description:
              "User ID to get status for (for get action). Use zulip_users to find user IDs.",
          },
          statusText: {
            type: "string",
            description:
              "Status text to display (for set action, max 60 characters). " +
              "E.g. 'In a meeting', 'Working from home', 'On vacation'.",
          },
          emojiName: {
            type: "string",
            description:
              "Emoji name without colons to display alongside the status (for set action). " +
              "E.g. 'calendar', 'house', 'palm_tree', 'coffee'. " +
              "Use standard Unicode emoji names or custom emoji names.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "get": {
            if (!params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userId is required for get.",
                  },
                ],
              };
            }
            const status = await getZulipUserStatus(client, params.userId);
            if (!status.status_text && !status.emoji_name) {
              return {
                content: [
                  {
                    type: "text",
                    text: `User ${params.userId} has no status set.`,
                  },
                ],
              };
            }
            const parts: string[] = [];
            if (status.emoji_name) {
              parts.push(`Emoji: :${status.emoji_name}:`);
            }
            if (status.status_text) {
              parts.push(`Text: "${status.status_text}"`);
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Status for user ${params.userId}:\n${parts.join("\n")}`,
                },
              ],
            };
          }

          case "set": {
            if (!params.statusText && !params.emojiName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide statusText and/or emojiName for set.",
                  },
                ],
              };
            }
            if (params.statusText && params.statusText.length > 60) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: statusText must be 60 characters or fewer.",
                  },
                ],
              };
            }
            await updateZulipOwnStatus(client, {
              statusText: params.statusText,
              emojiName: params.emojiName,
            });
            const desc: string[] = [];
            if (params.emojiName) desc.push(`:${params.emojiName}:`);
            if (params.statusText) desc.push(`"${params.statusText}"`);
            return {
              content: [
                {
                  type: "text",
                  text: `Status updated to ${desc.join(" ")} \u2705`,
                },
              ],
            };
          }

          case "clear": {
            await updateZulipOwnStatus(client, {
              statusText: "",
              emojiName: "",
            });
            return {
              content: [
                {
                  type: "text",
                  text: "Status cleared \u2705",
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
      name: "zulip_server_settings",
      description:
        "Query Zulip server and organization information, list custom profile fields, " +
        "or get a user's custom profile data. Use to check the server version and feature level, " +
        "discover organization settings, or retrieve custom profile fields like team, role, " +
        "phone number, or pronouns for any user.",
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
            enum: ["server_info", "profile_fields", "user_profile"],
            description:
              "Action to perform: 'server_info' returns server version, feature level, " +
              "and organization metadata; 'profile_fields' lists custom profile fields " +
              "configured for the organization; 'user_profile' returns a specific user's " +
              "custom profile data.",
          },
          userId: {
            type: "number",
            description:
              "User ID to get custom profile data for (required for 'user_profile' action). " +
              "Use zulip_users to find user IDs.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "server_info": {
            const settings = await getZulipServerSettings(client);
            const lines: string[] = [
              `**Zulip Server Info**`,
              `- Version: ${settings.zulip_version}`,
              `- Feature level: ${settings.zulip_feature_level}`,
            ];
            if (settings.zulip_merge_base) {
              lines.push(`- Merge base: ${settings.zulip_merge_base}`);
            }
            lines.push(
              `- Push notifications: ${settings.push_notifications_enabled ? "Enabled" : "Disabled"}`,
            );
            if (settings.realm_name) {
              lines.push(`- Organization: ${settings.realm_name}`);
            }
            if (settings.realm_description) {
              lines.push(`- Description: ${settings.realm_description}`);
            }
            if (settings.realm_uri) {
              lines.push(`- URL: ${settings.realm_uri}`);
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
            };
          }

          case "profile_fields": {
            const fields = await listZulipCustomProfileFields(client);
            if (fields.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No custom profile fields configured for this organization.",
                  },
                ],
              };
            }
            const lines = fields.map((f) => {
              const typeName = getProfileFieldTypeName(f.type);
              const hint = f.hint ? ` — hint: "${f.hint}"` : "";
              const summary = f.display_in_profile_summary
                ? " ⭐"
                : "";
              let options = "";
              if (f.type === 3 && f.field_data) {
                try {
                  const parsed = JSON.parse(f.field_data) as Record<
                    string,
                    { text: string; order: string }
                  >;
                  const optList = Object.values(parsed)
                    .sort((a, b) => Number(a.order) - Number(b.order))
                    .map((o) => o.text);
                  if (optList.length > 0) {
                    options = ` [${optList.join(", ")}]`;
                  }
                } catch {
                  // ignore parse errors
                }
              }
              return `- **${f.name}** (id:${f.id}, type: ${typeName})${hint}${options}${summary}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `${fields.length} custom profile field(s):\n${lines.join("\n")}`,
                },
              ],
            };
          }

          case "user_profile": {
            if (!params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userId is required for user_profile.",
                  },
                ],
              };
            }
            // Fetch profile fields and user data in parallel
            const [fields, profileData] = await Promise.all([
              listZulipCustomProfileFields(client),
              getZulipUserProfileData(client, params.userId),
            ]);
            const fieldMap = new Map(fields.map((f) => [String(f.id), f]));
            const entries = Object.entries(profileData);
            if (entries.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `User ${params.userId} has no custom profile data set.`,
                  },
                ],
              };
            }
            const lines = entries
              .map(([fieldId, data]) => {
                const field = fieldMap.get(fieldId);
                const label = field ? field.name : `Field ${fieldId}`;
                const value = data.rendered_value ?? data.value;
                return `- **${label}**: ${value}`;
              })
              .filter(Boolean);
            return {
              content: [
                {
                  type: "text",
                  text: `Custom profile data for user ${params.userId}:\n${lines.join("\n")}`,
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
      name: "zulip_message_flags",
      description:
        "Manage personal message flags (star, read) and check read receipts in Zulip. " +
        "Use to star/unstar important messages, mark messages or entire topics as read/unread, " +
        "or check which users have read a specific message.",
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
              "star",
              "unstar",
              "mark_read",
              "mark_unread",
              "mark_topic_read",
              "mark_all_read",
              "read_receipts",
            ],
            description:
              "Action to perform: " +
              "'star' adds the starred flag to messages, " +
              "'unstar' removes it, " +
              "'mark_read' marks specific messages as read, " +
              "'mark_unread' marks them as unread, " +
              "'mark_topic_read' marks all messages in a stream/topic as read, " +
              "'mark_all_read' marks all messages as read for the current bot account, " +
              "'read_receipts' returns user IDs who have read a message.",
          },
          messageIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of message IDs to operate on (for star/unstar/mark_read/mark_unread). " +
              "Max 100 per call.",
          },
          messageId: {
            type: "number",
            description:
              "Single message ID (for read_receipts).",
          },
          streamName: {
            type: "string",
            description:
              "Stream name to mark as read (for mark_topic_read). " +
              "If topic is also provided, only that topic is marked read.",
          },
          topic: {
            type: "string",
            description:
              "Topic name within the stream (for mark_topic_read). " +
              "If omitted, all messages in the stream are marked as read.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "star": {
            if (!params.messageIds || params.messageIds.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: messageIds array is required for star." },
                ],
              };
            }
            if (params.messageIds.length > 100) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Error: messageIds array may contain at most 100 IDs per call. " +
                      "Please split the request into multiple calls.",
                  },
                ],
              };
            }
            const result = await updateZulipMessageFlags(client, {
              messages: params.messageIds,
              op: "add",
              flag: "starred",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Starred ${result.messages.length} message(s) \u2B50 \u2705`,
                },
              ],
            };
          }

          case "unstar": {
            if (!params.messageIds || params.messageIds.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: messageIds array is required for unstar." },
                ],
              };
            }
            if (params.messageIds.length > 100) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Error: messageIds array may contain at most 100 IDs per call. " +
                      "Please split the request into multiple calls.",
                  },
                ],
              };
            }
            const result = await updateZulipMessageFlags(client, {
              messages: params.messageIds,
              op: "remove",
              flag: "starred",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Unstarred ${result.messages.length} message(s) \u2705`,
                },
              ],
            };
          }

          case "mark_read": {
            if (!params.messageIds || params.messageIds.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: messageIds array is required for mark_read." },
                ],
              };
            }
            if (params.messageIds.length > 100) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Error: messageIds array may contain at most 100 IDs per call. " +
                      "Please split the request into multiple calls.",
                  },
                ],
              };
            }
            const result = await updateZulipMessageFlags(client, {
              messages: params.messageIds,
              op: "add",
              flag: "read",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Marked ${result.messages.length} message(s) as read \u2705`,
                },
              ],
            };
          }

          case "mark_unread": {
            if (!params.messageIds || params.messageIds.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: messageIds array is required for mark_unread." },
                ],
              };
            }
            if (params.messageIds.length > 100) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Error: messageIds array may contain at most 100 IDs per call. " +
                      "Please split the request into multiple calls.",
                  },
                ],
              };
            }
            const result = await updateZulipMessageFlags(client, {
              messages: params.messageIds,
              op: "remove",
              flag: "read",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Marked ${result.messages.length} message(s) as unread \u2705`,
                },
              ],
            };
          }

          case "mark_topic_read": {
            if (!params.streamName) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: streamName is required for mark_topic_read.",
                  },
                ],
              };
            }

            const narrow: Array<{ operator: string; operand: string | number }> = [
              { operator: "stream", operand: params.streamName },
            ];
            if (params.topic) {
              narrow.push({ operator: "topic", operand: params.topic });
            }

            let totalUpdated = 0;
            let done = false;

            // Start from the oldest message and paginate forward
            let anchor: number | "oldest" = "oldest";
            let includeAnchor = true;

            // Process in batches since the API may not cover all messages in one call
            while (!done) {
              const result = await updateZulipMessageFlagsForNarrow(client, {
                anchor,
                numBefore: 0,
                numAfter: 5000,
                narrow,
                op: "add",
                flag: "read",
                includeAnchor,
              });
              totalUpdated += result.updated_count;
              done = result.found_newest;
              if (result.processed_count === 0) break;
              // Advance the anchor to page forward and avoid re-processing
              if (!done && typeof result.last_processed_id === "number") {
                anchor = result.last_processed_id;
                includeAnchor = false;
              }
            }

            const target = params.topic
              ? `#${params.streamName} > ${params.topic}`
              : `#${params.streamName}`;
            return {
              content: [
                {
                  type: "text",
                  text: `Marked ${totalUpdated} message(s) as read in ${target} \u2705`,
                },
              ],
            };
          }

          case "mark_all_read": {
            let totalUpdatedAll = 0;
            let doneAll = false;

            // Use an empty narrow to match all messages visible to this user/bot
            let anchorAll: number | "oldest" = "oldest";
            let includeAnchorAll = true;

            while (!doneAll) {
              const result = await updateZulipMessageFlagsForNarrow(client, {
                anchor: anchorAll,
                numBefore: 0,
                numAfter: 5000,
                narrow: [],
                op: "add",
                flag: "read",
                includeAnchor: includeAnchorAll,
              });
              totalUpdatedAll += result.updated_count;
              doneAll = result.found_newest;
              if (result.processed_count === 0) break;
              if (!doneAll && typeof result.last_processed_id === "number") {
                anchorAll = result.last_processed_id;
                includeAnchorAll = false;
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Marked ${totalUpdatedAll} message(s) as read for the current account \u2705`,
                },
              ],
            };
          }

          case "read_receipts": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for read_receipts.",
                  },
                ],
              };
            }
            const userIds = await getZulipReadReceipts(client, params.messageId);
            if (userIds.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No read receipts for message ${params.messageId} (read receipts may be disabled by the organization or no users have read it yet).`,
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Message ${params.messageId} has been read by ${userIds.length} user(s): ` +
                    `${userIds.join(", ")} \u2705\n\n` +
                    `Use zulip_users \u2192 get to look up user details by ID.`,
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
      name: "zulip_upload",
      description:
        "Upload a file to the Zulip server and get a shareable URI. " +
        "Use to share images, documents, or other files in Zulip messages. " +
        "The returned URI can be embedded in messages using Zulip markdown: [filename](uri). " +
        "Accepts a public URL to fetch the file from, or a base64-encoded file.",
      parameters: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description:
              "Zulip account ID to use (for multi-account setups). Defaults to the primary account.",
          },
          url: {
            type: "string",
            description:
              "Public URL of the file to download and upload to Zulip. " +
              "Supports any file type (images, PDFs, documents, etc.).",
          },
          base64: {
            type: "string",
            description:
              "Base64-encoded file content. Use when the file is not available via URL. " +
              "Mutually exclusive with url.",
          },
          fileName: {
            type: "string",
            description:
              "Name for the uploaded file (e.g. report.pdf, screenshot.png). " +
              "If omitted, a name is derived from the URL or defaults to upload.",
          },
          contentType: {
            type: "string",
            description:
              "MIME type of the file (e.g. image/png, application/pdf). " +
              "If omitted, it is inferred from the URL response headers (for url) " +
              "or from the base64/data URI metadata (for base64), when available.",
          },
        },
        required: [],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        if (!params.url && !params.base64) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide either url or base64 to upload a file.",
              },
            ],
          };
        }
        if (params.url && params.base64) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide only one of url or base64, not both.",
              },
            ],
          };
        }

        let fileBuffer: Buffer;
        let fileName = params.fileName?.trim() || undefined;
        let contentType = params.contentType?.trim() || undefined;

        if (params.base64) {
          // Decode base64
          try {
            // Support data: URI format
            let raw = params.base64;
            if (raw.startsWith("data:")) {
              const commaIdx = raw.indexOf(",");
              if (commaIdx >= 0) {
                const meta = raw.slice(5, commaIdx);
                const mimePart = meta.split(";")[0];
                if (mimePart && !contentType) contentType = mimePart;
                raw = raw.slice(commaIdx + 1);
              }
            }

            // Basic base64 validation
            const stripped = raw.replace(/\s/g, "");
            const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
            if (!stripped || stripped.length % 4 !== 0 || !base64Regex.test(stripped)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: invalid base64 content provided for file upload.",
                  },
                ],
              };
            }

            fileBuffer = Buffer.from(stripped, "base64");
            if (fileBuffer.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: base64 content decoded to an empty file.",
                  },
                ],
              };
            }
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: failed to decode base64 content: ${String(err)}`,
                },
              ],
            };
          }
          if (!fileName) fileName = "upload";
        } else {
          // Validate URL protocol to prevent SSRF
          try {
            const parsedUrl = new URL(params.url);
            if (!["http:", "https:"].includes(parsedUrl.protocol)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: only http and https URLs are supported.",
                  },
                ],
              };
            }
          } catch {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: invalid URL provided.",
                },
              ],
            };
          }

          // Fetch from URL
          try {
            const response = await fetch(params.url);
            if (!response.ok) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: failed to fetch file from URL (HTTP ${response.status}).`,
                  },
                ],
              };
            }
            if (!contentType) {
              const ct = response.headers.get("content-type");
              if (ct) contentType = ct.split(";")[0].trim();
            }
            // Check Content-Length before downloading if available
            const contentLength = response.headers.get("content-length");
            const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25 MB
            if (contentLength && Number(contentLength) > MAX_UPLOAD_SIZE) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: file too large (${(Number(contentLength) / 1024 / 1024).toFixed(1)} MB). Maximum upload size is 25 MB.`,
                  },
                ],
              };
            }

            const arrayBuffer = await response.arrayBuffer();
            fileBuffer = Buffer.from(arrayBuffer);

            // Enforce max size after download (Content-Length may be absent)
            if (fileBuffer.length > MAX_UPLOAD_SIZE) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: file too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB). Maximum upload size is 25 MB.`,
                  },
                ],
              };
            }

            // Derive file name from URL if not provided
            if (!fileName) {
              try {
                const urlPath = new URL(params.url).pathname;
                const segments = urlPath.split("/").filter(Boolean);
                const lastSegment = segments.pop();
                if (lastSegment) {
                  fileName = decodeURIComponent(lastSegment);
                }
              } catch {
                // ignore URL parsing errors
              }
              if (!fileName) fileName = "upload";
            }
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: failed to fetch file from URL: ${String(err)}`,
                },
              ],
            };
          }
        }

        // Add extension to fileName if missing and contentType is known
        if (fileName && !fileName.includes(".") && contentType) {
          const extMap: Record<string, string> = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/svg+xml": ".svg",
            "application/pdf": ".pdf",
            "text/plain": ".txt",
            "text/csv": ".csv",
            "application/json": ".json",
            "application/zip": ".zip",
          };
          const ext = extMap[contentType];
          if (ext) fileName += ext;
        }

        try {
          const result = await uploadZulipFile(
            client,
            fileBuffer,
            fileName ?? "upload",
            contentType,
          );

          const sizeKB = (fileBuffer.length / 1024).toFixed(1);
          const markdownLink = `[${fileName ?? "upload"}](${result.uri})`;

          return {
            content: [
              {
                type: "text",
                text:
                  `File uploaded \u2705\n` +
                  `- **Name**: ${fileName ?? "upload"}\n` +
                  `- **Size**: ${sizeKB} KB\n` +
                  `- **Type**: ${contentType ?? "unknown"}\n` +
                  `- **URI**: ${result.uri}\n\n` +
                  `Use in messages: \`${markdownLink}\``,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: failed to upload file to Zulip: ${String(err)}`,
              },
            ],
          };
        }
      },
    });

    api.registerTool({
      name: "zulip_alert_words",
      description:
        "List, add, or remove alert words for the Zulip bot user. " +
        "Alert words trigger notifications whenever any message in the organization " +
        "contains one of these words/phrases, similar to an @mention. " +
        "Use to monitor specific keywords, project names, or topics of interest.",
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
            enum: ["list", "add", "remove"],
            description: "Action to perform",
          },
          words: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of alert words/phrases to add or remove (for add/remove actions). " +
              "Alert words are case-insensitive and can be multi-word phrases.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const words = await listZulipAlertWords(client);
            if (words.length === 0) {
              return {
                content: [
                  { type: "text", text: "No alert words configured." },
                ],
              };
            }
            const lines = words.map((w) => `- ${w}`);
            return {
              content: [
                {
                  type: "text",
                  text: `${words.length} alert word(s):\n${lines.join("\n")}`,
                },
              ],
            };
          }

          case "add": {
            if (!params.words || !Array.isArray(params.words) || params.words.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: words array is required for add. Provide one or more words/phrases.",
                  },
                ],
              };
            }
            const filtered = params.words
              .map((w: string) => w.trim())
              .filter((w: string) => w.length > 0);
            if (filtered.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: all provided words are empty after trimming.",
                  },
                ],
              };
            }
            const updatedWords = await addZulipAlertWords(client, filtered);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Added ${filtered.length} alert word(s): ${filtered.map((w: string) => `"${w}"`).join(", ")} ✅\n` +
                    `Total alert words: ${updatedWords.length}`,
                },
              ],
            };
          }

          case "remove": {
            if (!params.words || !Array.isArray(params.words) || params.words.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: words array is required for remove. Provide one or more words/phrases to remove.",
                  },
                ],
              };
            }
            const filtered = params.words
              .map((w: string) => w.trim())
              .filter((w: string) => w.length > 0);
            if (filtered.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: all provided words are empty after trimming.",
                  },
                ],
              };
            }
            const updatedWords = await removeZulipAlertWords(client, filtered);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Removed ${filtered.length} alert word(s): ${filtered.map((w: string) => `"${w}"`).join(", ")} ✅\n` +
                    `Remaining alert words: ${updatedWords.length}`,
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
      name: "zulip_user_preferences",
      description:
        "Manage personal preferences in Zulip: topic visibility (mute, unmute, follow, reset), " +
        "list all custom topic visibility policies, and manage muted users. " +
        "Use to mute noisy topics, follow important topics for extra notifications, " +
        "unmute specific topics in muted streams, list all topics with custom visibility, or mute/unmute users.",
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
              "mute_topic",
              "unmute_topic",
              "follow_topic",
              "reset_topic",
              "list_visibility_policies",
              "list_muted_users",
              "mute_user",
              "unmute_user",
            ],
            description:
              "Action to perform: " +
              "'mute_topic' silences notifications for a topic, " +
              "'unmute_topic' unmutes a topic (useful in muted streams), " +
              "'follow_topic' enables extra notifications for all messages in a topic, " +
              "'reset_topic' removes any visibility policy (restores default behavior), " +
              "'list_visibility_policies' lists all topics with custom visibility policies (muted, unmuted, followed), " +
              "'list_muted_users' shows all users you have muted, " +
              "'mute_user' mutes a user (their messages are auto-read and hidden), " +
              "'unmute_user' unmutes a previously muted user.",
          },
          streamName: {
            type: "string",
            description:
              "Stream name where the topic lives (required for topic actions: mute_topic/unmute_topic/follow_topic/reset_topic).",
          },
          topic: {
            type: "string",
            description:
              "Topic name to modify the visibility policy for (required for topic actions).",
          },
          filterPolicy: {
            type: "string",
            enum: ["muted", "unmuted", "followed", "all"],
            description:
              "Filter topics by visibility policy (for list_visibility_policies). " +
              "'muted' = only muted topics, 'unmuted' = only unmuted topics, " +
              "'followed' = only followed topics, 'all' = all custom policies (default).",
          },
          userId: {
            type: "number",
            description:
              "User ID to mute or unmute (required for mute_user/unmute_user). " +
              "Use zulip_users to find user IDs.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "mute_topic":
          case "unmute_topic":
          case "follow_topic":
          case "reset_topic": {
            if (!params.streamName) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: streamName is required for ${params.action}.`,
                  },
                ],
              };
            }
            if (!params.topic) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: topic is required for ${params.action}.`,
                  },
                ],
              };
            }

            // Resolve stream name to ID
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

            const policyMap: Record<string, number> = {
              mute_topic: TOPIC_VISIBILITY_POLICIES.muted,
              unmute_topic: TOPIC_VISIBILITY_POLICIES.unmuted,
              follow_topic: TOPIC_VISIBILITY_POLICIES.followed,
              reset_topic: TOPIC_VISIBILITY_POLICIES.none,
            };

            const policy = policyMap[params.action] as 0 | 1 | 2 | 3;
            const policyLabel = TOPIC_VISIBILITY_LABELS[policy];

            await updateZulipUserTopic(client, {
              streamId: stream.stream_id,
              topic: params.topic,
              visibilityPolicy: policy,
            });

            const actionLabels: Record<string, string> = {
              mute_topic: "Muted",
              unmute_topic: "Unmuted",
              follow_topic: "Following",
              reset_topic: "Reset visibility for",
            };
            const actionLabel = actionLabels[params.action];

            return {
              content: [
                {
                  type: "text",
                  text:
                    `${actionLabel} topic: #${params.streamName} > ${params.topic} ` +
                    `(policy: ${policyLabel}) \u2705`,
                },
              ],
            };
          }

          case "list_visibility_policies": {
            const userTopics = await listZulipUserTopics(client);

            // Apply filter if specified
            const filterPolicy = params.filterPolicy ?? "all";
            const policyFilter: Record<string, number[]> = {
              muted: [TOPIC_VISIBILITY_POLICIES.muted],
              unmuted: [TOPIC_VISIBILITY_POLICIES.unmuted],
              followed: [TOPIC_VISIBILITY_POLICIES.followed],
              all: [
                TOPIC_VISIBILITY_POLICIES.muted,
                TOPIC_VISIBILITY_POLICIES.unmuted,
                TOPIC_VISIBILITY_POLICIES.followed,
              ],
            };
            const allowedPolicies = policyFilter[filterPolicy] ?? policyFilter.all;
            const filtered = userTopics.filter((ut) =>
              allowedPolicies.includes(ut.visibility_policy),
            );

            if (filtered.length === 0) {
              if (filterPolicy !== "all" && userTopics.length > 0) {
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `No topics with policy "${filterPolicy}" found, ` +
                        `but there are ${userTopics.length} topic(s) with other custom visibility policies. ` +
                        `Use filterPolicy="all" to see them all.`,
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: "No topics with custom visibility policies found. All topics use default behavior.",
                  },
                ],
              };
            }

            // Resolve stream IDs to names for readability
            let streamMap: Map<number, string> | null = null;
            try {
              // Collect the set of stream IDs we actually need to resolve
              const neededStreamIds = new Set<number>();
              for (const ut of filtered) {
                if (ut.stream_id != null) {
                  neededStreamIds.add(ut.stream_id);
                }
              }

              // First, resolve from subscriptions (cheaper than listing all streams)
              const subs = await listZulipSubscriptions(client);
              streamMap = new Map();
              for (const s of subs) {
                if (neededStreamIds.has(s.stream_id)) {
                  streamMap.set(s.stream_id, s.name);
                  neededStreamIds.delete(s.stream_id);
                }
              }

              // Only fetch all streams if there are still unresolved IDs
              if (neededStreamIds.size > 0) {
                const allStreams = await listZulipStreams(client);
                for (const s of allStreams) {
                  if (neededStreamIds.has(s.stream_id)) {
                    streamMap.set(s.stream_id, s.name);
                    neededStreamIds.delete(s.stream_id);
                    if (neededStreamIds.size === 0) {
                      break;
                    }
                  }
                }
              }
            } catch {
              // If stream lookup fails, fall back to stream IDs
            }

            // Group topics by policy for clearer output
            const policyGroups: Record<number, typeof filtered> = {};
            for (const ut of filtered) {
              const p = ut.visibility_policy;
              if (!policyGroups[p]) policyGroups[p] = [];
              policyGroups[p].push(ut);
            }

            const sections: string[] = [];
            const policyOrder: Array<[number, string, string]> = [
              [TOPIC_VISIBILITY_POLICIES.followed, "Followed", "👁️"],
              [TOPIC_VISIBILITY_POLICIES.muted, "Muted", "🔇"],
              [TOPIC_VISIBILITY_POLICIES.unmuted, "Unmuted", "🔔"],
            ];

            for (const [policyNum, label, emoji] of policyOrder) {
              const topics = policyGroups[policyNum as number];
              if (!topics || topics.length === 0) continue;
              const lines = topics.map((t) => {
                const streamLabel = streamMap?.get(t.stream_id) ?? `stream_id:${t.stream_id}`;
                return `  - #${streamLabel} > ${t.topic_name}`;
              });
              sections.push(`**${emoji} ${label}** (${topics.length}):\n${lines.join("\n")}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    `${filtered.length} topic(s) with custom visibility policies:\n\n` +
                    sections.join("\n\n"),
                },
              ],
            };
          }

          case "list_muted_users": {
            const mutedUsers = await listZulipMutedUsers(client);
            if (mutedUsers.length === 0) {
              return {
                content: [
                  { type: "text", text: "No muted users." },
                ],
              };
            }
            const lines = mutedUsers.map((mu) => {
              const mutedAt = new Date(mu.timestamp * 1000).toISOString();
              return `- User ID: ${mu.id} (muted at: ${mutedAt})`;
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `${mutedUsers.length} muted user(s):\n${lines.join("\n")}\n\n` +
                    `Use zulip_users \u2192 get to look up user details by ID.`,
                },
              ],
            };
          }

          case "mute_user": {
            if (!params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userId is required for mute_user.",
                  },
                ],
              };
            }
            await muteZulipUser(client, params.userId);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `User ${params.userId} muted \u2705\n` +
                    `Their messages will be automatically marked as read and hidden.`,
                },
              ],
            };
          }

          case "unmute_user": {
            if (!params.userId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: userId is required for unmute_user.",
                  },
                ],
              };
            }
            await unmuteZulipUser(client, params.userId);
            return {
              content: [
                {
                  type: "text",
                  text: `User ${params.userId} unmuted \u2705`,
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
      name: "zulip_stream_settings",
      description:
        "View and update per-stream subscription settings for the bot user. " +
        "Use to pin/unpin streams, mute/unmute entire streams, change stream colors, " +
        "or configure per-stream notification overrides (desktop, push, email, audible, wildcard mentions). " +
        "These settings are personal to the bot and do not affect other users.",
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
            enum: ["get", "pin", "unpin", "mute", "unmute", "set_color", "set_notifications"],
            description:
              "Action to perform: " +
              "'get' returns the current subscription settings for a stream, " +
              "'pin' pins the stream to the top of the sidebar, " +
              "'unpin' removes the pin, " +
              "'mute' mutes the stream to minimize notifications (topic-level overrides and mentions may still notify), " +
              "'unmute' unmutes the stream, " +
              "'set_color' changes the stream's sidebar color, " +
              "'set_notifications' configures per-stream notification overrides.",
          },
          streamName: {
            type: "string",
            description:
              "Stream name to operate on (required for all actions). " +
              "Use the plain stream name without # or ** formatting.",
          },
          color: {
            type: "string",
            description:
              "Hex color code for the stream (for set_color action), e.g. '#c6c6ff', '#ff0000'. " +
              "Must include the '#' prefix.",
          },
          desktopNotifications: {
            type: ["boolean", "null"],
            description:
              "Override desktop notifications for this stream (for set_notifications). " +
              "true = always notify, false = never notify, null = use global default.",
          },
          pushNotifications: {
            type: ["boolean", "null"],
            description:
              "Override push/mobile notifications for this stream (for set_notifications). " +
              "true = always notify, false = never notify, null = use global default.",
          },
          emailNotifications: {
            type: ["boolean", "null"],
            description:
              "Override email notifications for this stream (for set_notifications). " +
              "true = always notify, false = never notify, null = use global default.",
          },
          audibleNotifications: {
            type: ["boolean", "null"],
            description:
              "Override audible notifications for this stream (for set_notifications). " +
              "true = always play sound, false = never play sound, null = use global default.",
          },
          wildcardMentionsNotify: {
            type: ["boolean", "null"],
            description:
              "Override wildcard mention (@all/@everyone) notifications for this stream (for set_notifications). " +
              "true = always notify, false = never notify, null = use global default.",
          },
        },
        required: ["action", "streamName"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        if (!params.streamName) {
          return {
            content: [
              { type: "text", text: "Error: streamName is required." },
            ],
          };
        }

        // Look up the stream in subscriptions to get stream_id and current settings
        const subs = await listZulipSubscriptions(client);
        const sub = subs.find(
          (s) => s.name.toLowerCase() === params.streamName.toLowerCase(),
        );
        if (!sub) {
          return {
            content: [
              {
                type: "text",
                text: `Error: not subscribed to stream "${params.streamName}". ` +
                  `Use zulip_streams → join to subscribe first.`,
              },
            ],
          };
        }

        const streamId = sub.stream_id;

        switch (params.action) {
          case "get": {
            const colorDisplay = sub.color ?? "(default)";
            const pinned = sub.pin_to_top === true;
            const muted = sub.is_muted === true;

            const formatNotif = (val: unknown): string => {
              if (val === true) return "On";
              if (val === false) return "Off";
              return "Global default";
            };

            const lines = [
              `**Stream settings for #${sub.name}** (id:${streamId})`,
              `- Color: ${colorDisplay}`,
              `- Pinned: ${pinned ? "Yes 📌" : "No"}`,
              `- Muted: ${muted ? "Yes 🔇" : "No"}`,
              `- Desktop notifications: ${formatNotif(sub.desktop_notifications)}`,
              `- Push notifications: ${formatNotif(sub.push_notifications)}`,
              `- Email notifications: ${formatNotif(sub.email_notifications)}`,
              `- Audible notifications: ${formatNotif(sub.audible_notifications)}`,
              `- Wildcard mentions notify: ${formatNotif(sub.wildcard_mentions_notify)}`,
            ];
            return {
              content: [{ type: "text", text: lines.join("\n") }],
            };
          }

          case "pin": {
            await updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "pin_to_top", value: true },
            ]);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream #${params.streamName} pinned to top 📌 ✅`,
                },
              ],
            };
          }

          case "unpin": {
            await updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "pin_to_top", value: false },
            ]);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream #${params.streamName} unpinned ✅`,
                },
              ],
            };
          }

          case "mute": {
            await updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "is_muted", value: true },
            ]);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream #${params.streamName} muted 🔇 ✅\n` +
                    `This stream is muted; notifications are suppressed unless overridden by mentions or topic-level settings.`,
                },
              ],
            };
          }

          case "unmute": {
            await updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "is_muted", value: false },
            ]);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream #${params.streamName} unmuted ✅`,
                },
              ],
            };
          }

          case "set_color": {
            if (!params.color) {
              return {
                content: [
                  { type: "text", text: "Error: color is required for set_color (e.g. '#c6c6ff')." },
                ],
              };
            }
            // Validate hex color format
            const colorRegex = /^#[0-9a-fA-F]{6}$/;
            if (!colorRegex.test(params.color)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: color must be a valid 6-digit hex code with # prefix (e.g. '#c6c6ff').",
                  },
                ],
              };
            }
            await updateZulipSubscriptionProperties(client, [
              { stream_id: streamId, property: "color", value: params.color },
            ]);
            return {
              content: [
                {
                  type: "text",
                  text: `Stream #${params.streamName} color set to ${params.color} 🎨 ✅`,
                },
              ],
            };
          }

          case "set_notifications": {
            const properties: ZulipSubscriptionProperty[] = [];

            if (params.desktopNotifications !== undefined) {
              properties.push({
                stream_id: streamId,
                property: "desktop_notifications",
                value: params.desktopNotifications,
              });
            }
            if (params.pushNotifications !== undefined) {
              properties.push({
                stream_id: streamId,
                property: "push_notifications",
                value: params.pushNotifications,
              });
            }
            if (params.emailNotifications !== undefined) {
              properties.push({
                stream_id: streamId,
                property: "email_notifications",
                value: params.emailNotifications,
              });
            }
            if (params.audibleNotifications !== undefined) {
              properties.push({
                stream_id: streamId,
                property: "audible_notifications",
                value: params.audibleNotifications,
              });
            }
            if (params.wildcardMentionsNotify !== undefined) {
              properties.push({
                stream_id: streamId,
                property: "wildcard_mentions_notify",
                value: params.wildcardMentionsNotify,
              });
            }

            if (properties.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Error: provide at least one notification setting to update: " +
                      "desktopNotifications, pushNotifications, emailNotifications, " +
                      "audibleNotifications, or wildcardMentionsNotify. " +
                      "Use true to enable, false to disable, or null to reset to global default.",
                  },
                ],
              };
            }

            await updateZulipSubscriptionProperties(client, properties);

            const formatVal = (val: unknown): string => {
              if (val === true) return "On";
              if (val === false) return "Off";
              return "Global default";
            };

            const changes = properties.map(
              (p) => `- ${p.property.replace(/_/g, " ")}: ${formatVal(p.value)}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Notification settings updated for #${params.streamName} ✅\n` +
                    changes.join("\n"),
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
      name: "zulip_attachments",
      description:
        "List or delete uploaded file attachments in Zulip, and check upload space usage. " +
        "Use to review files the bot has uploaded, clean up old attachments, or monitor storage usage. " +
        "Complements the zulip_upload tool which handles uploading new files.",
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
            enum: ["list", "delete", "usage"],
            description:
              "Action to perform: " +
              "'list' returns all files uploaded by the bot with their IDs, names, sizes, and linked messages; " +
              "'delete' removes an uploaded file by its attachment ID; " +
              "'usage' returns the total upload space used by the bot.",
          },
          attachmentId: {
            type: "number",
            description:
              "Attachment ID to delete (for delete action). Use 'list' to find attachment IDs.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const { attachments } = await listZulipAttachments(client);
            if (attachments.length === 0) {
              return {
                content: [
                  { type: "text", text: "No uploaded attachments found." },
                ],
              };
            }
            const lines = attachments.map((a) => {
              const sizeKB = (a.size / 1024).toFixed(1);
              const sizeMB = (a.size / (1024 * 1024)).toFixed(2);
              const sizeLabel = a.size >= 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
              const date = new Date(a.create_time * 1000).toISOString();
              const msgCount = a.messages?.length ?? 0;
              const msgInfo = msgCount > 0
                ? ` (referenced in ${msgCount} message${msgCount > 1 ? "s" : ""})`
                : " (not referenced in any message)";
              return `- **[${a.id}]** ${a.name} — ${sizeLabel}, uploaded ${date}${msgInfo}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `${attachments.length} attachment(s):\n\n${lines.join("\n")}`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.attachmentId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: attachmentId is required for delete. Use 'list' to find attachment IDs.",
                  },
                ],
              };
            }
            await deleteZulipAttachment(client, params.attachmentId);
            return {
              content: [
                {
                  type: "text",
                  text: `Attachment ${params.attachmentId} deleted \u2705`,
                },
              ],
            };
          }

          case "usage": {
            const { uploadSpaceUsed } = await listZulipAttachments(client);
            const usedMB = (uploadSpaceUsed / (1024 * 1024)).toFixed(2);
            const usedKB = (uploadSpaceUsed / 1024).toFixed(1);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `**Upload space usage**\n` +
                    `- Used: ${uploadSpaceUsed >= 1024 * 1024 ? `${usedMB} MB` : `${usedKB} KB`} ` +
                    `(${uploadSpaceUsed.toLocaleString()} bytes)\n\n` +
                    `Use 'list' to see all uploaded files and 'delete' to remove unused attachments.`,
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
      name: "zulip_typing",
      description:
        "Send typing indicators in Zulip conversations. " +
        "Use to signal to users that the bot is working on a response, " +
        "especially during long-running tasks. Typing indicators automatically " +
        "expire after about 15 seconds, so send them periodically for longer operations. " +
        "Supports both stream topics and direct messages.",
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
            enum: ["start", "stop"],
            description:
              "Action to perform: " +
              "'start' begins showing the typing indicator (auto-expires after ~15s), " +
              "'stop' immediately hides the typing indicator.",
          },
          streamName: {
            type: "string",
            description:
              "Stream name for stream typing indicators. " +
              "Must be used together with 'topic'. Mutually exclusive with 'userId' and 'userIds'.",
          },
          topic: {
            type: "string",
            description:
              "Topic name within the stream (required when streamName is provided).",
          },
          userId: {
            type: "number",
            description:
              "User ID for 1:1 DM typing indicators. Mutually exclusive with 'streamName' and 'userIds'.",
          },
          userIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of user IDs for group DM (huddle) typing indicators. " +
              "Must contain at least 2 user IDs. Mutually exclusive with 'streamName' and 'userId'.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        let op: "start" | "stop";
        switch (params.action) {
          case "start":
            op = "start";
            break;
          case "stop":
            op = "stop";
            break;
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

        // Validate mutual exclusivity of target parameters
        const targetCount = [params.streamName, params.userId, params.userIds].filter(
          (v) => v !== undefined && v !== null,
        ).length;
        if (targetCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide one of streamName (with topic), userId, or userIds.",
              },
            ],
          };
        }
        if (targetCount > 1) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide only one of streamName, userId, or userIds.",
              },
            ],
          };
        }

        if (params.streamName) {
          if (!params.topic) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: topic is required when using streamName for typing indicators.",
                },
              ],
            };
          }

          // Resolve stream name to stream ID
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

          await sendZulipTyping(client, {
            op,
            to: [],
            streamId: stream.stream_id,
            topic: params.topic,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  op === "start"
                    ? `Typing indicator started in #${params.streamName} > ${params.topic} \u2705`
                    : `Typing indicator stopped in #${params.streamName} > ${params.topic} \u2705`,
              },
            ],
          };
        } else if (params.userIds) {
          if (!Array.isArray(params.userIds) || params.userIds.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userIds must be an array with at least 2 user IDs for group DM typing. For 1:1 DMs, use userId instead.",
                },
              ],
            };
          }
          const invalidIds = params.userIds.filter(
            (id: unknown) =>
              typeof id !== "number" ||
              !Number.isFinite(id) ||
              !Number.isInteger(id) ||
              (id as number) <= 0,
          );
          if (invalidIds.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: invalid user ID(s): ${JSON.stringify(invalidIds)}. All IDs must be positive integers.`,
                },
              ],
            };
          }
          const uniqueIds = [...new Set(params.userIds as number[])];
          if (uniqueIds.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userIds must contain at least 2 distinct user IDs for group DM typing.",
                },
              ],
            };
          }
          await sendZulipTyping(client, { op, to: uniqueIds });
          return {
            content: [
              {
                type: "text",
                text:
                  op === "start"
                    ? `Typing indicator started in group DM with users [${uniqueIds.join(", ")}] \u2705`
                    : `Typing indicator stopped in group DM with users [${uniqueIds.join(", ")}] \u2705`,
              },
            ],
          };
        } else {
          // userId (1:1 DM)
          const userId = Number(params.userId);
          if (!Number.isFinite(userId) || !Number.isInteger(userId) || userId <= 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: userId must be a valid positive integer.",
                },
              ],
            };
          }
          await sendZulipTyping(client, { op, to: [userId] });
          return {
            content: [
              {
                type: "text",
                text:
                  op === "start"
                    ? `Typing indicator started in DM with user ${userId} \u2705`
                    : `Typing indicator stopped in DM with user ${userId} \u2705`,
              },
            ],
          };
        }
      },
    });

    api.registerTool({
      name: "zulip_saved_snippets",
      description:
        "List, create, edit, or delete saved snippets in Zulip. " +
        "Saved snippets are reusable text templates that can be quickly inserted into messages. " +
        "Use to manage frequently used responses, welcome messages, standard replies, " +
        "or any text the bot needs to reuse across conversations. " +
        "Requires Zulip 10.0+ (feature level 297); the 'edit' action requires feature level 368.",
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
          snippetId: {
            type: "number",
            description:
              "Saved snippet ID (for edit/delete). Use 'list' to find snippet IDs.",
          },
          title: {
            type: "string",
            description:
              "Title of the saved snippet (for create/edit). " +
              "Should be a short, descriptive label for the snippet, e.g. 'Welcome message', 'FAQ: pricing'.",
          },
          content: {
            type: "string",
            description:
              "Content of the saved snippet in Zulip markdown format (for create/edit). " +
              "This is the text that will be inserted when the snippet is used. " +
              "Supports full Zulip markdown including bold, lists, links, code blocks, etc.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const snippets = await listZulipSavedSnippets(client);
            if (snippets.length === 0) {
              return {
                content: [
                  { type: "text", text: "No saved snippets found." },
                ],
              };
            }
            const lines = snippets.map((s) => {
              const date = new Date(s.date_created * 1000).toISOString();
              const preview =
                s.content.length > 200
                  ? s.content.slice(0, 200) + "\u2026"
                  : s.content;
              return `- **[${s.id}]** **${s.title}** (created: ${date})\n  ${preview}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `${snippets.length} saved snippet(s):\n\n${lines.join("\n\n")}`,
                },
              ],
            };
          }

          case "create": {
            if (!params.title) {
              return {
                content: [
                  { type: "text", text: "Error: title is required for create." },
                ],
              };
            }
            if (!params.content) {
              return {
                content: [
                  { type: "text", text: "Error: content is required for create." },
                ],
              };
            }
            const result = await createZulipSavedSnippet(client, {
              title: params.title,
              content: params.content,
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Saved snippet created (id:${result.saved_snippet_id}) \u2705\n` +
                    `Title: **${params.title}**`,
                },
              ],
            };
          }

          case "edit": {
            if (!params.snippetId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: snippetId is required for edit. Use 'list' to find snippet IDs.",
                  },
                ],
              };
            }
            if (!params.title && !params.content) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: provide title and/or content to edit.",
                  },
                ],
              };
            }
            await editZulipSavedSnippet(client, params.snippetId, {
              title: params.title,
              content: params.content,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Saved snippet ${params.snippetId} updated \u2705`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.snippetId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: snippetId is required for delete. Use 'list' to find snippet IDs.",
                  },
                ],
              };
            }
            await deleteZulipSavedSnippet(client, params.snippetId);
            return {
              content: [
                {
                  type: "text",
                  text: `Saved snippet ${params.snippetId} deleted \u2705`,
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
      name: "zulip_reminders",
      description:
        "List, create, or delete message reminders in Zulip. " +
        "Reminders schedule a Notification Bot message to the current user at a future time, " +
        "linking back to a specific message. Use to set follow-up reminders on important messages, " +
        "create 'snooze' workflows, or schedule self-notifications about conversations. " +
        "Requires Zulip 11.0+ (feature level 399 for list/delete, 381 for create).",
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
            enum: ["list", "create", "delete"],
            description: "Action to perform",
          },
          reminderId: {
            type: "number",
            description:
              "Reminder ID (for delete). Use 'list' to find reminder IDs.",
          },
          messageId: {
            type: "number",
            description:
              "Message ID to set a reminder for (for create). " +
              "The reminder will link back to this message when delivered.",
          },
          scheduledAt: {
            type: "string",
            description:
              "ISO 8601 datetime string for when the reminder should be delivered (for create), " +
              "e.g. '2099-12-31T09:00:00Z'. Must be in the future.",
          },
          note: {
            type: "string",
            description:
              "Optional note to include with the reminder (for create). " +
              "This text is shown in the Notification Bot message alongside the link to the original message. " +
              "Requires Zulip 11.0+ (feature level 415).",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const reminders = await listZulipReminders(client);
            if (reminders.length === 0) {
              return {
                content: [
                  { type: "text", text: "No pending reminders found." },
                ],
              };
            }
            const lines = reminders.map((r) => {
              const deliverAt = new Date(
                r.scheduled_delivery_timestamp * 1000,
              ).toISOString();
              const preview =
                r.content.length > 200
                  ? r.content.slice(0, 200) + "\u2026"
                  : r.content;
              const status = r.failed ? " \u274C FAILED" : "";
              const msgRef = r.reminder_target_message_id
                ? ` (message: ${r.reminder_target_message_id})`
                : "";
              return `- **[${r.reminder_id}]** at ${deliverAt}${msgRef}${status}\n  ${preview}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `${reminders.length} pending reminder(s):\n\n${lines.join("\n\n")}`,
                },
              ],
            };
          }

          case "create": {
            if (!params.messageId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: messageId is required for create. Provide the ID of the message to set a reminder for.",
                  },
                ],
              };
            }
            if (!params.scheduledAt) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: scheduledAt is required for create (ISO 8601 datetime, e.g. '2099-12-31T09:00:00Z').",
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

            const result = await createZulipReminder(client, {
              messageId: params.messageId,
              scheduledDeliveryTimestamp: deliverTimestamp,
              note: params.note,
            });
            const deliverAt = new Date(
              deliverTimestamp * 1000,
            ).toISOString();
            const noteInfo = params.note ? ` with note: "${params.note}"` : "";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Reminder created (id:${result.reminder_id}) for message ${params.messageId} ` +
                    `at ${deliverAt}${noteInfo} \u2705`,
                },
              ],
            };
          }

          case "delete": {
            if (!params.reminderId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: reminderId is required for delete. Use 'list' to find reminder IDs.",
                  },
                ],
              };
            }
            await deleteZulipReminder(client, params.reminderId);
            return {
              content: [
                {
                  type: "text",
                  text: `Reminder ${params.reminderId} deleted \u2705`,
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
      name: "zulip_invitations",
      description:
        "Manage Zulip organization invitations: list pending invitations, send email invitations, " +
        "create reusable invitation links, revoke invitations, and resend email invitations. " +
        "Use to onboard new users, manage access to the organization, or audit pending invites. " +
        "Requires appropriate permissions (typically admin or member with invite permission).",
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
            enum: ["list", "send", "create_link", "revoke", "revoke_link", "resend"],
            description:
              "Action to perform: " +
              "'list' returns all unexpired invitations (email and reusable links), " +
              "'send' sends email invitations to specified email addresses, " +
              "'create_link' generates a reusable invitation link that multiple users can use, " +
              "'revoke' cancels an email invitation, " +
              "'revoke_link' cancels a reusable invitation link, " +
              "'resend' resends an email invitation.",
          },
          inviteId: {
            type: "number",
            description:
              "Invitation ID (for revoke/revoke_link/resend). Use 'list' to find invitation IDs.",
          },
          emails: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of email addresses to invite (for send action). " +
              "Each must be a valid email address.",
          },
          streamIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Array of stream IDs to auto-subscribe invited users to (for send/create_link). " +
              "Use zulip_streams list_all to find stream IDs.",
          },
          inviteAs: {
            type: "number",
            enum: [100, 200, 300, 400, 600],
            description:
              "Organization role for invited users (for send/create_link): " +
              "100 = Organization owner, 200 = Organization administrator, " +
              "300 = Organization moderator, 400 = Member (default), 600 = Guest. " +
              "You can only invite with roles equal or stricter than your own.",
          },
          expiresInMinutes: {
            type: ["number", "null"],
            description:
              "Number of minutes before the invitation expires (for send/create_link). " +
              "Use null for invitations that never expire. " +
              "If omitted, uses the server default (typically 10 days / 14400 minutes).",
          },
          includeDefaultSubscriptions: {
            type: "boolean",
            description:
              "Whether invited users should also be subscribed to the organization's default streams (for send/create_link). " +
              "Defaults to true if omitted.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const cfg = api.runtime.config.loadConfig();
        const client = getClient(cfg, params.accountId);

        switch (params.action) {
          case "list": {
            const invites = await listZulipInvites(client);
            if (invites.length === 0) {
              return {
                content: [
                  { type: "text", text: "No unexpired invitations found." },
                ],
              };
            }

            const emailInvites = invites.filter((inv) => !inv.is_multiuse);
            const linkInvites = invites.filter((inv) => inv.is_multiuse);

            const sections: string[] = [];

            if (emailInvites.length > 0) {
              const lines = emailInvites.map((inv) => {
                const role = INVITE_AS_LABELS[inv.invite_as] ?? `Role ${inv.invite_as}`;
                const created = new Date(inv.invited * 1000).toISOString();
                const expires = inv.expiry_date
                  ? new Date(inv.expiry_date * 1000).toISOString()
                  : "Never";
                return (
                  `- **[${inv.id}]** ${inv.email ?? "(no email)"} — ` +
                  `${role}, created: ${created}, expires: ${expires}`
                );
              });
              sections.push(
                `**Email invitations** (${emailInvites.length}):\n${lines.join("\n")}`,
              );
            }

            if (linkInvites.length > 0) {
              const lines = linkInvites.map((inv) => {
                const role = INVITE_AS_LABELS[inv.invite_as] ?? `Role ${inv.invite_as}`;
                const created = new Date(inv.invited * 1000).toISOString();
                const expires = inv.expiry_date
                  ? new Date(inv.expiry_date * 1000).toISOString()
                  : "Never";
                const linkDisplay = inv.link ? ` — ${inv.link}` : "";
                return (
                  `- **[${inv.id}]** Reusable link${linkDisplay} — ` +
                  `${role}, created: ${created}, expires: ${expires}`
                );
              });
              sections.push(
                `**Reusable invitation links** (${linkInvites.length}):\n${lines.join("\n")}`,
              );
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    `${invites.length} invitation(s) found:\n\n` +
                    sections.join("\n\n"),
                },
              ],
            };
          }

          case "send": {
            if (!params.emails || !Array.isArray(params.emails) || params.emails.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: emails array with at least one email address is required for send.",
                  },
                ],
              };
            }
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const invalidEmails = params.emails.filter(
              (e: string) => !emailRegex.test(e.trim()),
            );
            if (invalidEmails.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: invalid email address(es): ${invalidEmails.join(", ")}`,
                  },
                ],
              };
            }

            const streamIds = params.streamIds ?? [];

            await sendZulipInvites(client, {
              inviteeEmails: params.emails.map((e: string) => e.trim()).join(","),
              streamIds,
              inviteAs: params.inviteAs,
              inviteExpiresInMinutes: params.expiresInMinutes,
              includeRealmDefaultSubscriptions: params.includeDefaultSubscriptions,
            });

            const role = params.inviteAs
              ? (INVITE_AS_LABELS[params.inviteAs] ?? `Role ${params.inviteAs}`)
              : "Member";
            const streamInfo = streamIds.length > 0
              ? `, auto-subscribing to ${streamIds.length} stream(s)`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Sent email invitation(s) to ${params.emails.length} address(es) as ${role}${streamInfo} \u2705\n` +
                    `Recipients: ${params.emails.join(", ")}`,
                },
              ],
            };
          }

          case "create_link": {
            const streamIds = params.streamIds ?? [];

            const result = await createZulipInviteLink(client, {
              streamIds,
              inviteAs: params.inviteAs,
              inviteExpiresInMinutes: params.expiresInMinutes,
              includeRealmDefaultSubscriptions: params.includeDefaultSubscriptions,
            });

            const role = params.inviteAs
              ? (INVITE_AS_LABELS[params.inviteAs] ?? `Role ${params.inviteAs}`)
              : "Member";
            const expiresInfo =
              params.expiresInMinutes === null
                ? "Never expires"
                : params.expiresInMinutes
                  ? `Expires in ${params.expiresInMinutes} minutes`
                  : "Uses server default expiry";
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Reusable invitation link created \u2705\n` +
                    `- **Link**: ${result.invite_link}\n` +
                    `- **Role**: ${role}\n` +
                    `- **Expiry**: ${expiresInfo}\n` +
                    (streamIds.length > 0
                      ? `- **Auto-subscribe streams**: ${streamIds.join(", ")}\n`
                      : "") +
                    `\nShare this link with anyone you want to invite to the organization.`,
                },
              ],
            };
          }

          case "revoke": {
            if (!params.inviteId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: inviteId is required for revoke. Use 'list' to find invitation IDs.",
                  },
                ],
              };
            }
            await revokeZulipInvite(client, params.inviteId);
            return {
              content: [
                {
                  type: "text",
                  text: `Email invitation ${params.inviteId} revoked \u2705`,
                },
              ],
            };
          }

          case "revoke_link": {
            if (!params.inviteId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: inviteId is required for revoke_link. Use 'list' to find invitation IDs.",
                  },
                ],
              };
            }
            await revokeZulipInviteLink(client, params.inviteId);
            return {
              content: [
                {
                  type: "text",
                  text: `Reusable invitation link ${params.inviteId} revoked \u2705`,
                },
              ],
            };
          }

          case "resend": {
            if (!params.inviteId) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: inviteId is required for resend. Use 'list' to find email invitation IDs.",
                  },
                ],
              };
            }
            await resendZulipInvite(client, params.inviteId);
            return {
              content: [
                {
                  type: "text",
                  text: `Email invitation ${params.inviteId} resent \u2705`,
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
