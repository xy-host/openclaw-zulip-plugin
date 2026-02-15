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
  },
};

export default plugin;
