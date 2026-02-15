import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
  ChatType,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  getZulipProfile,
  registerZulipEventQueue,
  pollZulipEvents,
  sendZulipTyping,
  type ZulipClient,
  type ZulipMessage,
} from "./client.js";
import { sendZulipMessage } from "./send.js";

export type MonitorZulipOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MAX = 2000;
const recentIds = new Map<string, number>();

function dedupeCheck(key: string): boolean {
  const now = Date.now();
  // Cleanup old entries
  if (recentIds.size > RECENT_MAX) {
    for (const [k, t] of recentIds) {
      if (now - t > RECENT_MESSAGE_TTL_MS) recentIds.delete(k);
    }
  }
  if (recentIds.has(key)) return true;
  recentIds.set(key, now);
  return false;
}

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^(zulip|user):/i, "").toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  return Array.from(new Set(entries.map((e) => normalizeAllowEntry(String(e))).filter(Boolean)));
}

function isSenderAllowed(params: {
  senderId: string;
  senderEmail?: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  if (params.allowFrom.length === 0) return false;
  if (params.allowFrom.includes("*")) return true;
  const idNorm = normalizeAllowEntry(params.senderId);
  const emailNorm = params.senderEmail ? normalizeAllowEntry(params.senderEmail) : "";
  const nameNorm = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return params.allowFrom.some((e) => e === idNorm || (emailNorm && e === emailNorm) || (nameNorm && e === nameNorm));
}

function stripMention(text: string, botName?: string): string {
  if (!botName) return text.trim();
  // Zulip mentions: @**Bot Name**
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@\\*\\*${escaped}\\*\\*`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

function wasBotMentioned(text: string, botName?: string): boolean {
  if (!botName) return false;
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@\\*\\*${escaped}\\*\\*`, "i");
  return re.test(text);
}

function resolveStreamInfo(msg: ZulipMessage): {
  streamName: string;
  topic: string;
} | null {
  if (msg.type !== "stream") return null;
  const streamName = typeof msg.display_recipient === "string" ? msg.display_recipient : "";
  return { streamName, topic: msg.subject ?? "(no topic)" };
}

