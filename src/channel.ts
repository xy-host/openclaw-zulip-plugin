import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { sendZulipMessage } from "./zulip/send.js";
import { getZulipRuntime } from "./runtime.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  detailLabel: "Zulip Bot",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "Open-source team chat with streams & topics; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 70,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^(zulip|user):/i, "").toLowerCase();
}

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = {
  id: "zulip",
  meta: { ...meta },
  pairing: {
    idLabel: "zulipUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[zulip] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    threads: true,
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.zulip"] },
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZulipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZulipAccountId(cfg),
    isConfigured: (account) => Boolean(account.serverUrl && account.botEmail && account.apiKey),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.serverUrl && account.botEmail && account.apiKey),
      serverUrl: account.serverUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => normalizeAllowEntry(String(e))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = `channels.zulip.`;
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 10000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Zulip requires --to <stream:name:topic|dm:userId>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendZulipMessage(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "zulip", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendZulipMessage(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
      });
      return { channel: "zulip", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      serverUrl: snapshot.serverUrl ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.serverUrl && account.botEmail && account.apiKey),
      serverUrl: account.serverUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        serverUrl: account.serverUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting Zulip channel`);
      return monitorZulipProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
