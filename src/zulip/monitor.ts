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
import { resolveZulipAccount, type MultiBotConfig } from "./accounts.js";
import {
  createZulipClient,
  getZulipProfile,
  registerZulipEventQueue,
  pollZulipEvents,
  sendZulipTyping,
  addZulipReaction,
  BadEventQueueError,
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

function dedupeCleanup(): void {
  const now = Date.now();
  for (const [k, t] of recentIds) {
    if (now - t > RECENT_MESSAGE_TTL_MS) recentIds.delete(k);
  }
}

function dedupeCheck(key: string): boolean {
  // Always clean up expired entries first
  dedupeCleanup();
  if (recentIds.has(key)) return true;
  // Enforce hard cap after cleanup
  if (recentIds.size >= RECENT_MAX) {
    // Evict oldest entry
    const oldest = recentIds.keys().next().value;
    if (oldest !== undefined) recentIds.delete(oldest);
  }
  recentIds.set(key, Date.now());
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

// ── Multi-bot conversation: chain tracking & cooldown ──

/**
 * Tracks consecutive bot-to-bot reply counts per conversation.
 * Key: conversationId (e.g. "stream:general:topic" or "dm:123")
 * Value: { count, lastBotReplyAt }
 */
const botChainTracker = new Map<string, { count: number; lastBotReplyAt: number }>();

/** Stale chain entries are cleaned up after 10 minutes of inactivity */
const BOT_CHAIN_TTL_MS = 10 * 60_000;

function cleanupBotChains(): void {
  const now = Date.now();
  for (const [key, entry] of botChainTracker) {
    if (now - entry.lastBotReplyAt > BOT_CHAIN_TTL_MS) {
      botChainTracker.delete(key);
    }
  }
}

/**
 * Check if a bot message should be processed based on chain limits and cooldown.
 * Returns true if the message should be allowed, false if it should be dropped.
 * Also increments the chain counter when allowed.
 */
function checkBotChain(
  conversationId: string,
  maxChainLength: number,
  cooldownMs: number,
): boolean {
  cleanupBotChains();
  const entry = botChainTracker.get(conversationId);
  const now = Date.now();

  if (!entry) {
    // First bot message in this conversation
    botChainTracker.set(conversationId, { count: 1, lastBotReplyAt: now });
    return true;
  }

  // If cooldown has elapsed since the chain was blocked, reset the counter
  if (entry.count >= maxChainLength && now - entry.lastBotReplyAt >= cooldownMs) {
    botChainTracker.set(conversationId, { count: 1, lastBotReplyAt: now });
    return true;
  }

  // If we've hit the chain limit and cooldown hasn't elapsed, block
  if (entry.count >= maxChainLength) {
    return false;
  }

  // Increment chain count
  entry.count += 1;
  entry.lastBotReplyAt = now;
  return true;
}

/**
 * Reset the bot chain counter for a conversation (called when a human message is seen).
 */
function resetBotChain(conversationId: string): void {
  botChainTracker.delete(conversationId);
}

/**
 * Build the conversation ID used for chain tracking.
 */
function buildConversationId(msg: ZulipMessage): string {
  const streamInfo = resolveStreamInfo(msg);
  if (streamInfo) {
    return `stream:${streamInfo.streamName.toLowerCase()}:${streamInfo.topic.toLowerCase()}`;
  }
  return `dm:${msg.sender_id}`;
}

/**
 * Check if a sender is in the allowed bot IDs list.
 */
function isBotAllowed(senderId: number, multiBot?: MultiBotConfig): boolean {
  if (!multiBot?.allowBotIds || multiBot.allowBotIds.length === 0) return false;
  const senderStr = String(senderId);
  return multiBot.allowBotIds.some((id) => {
    const normalized = String(id).trim();
    return normalized === senderStr || normalized === "*";
  });
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
  const autoReplyStreams: string[] = account.autoReplyStreams ?? [];
  const multiBot = account.multiBot;
  const maxBotChainLength = multiBot?.maxBotChainLength ?? 3;
  const botCooldownMs = multiBot?.botCooldownMs ?? 60_000;

  if (multiBot?.allowBotIds && multiBot.allowBotIds.length > 0) {
    logger.info?.(
      `multi-bot conversation enabled: allowBotIds=${JSON.stringify(multiBot.allowBotIds)}, ` +
      `maxChainLength=${maxBotChainLength}, cooldownMs=${botCooldownMs}`,
    );
  }

  const getEffectiveAllowFrom = async (): Promise<string[]> => {
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("zulip").catch(() => []),
    );
    return Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
  };

  const handleMessage = async (msg: ZulipMessage) => {
    // Always skip own messages
    if (msg.sender_id === botUserId) return;

    const conversationId = buildConversationId(msg);
    const isFromAllowedBot = isBotAllowed(msg.sender_id, multiBot);
    const rawText = msg.content?.trim() ?? "";
    const mentioned = wasBotMentioned(rawText, botName);

    // Determine if this message is from a bot we should respond to
    const isBotMessage = isFromAllowedBot || (mentioned && isFromAllowedBot);

    if (isFromAllowedBot) {
      // Bot-to-bot: check chain limits to prevent infinite loops
      if (!checkBotChain(conversationId, maxBotChainLength, botCooldownMs)) {
        logger.info?.(
          `bot chain limit reached for ${conversationId} ` +
          `(max=${maxBotChainLength}, cooldown=${botCooldownMs}ms), ` +
          `dropping message from bot ${msg.sender_id}`,
        );
        return;
      }
    } else if (mentioned) {
      // @mention from a non-allowed-bot sender is handled by normal flow below
      // If the sender happens to be a bot not in allowBotIds but @mentions us,
      // we still respond (single response, no chain tracking needed)
    } else {
      // Regular human message — reset any bot chain counter for this conversation
      resetBotChain(conversationId);
    }

    const dedupeKey = `${account.accountId}:${msg.id}`;
    if (dedupeCheck(dedupeKey)) return;

    const senderId = String(msg.sender_id);
    const senderName = msg.sender_full_name;
    const senderEmail = msg.sender_email;
    const isDm = msg.type === "private";
    const streamInfo = resolveStreamInfo(msg);
    const chatType: ChatType = isDm ? "direct" : "channel";

    // Resolve allowFrom once for use in both stream and DM checks
    const effectiveAllowFrom = await getEffectiveAllowFrom();

    // For stream messages, check auto-reply streams first, then require mention
    if (!isDm) {
      const inAutoReplyStream = streamInfo && autoReplyStreams.some(
        (s) => s.toLowerCase() === streamInfo.streamName.toLowerCase()
      );

      if (isFromAllowedBot) {
        // For allowed bots in streams: process if in auto-reply stream or if they @mentioned us
        if (!inAutoReplyStream && !mentioned) return;
      } else {
        // For regular users: original logic
        if (!inAutoReplyStream) {
          const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
          const patternMatch = core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes);
          if (!mentioned && !patternMatch) return;
        }
        // For all stream messages (auto-reply or @mention), check allowFrom if configured
        if (effectiveAllowFrom.length > 0 && !isSenderAllowed({
          senderId,
          senderEmail,
          senderName,
          allowFrom: effectiveAllowFrom,
        })) return;
      }
    }

    // DM policy — for allowed bots, skip DM policy checks
    if (isDm) {
      if (isFromAllowedBot) {
        // Allowed bots bypass DM policy entirely
      } else {
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
              } catch (err) {
                logger.warn?.(`failed to send pairing reply to ${senderId}: ${err}`);
              }
            }
          }
          return;
        }
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

    // Acknowledge message with 👀 reaction
    try {
      await addZulipReaction(client, msg.id, "eyes");
    } catch (err) {
      logger.warn?.(`failed to add reaction to msg ${msg.id}: ${err}`);
    }

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });
    opts.statusSink?.({ lastInboundAt: Date.now() });

    const fromLabel = isDm
      ? `${senderName} (${senderEmail})`
      : `${senderName} in #${streamInfo?.streamName ?? "unknown"} > ${streamInfo?.topic ?? ""}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      peer: {
        kind: isDm ? "direct" : "channel",
        id: isDm ? senderId : (streamInfo ? `${streamInfo.streamName}:${streamInfo.topic}` : senderId),
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
        } catch (err) {
          logger.debug?.(`typing indicator start failed for ${to}: ${err}`);
        }
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
            let delivered = false;
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) continue;
              await sendZulipMessage(to, chunk, { accountId: account.accountId });
              delivered = true;
            }
            if (delivered) {
              opts.statusSink?.({ lastOutboundAt: Date.now() });
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
      logger.info?.(`zulip event queue registered: ${queue.queue_id}`);
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
      // Bad queue → re-register immediately without backoff
      if (err instanceof BadEventQueueError) {
        logger.info?.("zulip queue expired, re-registering immediately");
        continue;
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}