export async function monitorZulipProvider(opts: MonitorZulipOpts = {}): Promise<void> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });
  const logger = core.logging.getChildLogger({ module: "zulip" });

  const serverUrl = account.serverUrl;
  const botEmail = account.botEmail;
  const apiKey = account.apiKey;
  if (!serverUrl || !botEmail || !apiKey) {
    throw new Error(
      `Zulip credentials missing for account "${account.accountId}".`,
    );
  }

  const client = createZulipClient({ serverUrl, botEmail, apiKey });
  const profile = await getZulipProfile(client);
  const botUserId = profile.user_id;
  const botName = profile.full_name;
  logger.info?.(`zulip connected as ${botName} (${botEmail}, id=${botUserId})`);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
  const autoReplyStreams: string[] = (account.config as any).autoReplyStreams ?? [];

  const getEffectiveAllowFrom = async (): Promise<string[]> => {
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("zulip").catch(() => []),
    );
    return Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
  };

  const handleMessage = async (msg: ZulipMessage) => {
    // Skip own messages
    if (msg.sender_id === botUserId) return;

    const dedupeKey = `${account.accountId}:${msg.id}`;
    if (dedupeCheck(dedupeKey)) return;

    const senderId = String(msg.sender_id);
    const senderName = msg.sender_full_name;
    const senderEmail = msg.sender_email;
    const isDm = msg.type === "private";
    const streamInfo = resolveStreamInfo(msg);
    const chatType: ChatType = isDm ? "direct" : "channel";
    const rawText = msg.content?.trim() ?? "";

    // For stream messages, check auto-reply streams first, then require mention
    if (!isDm) {
      const inAutoReplyStream = streamInfo && autoReplyStreams.some(
        (s) => s.toLowerCase() === streamInfo.streamName.toLowerCase()
      );
      if (!inAutoReplyStream) {
        const mentioned = wasBotMentioned(rawText, botName);
        const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
        const patternMatch = core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes);
        if (!mentioned && !patternMatch) return;
      }
      // For auto-reply streams, only respond to allowed senders
      if (inAutoReplyStream) {
        const streamAllowFrom = await getEffectiveAllowFrom();
        if (streamAllowFrom.length > 0 && !isSenderAllowed({
          senderId,
          senderEmail,
          senderName,
          allowFrom: streamAllowFrom,
        })) return;
      }
    }

    // DM policy
    const effectiveAllowFrom = await getEffectiveAllowFrom();
    if (isDm) {
      if (dmPolicy === "disabled") return;
      const senderAllowed = isSenderAllowed({
        senderId,
        senderEmail,
        senderName,
        allowFrom: effectiveAllowFrom,
      });
      if (dmPolicy !== "open" && !senderAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zulip",
            id: senderId,
            meta: { name: senderName, email: senderEmail },
          });
          if (created) {
            try {
              await sendZulipMessage(`dm:${senderId}`, core.channel.pairing.buildPairingReply({
                channel: "zulip",
                idLine: `Your Zulip user id: ${senderId}`,
                code,
              }), { accountId: account.accountId });
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch {}
          }
        }
        return;
      }
    }

    // Build target for replies
    const to = isDm
      ? `dm:${senderId}`
      : streamInfo
        ? `stream:${streamInfo.streamName}:${streamInfo.topic}`
        : `dm:${senderId}`;

    const bodyText = stripMention(rawText, botName);
    if (!bodyText) return;

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = isDm
      ? `${senderName} (${senderEmail})`
      : `${senderName} in #${streamInfo?.streamName ?? "unknown"} > ${streamInfo?.topic ?? ""}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      peer: {
        kind: isDm ? "direct" : "channel",
        id: isDm ? senderId : (streamInfo?.streamName ?? senderId),
      },
    });

    const sessionKey = route.sessionKey;

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDm
      ? `Zulip DM from ${senderName}`
      : `Zulip message in #${streamInfo?.streamName} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `zulip:message:${msg.id}`,
    });

    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp: msg.timestamp * 1000,
      body: `${bodyText}\n[zulip message id: ${msg.id}]`,
      chatType,
      sender: { name: senderName, id: senderId },
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: isDm ? `zulip:${senderId}` : `zulip:channel:${streamInfo?.streamName ?? "unknown"}`,
      To: to,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: !isDm ? `#${streamInfo?.streamName} > ${streamInfo?.topic}` : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: String(msg.id),
      Timestamp: msg.timestamp * 1000,
      WasMentioned: !isDm ? true : undefined,
      CommandAuthorized: isDm || isSenderAllowed({ senderId, senderEmail, senderName, allowFrom: effectiveAllowFrom }),
      OriginatingChannel: "zulip" as const,
      OriginatingTo: to,
    });

    if (isDm) {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "zulip",
          to,
          accountId: route.accountId,
        },
      });
    }

    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "zulip",
      account.accountId,
      { fallbackLimit: account.textChunkLimit ?? 10000 },
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "zulip",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        try {
          if (isDm) {
            await sendZulipTyping(client, { op: "start", to: [Number(senderId)] });
          } else if (streamInfo && msg.stream_id) {
            await sendZulipTyping(client, {
              op: "start",
              to: [],
              streamId: msg.stream_id,
              topic: streamInfo.topic,
            });
          }
        } catch {}
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "zulip",
          target: to,
          error: err,
        });
      },
    });

    // Send queue to ensure message ordering (prevents out-of-order delivery)
    let sendChain = Promise.resolve();
    const enqueueSend = (fn: () => Promise<void>): Promise<void> => {
      sendChain = sendChain.then(fn, fn);
      return sendChain;
    };

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload) => {
          await enqueueSend(async () => {
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) continue;
              await sendZulipMessage(to, chunk, { accountId: account.accountId });
            }
          });
        },
        onError: (err, info) => {
          logger.error?.(`zulip ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
        onModelSelected,
      },
    });
    markDispatchIdle();
  };

  // Long-polling loop with reconnect
  let backoffMs = 1000;
  const MAX_BACKOFF_MS = 30000;

  while (!opts.abortSignal?.aborted) {
    try {
      const queue = await registerZulipEventQueue(client);
      let lastEventId = queue.last_event_id;
      opts.statusSink?.({ connected: true, lastConnectedAt: Date.now(), lastError: null });
      backoffMs = 1000;

      while (!opts.abortSignal?.aborted) {
        const events = await pollZulipEvents(client, queue.queue_id, lastEventId, opts.abortSignal);
        for (const event of events) {
          if (event.id > lastEventId) lastEventId = event.id;
          if (event.type === "message" && event.message) {
            try {
              await handleMessage(event.message);
            } catch (err) {
              logger.error?.(`zulip handler error: ${String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) return;
      const errStr = String(err);
      logger.error?.(`zulip poll error: ${errStr}`);
      opts.statusSink?.({
        connected: false,
        lastError: errStr,
        lastDisconnect: { at: Date.now(), error: errStr },
      });
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}
