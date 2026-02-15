export type ZulipClient = {
  serverUrl: string;
  botEmail: string;
  apiKey: string;
  authHeader: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type ZulipProfile = {
  user_id: number;
  email: string;
  full_name: string;
};

export type ZulipMessage = {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  type: "stream" | "private";
  stream_id?: number;
  display_recipient: string | Array<{ id: number; email: string; full_name: string }>;
  subject?: string;
  content: string;
  timestamp: number;
};

export type ZulipEventQueueRegistration = {
  queue_id: string;
  last_event_id: number;
};

export type ZulipEvent = {
  type: string;
  id: number;
  message?: ZulipMessage;
};

export type ZulipUploadResult = {
  uri: string;
};

function normalizeServerUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

async function readZulipError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { msg?: string } | undefined;
    if (data?.msg) return data.msg;
    return JSON.stringify(data);
  }
  return await res.text();
}

export function createZulipClient(params: {
  serverUrl: string;
  botEmail: string;
  apiKey: string;
}): ZulipClient {
  const serverUrl = normalizeServerUrl(params.serverUrl);
  if (!serverUrl) throw new Error("Zulip serverUrl is required");
  const botEmail = params.botEmail.trim();
  const apiKey = params.apiKey.trim();
  if (!botEmail || !apiKey) throw new Error("Zulip botEmail and apiKey are required");

  const authHeader = "Basic " + Buffer.from(`${botEmail}:${apiKey}`).toString("base64");

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = `${serverUrl}/api/v1${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authHeader);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readZulipError(res);
      throw new Error(`Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
    }
    return (await res.json()) as T;
  };

  return { serverUrl, botEmail, apiKey, authHeader, request };
}

export async function getZulipProfile(client: ZulipClient): Promise<ZulipProfile> {
  const data = await client.request<ZulipProfile & { result: string }>("/users/me");
  return data;
}

export async function registerZulipEventQueue(
  client: ZulipClient,
): Promise<ZulipEventQueueRegistration> {
  const body = new URLSearchParams();
  body.set("event_types", JSON.stringify(["message"]));
  body.set("apply_markdown", "false");
  const data = await client.request<ZulipEventQueueRegistration & { result: string }>(
    "/register",
    { method: "POST", body: body.toString() },
  );
  return { queue_id: data.queue_id, last_event_id: data.last_event_id };
}

export async function pollZulipEvents(
  client: ZulipClient,
  queueId: string,
  lastEventId: number,
  signal?: AbortSignal,
): Promise<ZulipEvent[]> {
  const params = new URLSearchParams();
  params.set("queue_id", queueId);
  params.set("last_event_id", String(lastEventId));
  const url = `${client.serverUrl}/api/v1/events?${params.toString()}`;
  const headers = new Headers();
  headers.set("Authorization", client.authHeader);
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip poll ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { events: ZulipEvent[] };
  return data.events ?? [];
}

export async function sendZulipApiMessage(
  client: ZulipClient,
  params: {
    type: "stream" | "direct";
    to: string;
    topic?: string;
    content: string;
  },
): Promise<{ id: number }> {
  const body = new URLSearchParams();
  body.set("type", params.type);
  body.set("to", params.to);
  if (params.topic) body.set("topic", params.topic);
  body.set("content", params.content);
  const data = await client.request<{ id: number; result: string }>("/messages", {
    method: "POST",
    body: body.toString(),
  });
  return { id: data.id };
}

// ── Stream / Channel management ──

export type ZulipStream = {
  stream_id: number;
  name: string;
  description: string;
  invite_only: boolean;
  is_web_public: boolean;
  date_created: number;
};

export type ZulipSubscription = ZulipStream & {
  color: string;
  is_muted: boolean;
};

export type ZulipTopic = {
  name: string;
  max_id: number;
};

export async function listZulipStreams(
  client: ZulipClient,
  includePublic = true,
): Promise<ZulipStream[]> {
  const params = new URLSearchParams();
  if (includePublic) params.set("include_public", "true");
  const data = await client.request<{ streams: ZulipStream[] }>(
    `/streams?${params.toString()}`,
  );
  return data.streams ?? [];
}

