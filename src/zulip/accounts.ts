import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

export type ZulipAccountConfig = {
  enabled?: boolean;
  name?: string;
  serverUrl?: string;
  botEmail?: string;
  apiKey?: string;
  dmPolicy?: "open" | "pairing" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: { minChars?: number; idleMs?: number };
};

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  serverUrl?: string;
  botEmail?: string;
  apiKey?: string;
  config: ZulipAccountConfig;
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: ZulipAccountConfig["blockStreamingCoalesce"];
};

function mergeZulipAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.zulip as
    | (ZulipAccountConfig & { accounts?: Record<string, ZulipAccountConfig> })
    | undefined;
  if (!section) return {};
  const { accounts: _ignored, ...base } = section;
  const account = section.accounts?.[accountId] ?? {};
  return { ...base, ...account };
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.zulip as
    | { accounts?: Record<string, unknown> }
    | undefined;
  const accounts = section?.accounts;
  if (!accounts || typeof accounts !== "object") return [DEFAULT_ACCOUNT_ID];
  const ids = Object.keys(accounts).filter(Boolean);
  return ids.length > 0 ? ids.toSorted((a, b) => a.localeCompare(b)) : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const section = (params.cfg.channels as Record<string, unknown> | undefined)?.zulip as
    | { enabled?: boolean }
    | undefined;
  const baseEnabled = section?.enabled !== false;
  const merged = mergeZulipAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    serverUrl: merged.serverUrl?.trim() || undefined,
    botEmail: merged.botEmail?.trim() || undefined,
    apiKey: merged.apiKey?.trim() || undefined,
    config: merged,
    requireMention: merged.requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
  };
}
