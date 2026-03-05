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
  },
};

export default plugin;