export async function listZulipSubscriptions(
  client: ZulipClient,
): Promise<ZulipSubscription[]> {
  const data = await client.request<{ subscriptions: ZulipSubscription[] }>(
    "/users/me/subscriptions",
  );
  return data.subscriptions ?? [];
}

export async function subscribeZulipStream(
  client: ZulipClient,
  params: {
    name: string;
    description?: string;
    isPrivate?: boolean;
  },
): Promise<{ already_subscribed: Record<string, string[]>; subscribed: Record<string, string[]> }> {
  const body = new URLSearchParams();
  const sub: Record<string, string> = { name: params.name };
  if (params.description) sub.description = params.description;
  body.set("subscriptions", JSON.stringify([sub]));
  if (params.isPrivate) body.set("invite_only", "true");
  const data = await client.request<{
    already_subscribed: Record<string, string[]>;
    subscribed: Record<string, string[]>;
  }>("/users/me/subscriptions", {
    method: "POST",
    body: body.toString(),
  });
  return data;
}

export async function unsubscribeZulipStream(
  client: ZulipClient,
  streamName: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("subscriptions", JSON.stringify([streamName]));
  await client.request<{ result: string }>("/users/me/subscriptions", {
    method: "DELETE",
    body: body.toString(),
  });
}

export async function getZulipStreamTopics(
  client: ZulipClient,
  streamId: number,
): Promise<ZulipTopic[]> {
  const data = await client.request<{ topics: ZulipTopic[] }>(
    `/users/me/${streamId}/topics`,
  );
  return data.topics ?? [];
}

export async function updateZulipStream(
  client: ZulipClient,
  streamId: number,
  params: { description?: string; newName?: string; isPrivate?: boolean },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.description !== undefined) body.set("description", params.description);
  if (params.newName !== undefined) body.set("new_name", params.newName);
  if (params.isPrivate !== undefined) body.set("is_private", String(params.isPrivate));
  await client.request<{ result: string }>(`/streams/${streamId}`, {
    method: "PATCH",
    body: body.toString(),
  });
}

export async function deleteZulipStream(
  client: ZulipClient,
  streamId: number,
): Promise<void> {
  await client.request<{ result: string }>(`/streams/${streamId}`, {
    method: "DELETE",
  });
}

export async function getZulipStreamMembers(
  client: ZulipClient,
  streamId: number,
): Promise<number[]> {
  const data = await client.request<{ subscribers: number[] }>(
    `/streams/${streamId}/members`,
  );
  return data.subscribers ?? [];
}

// ── Emoji Reactions ──

export async function addZulipReaction(
  client: ZulipClient,
  messageId: number,
  emojiName: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("emoji_name", emojiName);
  await client.request<{ result: string }>(`/messages/${messageId}/reactions`, {
    method: "POST",
    body: body.toString(),
  });
}

// ── Typing indicator ──

export async function sendZulipTyping(
  client: ZulipClient,
  params: {
    op: "start" | "stop";
    to: number[];        // user ids for DM
    streamId?: number;   // for stream typing
    topic?: string;      // for stream typing
  },
): Promise<void> {
  const body = new URLSearchParams();
  body.set("op", params.op);
  if (params.streamId !== undefined) {
    body.set("type", "stream");
    body.set("stream_id", String(params.streamId));
    if (params.topic) body.set("topic", params.topic);
  } else {
    body.set("type", "direct");
    body.set("to", JSON.stringify(params.to));
  }
  await client.request<{ result: string }>("/typing", {
    method: "POST",
    body: body.toString(),
  });
}

export async function uploadZulipFile(
  client: ZulipClient,
  buffer: Buffer,
  fileName: string,
  contentType?: string,
): Promise<ZulipUploadResult> {
  const form = new FormData();
  const bytes = Uint8Array.from(buffer);
  const blob = contentType ? new Blob([bytes], { type: contentType }) : new Blob([bytes]);
  form.append("file", blob, fileName);

  const url = `${client.serverUrl}/api/v1/user_uploads`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: client.authHeader },
    body: form,
  });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip upload ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { uri: string };
  return { uri: data.uri };
}
