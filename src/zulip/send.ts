import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  sendZulipApiMessage,
  uploadZulipFile,
} from "./client.js";

export type ZulipSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  replyToId?: string;
};

export type ZulipSendResult = {
  messageId: string;
};

/**
 * Parse target string:
 * - "stream:streamName:topic" → stream message
 * - "dm:userId" or "dm:[id1,id2]" → direct message
 * - "user:userId" → direct message (alias)
 */
function parseZulipTarget(raw: string): {
  type: "stream" | "direct";
  to: string;
  topic?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Zulip target is required");

  if (trimmed.toLowerCase().startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) {
      return { type: "stream", to: rest, topic: "(no topic)" };
    }
    return {
      type: "stream",
      to: rest.slice(0, colonIdx),
      topic: rest.slice(colonIdx + 1) || "(no topic)",
    };
  }

  if (trimmed.toLowerCase().startsWith("dm:") || trimmed.toLowerCase().startsWith("user:")) {
    const prefix = trimmed.includes(":") ? trimmed.slice(0, trimmed.indexOf(":") + 1) : "";
    const id = trimmed.slice(prefix.length).trim();
    return { type: "direct", to: JSON.stringify([Number(id) || id]) };
  }

  // Default: treat as stream name with default topic
  return { type: "stream", to: trimmed, topic: "(no topic)" };
}

export async function sendZulipMessage(
  to: string,
  text: string,
  opts: ZulipSendOpts = {},
): Promise<ZulipSendResult> {
  const core = getZulipRuntime();
  const cfg = core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });

  const serverUrl = account.serverUrl;
  const botEmail = account.botEmail;
  const apiKey = account.apiKey;
  if (!serverUrl || !botEmail || !apiKey) {
    throw new Error(
      `Zulip credentials missing for account "${account.accountId}" (set channels.zulip.serverUrl, botEmail, apiKey).`,
    );
  }

  const client = createZulipClient({ serverUrl, botEmail, apiKey });
  const target = parseZulipTarget(to);
  let content = text?.trim() ?? "";

  // Handle media upload
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const uploaded = await uploadZulipFile(
        client,
        media.buffer,
        media.fileName ?? "upload",
        media.contentType ?? undefined,
      );
      const mediaLink = `[${media.fileName ?? "file"}](${uploaded.uri})`;
      content = content ? `${content}\n${mediaLink}` : mediaLink;
    } catch {
      // Fallback: include URL as text if upload fails
      if (/^https?:\/\//i.test(mediaUrl)) {
        content = content ? `${content}\n${mediaUrl}` : mediaUrl;
      }
    }
  }

  if (!content) throw new Error("Zulip message is empty");

  const result = await sendZulipApiMessage(client, {
    type: target.type,
    to: target.to,
    topic: target.topic,
    content,
  });

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId: String(result.id) };
}
