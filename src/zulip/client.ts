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

/**
 * Combine multiple AbortSignals into one. Uses native AbortSignal.any()
 * when available (Node.js >= 20), falls back to manual listener wiring.
 *
 * Returns { signal, cleanup } — caller MUST invoke cleanup() when the
 * combined signal is no longer needed to avoid listener leaks in the
 * polyfill path.
 */
function combineAbortSignals(...signals: AbortSignal[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => {} };
  }
  if (valid.length === 1) {
    return { signal: valid[0], cleanup: () => {} };
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(valid), cleanup: () => {} };
  }
  // Polyfill for Node.js < 20
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
  for (const sig of valid) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const handler = () => controller.abort(sig.reason);
    sig.addEventListener("abort", handler, { once: true });
    listeners.push({ signal: sig, handler });
  }
  const cleanup = () => {
    for (const { signal: sig, handler } of listeners) {
      sig.removeEventListener("abort", handler);
    }
    listeners.length = 0;
  };
  return { signal: controller.signal, cleanup };
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

/**
 * Get the full user object for the currently authenticated user (the bot itself).
 * Returns the same ZulipUser shape as getZulipUser but for the bot's own account.
 */
export async function getZulipOwnUser(client: ZulipClient): Promise<ZulipUser> {
  const data = await client.request<{ result: string } & ZulipUser>("/users/me");
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

export class BadEventQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadEventQueueError";
  }
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
  // Timeout for long-polling: 90s (Zulip server default is ~60s)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const combined = signal
    ? combineAbortSignals(signal, controller.signal)
    : { signal: controller.signal, cleanup: () => {} };
  try {
    const res = await fetch(url, { headers, signal: combined.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const detail = await readZulipError(res);
      // Detect expired/invalid queue
      if (res.status === 400 && detail.includes("BAD_EVENT_QUEUE_ID")) {
        throw new BadEventQueueError(`Queue expired: ${detail}`);
      }
      throw new Error(`Zulip poll ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { events: ZulipEvent[] };
    return data.events ?? [];
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  } finally {
    combined.cleanup();
  }
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
  pin_to_top?: boolean;
  desktop_notifications?: boolean | null;
  audible_notifications?: boolean | null;
  push_notifications?: boolean | null;
  email_notifications?: boolean | null;
  wildcard_mentions_notify?: boolean | null;
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

/**
 * Shared helper for subscribing users to a stream.
 * When principals is omitted, subscribes the bot itself.
 * When principals is provided, subscribes the specified users.
 */
async function subscribeToStream(
  client: ZulipClient,
  params: {
    name: string;
    description?: string;
    isPrivate?: boolean;
    principals?: number[];
  },
): Promise<{ already_subscribed: Record<string, string[]>; subscribed: Record<string, string[]> }> {
  const body = new URLSearchParams();
  const sub: Record<string, string> = { name: params.name };
  if (params.description) sub.description = params.description;
  body.set("subscriptions", JSON.stringify([sub]));
  if (params.principals && params.principals.length > 0) {
    body.set("principals", JSON.stringify(params.principals));
  }
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

export async function subscribeZulipStream(
  client: ZulipClient,
  params: {
    name: string;
    description?: string;
    isPrivate?: boolean;
  },
): Promise<{ already_subscribed: Record<string, string[]>; subscribed: Record<string, string[]> }> {
  return subscribeToStream(client, params);
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


/**
 * Subscribe one or more users (by user ID) to a stream.
 * The bot must have permission to subscribe other users.
 * Uses the `principals` parameter of POST /users/me/subscriptions.
 */
export async function subscribeUsersToZulipStream(
  client: ZulipClient,
  params: {
    name: string;
    userIds: number[];
    description?: string;
    isPrivate?: boolean;
  },
): Promise<{ already_subscribed: Record<string, string[]>; subscribed: Record<string, string[]> }> {
  return subscribeToStream(client, {
    name: params.name,
    description: params.description,
    isPrivate: params.isPrivate,
    principals: params.userIds,
  });
}

/**
 * Unsubscribe one or more users (by user ID) from a stream.
 * The bot must have permission to remove other users from streams.
 * Uses the `principals` parameter of DELETE /users/me/subscriptions.
 */
export async function unsubscribeUsersFromZulipStream(
  client: ZulipClient,
  streamName: string,
  userIds: number[],
): Promise<void> {
  const body = new URLSearchParams();
  body.set("subscriptions", JSON.stringify([streamName]));
  body.set("principals", JSON.stringify(userIds));
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

// ── Users ──

export type ZulipUser = {
  user_id: number;
  email: string;
  full_name: string;
  is_bot: boolean;
  is_active: boolean;
  role: number;
  avatar_url?: string;
  date_joined?: string;
  timezone?: string;
};

export type ZulipPresence = {
  [client: string]: {
    status: "active" | "idle" | "offline";
    timestamp: number;
  };
};

export type ZulipUserPresence = {
  presence: ZulipPresence;
};

export type ZulipRealmPresenceEntry = {
  [clientOrAggregated: string]: {
    client: string;
    status: "active" | "idle";
    timestamp: number;
    pushable?: boolean;
  };
};

export type ZulipRealmPresenceResult = {
  presences: Record<string, ZulipRealmPresenceEntry>;
  server_timestamp: number;
};

export type ZulipRealmPresenceEntryValue = {
  client?: string;
  status: "active" | "idle" | "offline";
  timestamp: number;
  pushable?: boolean;
};

export type ZulipRealmPresenceEntry = {
  [clientOrAggregated: string]: ZulipRealmPresenceEntryValue;
};

export type ZulipRealmPresenceResult = {
  presences: Record<string, ZulipRealmPresenceEntry>;
  server_timestamp: number;
};

export async function listZulipUsers(
  client: ZulipClient,
): Promise<ZulipUser[]> {
  const data = await client.request<{ members: ZulipUser[] }>("/users");
  return data.members ?? [];
}

export async function getZulipUser(
  client: ZulipClient,
  userId: number,
): Promise<ZulipUser> {
  const data = await client.request<{ user: ZulipUser }>(`/users/${userId}`);
  return data.user;
}

export async function getZulipUserByEmail(
  client: ZulipClient,
  email: string,
): Promise<ZulipUser> {
  const data = await client.request<{ user: ZulipUser }>(
    `/users/${encodeURIComponent(email)}`,
  );
  return data.user;
}

export async function getZulipUserPresence(
  client: ZulipClient,
  userId: number,
): Promise<ZulipUserPresence> {
  const data = await client.request<{ presence: ZulipPresence }>(
    `/users/${userId}/presence`,
  );
  return { presence: data.presence };
}

/**
 * Get the presence information of all users in the organization.
 * Returns a dictionary keyed by user email with their presence status.
 * Much more efficient than querying individual user presence one at a time.
 */
export async function getZulipRealmPresence(
  client: ZulipClient,
): Promise<ZulipRealmPresenceResult> {
  const data = await client.request<{
    presences: Record<string, ZulipRealmPresenceEntry>;
    server_timestamp: number;
    result: string;
  }>("/realm/presence");
  return {
    presences: data.presences ?? {},
    server_timestamp: data.server_timestamp,
  };
}



// ── Own Presence ──

export type ZulipOwnPresenceResult = {
  presences: Record<string, ZulipRealmPresenceEntry>;
  server_timestamp: number;
};

/**
 * Update the current user’s (bot’s) presence status.
 * Clients are expected to call this approximately every minute to keep
 * the user appearing as online. If no update is sent for ~140 seconds,
 * the server marks the user as offline.
 *
 * Uses POST /users/me/presence.
 *
 * @param status - "active" (recently interacted) or "idle" (no recent interaction).
 * @param pingOnly - When true, only updates the last-active timestamp without
 *   changing the status value (default: false). Requires Zulip 10.0+ (feature level 300).
 * @param newClientName - Optional client identifier string sent as the
 *   "new_user_input" parameter (default: "true" for active, "false" for idle).
 */
export async function updateZulipOwnPresence(
  client: ZulipClient,
  params: {
    status: "active" | "idle";
    pingOnly?: boolean;
    newClientName?: string;
  },
): Promise<ZulipOwnPresenceResult> {
  const body = new URLSearchParams();
  body.set("status", params.status);
  if (params.pingOnly === true) {
    body.set("ping_only", "true");
  }
  if (params.newClientName !== undefined) {
    body.set("new_user_input", params.newClientName);
  }
  const data = await client.request<{
    presences: Record<string, ZulipRealmPresenceEntry>;
    server_timestamp: number;
    result: string;
  }>("/users/me/presence", {
    method: "POST",
    body: body.toString(),
  });
  return {
    presences: data.presences ?? {},
    server_timestamp: data.server_timestamp,
  };
}

// ── Messages ──

export type ZulipMessageDetails = {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  type: "stream" | "private";
  stream_id?: number;
  display_recipient: string | Array<{ id: number; email: string; full_name: string }>;
  subject: string;
  content: string;
  timestamp: number;
  reactions: Array<{
    emoji_name: string;
    user_id: number;
  }>;
  flags: string[];
};

export type ZulipGetMessagesResult = {
  messages: ZulipMessageDetails[];
  found_anchor: boolean;
  found_oldest: boolean;
  found_newest: boolean;
};

export async function getZulipMessages(
  client: ZulipClient,
  params: {
    anchor: string | number;
    numBefore: number;
    numAfter: number;
    narrow?: Array<{ operator: string; operand: string | number }>;
    applyMarkdown?: boolean;
    includeAnchor?: boolean;
  },
): Promise<ZulipGetMessagesResult> {
  const qs = new URLSearchParams();
  qs.set("anchor", String(params.anchor));
  qs.set("num_before", String(params.numBefore));
  qs.set("num_after", String(params.numAfter));
  if (params.narrow) {
    qs.set("narrow", JSON.stringify(params.narrow));
  }
  qs.set("apply_markdown", params.applyMarkdown === true ? "true" : "false");
  if (params.includeAnchor !== undefined) {
    qs.set("include_anchor", String(params.includeAnchor));
  }
  const data = await client.request<ZulipGetMessagesResult & { result: string }>(
    `/messages?${qs.toString()}`,
  );
  return data;
}

export async function getZulipSingleMessage(
  client: ZulipClient,
  messageId: number,
): Promise<ZulipMessageDetails> {
  const qs = new URLSearchParams();
  qs.set("apply_markdown", "false");
  const data = await client.request<{ message: ZulipMessageDetails; result: string }>(
    `/messages/${messageId}?${qs.toString()}`,
  );
  return data.message;
}

export async function updateZulipMessage(
  client: ZulipClient,
  messageId: number,
  params: {
    content?: string;
    topic?: string;
    propagateMode?: "change_one" | "change_later" | "change_all";
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.content !== undefined) body.set("content", params.content);
  if (params.topic !== undefined) body.set("topic", params.topic);
  if (params.propagateMode !== undefined) body.set("propagate_mode", params.propagateMode);
  await client.request<{ result: string }>(`/messages/${messageId}`, {
    method: "PATCH",
    body: body.toString(),
  });
}

export async function deleteZulipMessage(
  client: ZulipClient,
  messageId: number,
): Promise<void> {
  await client.request<{ result: string }>(`/messages/${messageId}`, {
    method: "DELETE",
  });
}

export async function removeZulipReaction(
  client: ZulipClient,
  messageId: number,
  emojiName: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("emoji_name", emojiName);
  await client.request<{ result: string }>(`/messages/${messageId}/reactions`, {
    method: "DELETE",
    body: body.toString(),
  });
}

// ── Scheduled Messages ──

export type ZulipScheduledMessage = {
  scheduled_message_id: number;
  type: "stream" | "private";
  to: number | number[];
  topic?: string;
  content: string;
  rendered_content: string;
  scheduled_delivery_timestamp: number;
  failed: boolean;
};

export async function listZulipScheduledMessages(
  client: ZulipClient,
): Promise<ZulipScheduledMessage[]> {
  const data = await client.request<{
    scheduled_messages: ZulipScheduledMessage[];
  }>("/scheduled_messages");
  return data.scheduled_messages ?? [];
}

export async function createZulipScheduledMessage(
  client: ZulipClient,
  params: {
    type: "stream" | "direct";
    to: number | number[];
    content: string;
    scheduledDeliveryTimestamp: number;
    topic?: string;
  },
): Promise<{ scheduled_message_id: number }> {
  const body = new URLSearchParams();
  body.set("type", params.type);
  body.set(
    "to",
    typeof params.to === "number"
      ? String(params.to)
      : JSON.stringify(params.to),
  );
  body.set("content", params.content);
  body.set(
    "scheduled_delivery_timestamp",
    String(params.scheduledDeliveryTimestamp),
  );
  if (params.topic) body.set("topic", params.topic);
  const data = await client.request<{
    scheduled_message_id: number;
    result: string;
  }>("/scheduled_messages", {
    method: "POST",
    body: body.toString(),
  });
  return { scheduled_message_id: data.scheduled_message_id };
}

export async function updateZulipScheduledMessage(
  client: ZulipClient,
  scheduledMessageId: number,
  params: {
    type?: "stream" | "direct";
    to?: number | number[];
    content?: string;
    topic?: string;
    scheduledDeliveryTimestamp?: number;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.type !== undefined) body.set("type", params.type);
  if (params.to !== undefined) {
    body.set(
      "to",
      typeof params.to === "number"
        ? String(params.to)
        : JSON.stringify(params.to),
    );
  }
  if (params.content !== undefined) body.set("content", params.content);
  if (params.topic !== undefined) body.set("topic", params.topic);
  if (params.scheduledDeliveryTimestamp !== undefined) {
    body.set(
      "scheduled_delivery_timestamp",
      String(params.scheduledDeliveryTimestamp),
    );
  }
  await client.request<{ result: string }>(
    `/scheduled_messages/${scheduledMessageId}`,
    { method: "PATCH", body: body.toString() },
  );
}

export async function deleteZulipScheduledMessage(
  client: ZulipClient,
  scheduledMessageId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/scheduled_messages/${scheduledMessageId}`,
    { method: "DELETE" },
  );
}

// ── User Groups ──

export type ZulipUserGroup = {
  id: number;
  name: string;
  description: string;
  members: number[];
  is_system_group: boolean;
};

export async function listZulipUserGroups(
  client: ZulipClient,
): Promise<ZulipUserGroup[]> {
  const data = await client.request<{ user_groups: ZulipUserGroup[] }>(
    "/user_groups",
  );
  return data.user_groups ?? [];
}

export async function createZulipUserGroup(
  client: ZulipClient,
  params: {
    name: string;
    description?: string;
    members: number[];
  },
): Promise<void> {
  const body = new URLSearchParams();
  body.set("name", params.name);
  body.set("description", params.description ?? "");
  body.set("members", JSON.stringify(params.members));
  await client.request<{ result: string }>("/user_groups/create", {
    method: "POST",
    body: body.toString(),
  });
}

export async function updateZulipUserGroup(
  client: ZulipClient,
  groupId: number,
  params: {
    name?: string;
    description?: string;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.name !== undefined) body.set("name", params.name);
  if (params.description !== undefined) body.set("description", params.description);
  await client.request<{ result: string }>(`/user_groups/${groupId}`, {
    method: "PATCH",
    body: body.toString(),
  });
}

export async function deleteZulipUserGroup(
  client: ZulipClient,
  groupId: number,
): Promise<void> {
  await client.request<{ result: string }>(`/user_groups/${groupId}`, {
    method: "DELETE",
  });
}

export async function getZulipUserGroupMembers(
  client: ZulipClient,
  groupId: number,
): Promise<number[]> {
  const data = await client.request<{ members: number[] }>(
    `/user_groups/${groupId}/members`,
  );
  return data.members ?? [];
}

export async function updateZulipUserGroupMembers(
  client: ZulipClient,
  groupId: number,
  params: {
    add?: number[];
    remove?: number[];
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.add && params.add.length > 0) {
    body.set("add", JSON.stringify(params.add));
  }
  if (params.remove && params.remove.length > 0) {
    body.set("delete", JSON.stringify(params.remove));
  }
  await client.request<{ result: string }>(
    `/user_groups/${groupId}/members`,
    { method: "POST", body: body.toString() },
  );
}

// ── Custom Emoji ──

export type ZulipCustomEmoji = {
  id: string;
  name: string;
  source_url: string;
  deactivated: boolean;
  author_id: number | null;
};

export async function listZulipCustomEmoji(
  client: ZulipClient,
): Promise<ZulipCustomEmoji[]> {
  const data = await client.request<{ emoji: Record<string, ZulipCustomEmoji> }>(
    "/realm/emoji",
  );
  const emoji = data.emoji ?? {};
  return Object.values(emoji);
}

export async function uploadZulipCustomEmoji(
  client: ZulipClient,
  emojiName: string,
  imageBuffer: Buffer,
  fileName?: string,
  contentType?: string,
): Promise<void> {
  const form = new FormData();
  const bytes = Uint8Array.from(imageBuffer);
  const blob = contentType ? new Blob([bytes], { type: contentType }) : new Blob([bytes]);
  form.append("file", blob, fileName ?? `${emojiName}.png`);

  const url = `${client.serverUrl}/api/v1/realm/emoji/${encodeURIComponent(emojiName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: client.authHeader },
    body: form,
  });
  if (!res.ok) {
    const detail = await readZulipError(res);
    throw new Error(`Zulip upload emoji ${res.status}: ${detail}`);
  }
}

export async function deactivateZulipCustomEmoji(
  client: ZulipClient,
  emojiId: string,
): Promise<void> {
  await client.request<{ result: string }>(
    `/realm/emoji/${encodeURIComponent(emojiId)}`,
    { method: "DELETE" },
  );
}

// ── Drafts ──

export type ZulipDraft = {
  id: number;
  type: "stream" | "private";
  to: number[];
  topic: string;
  content: string;
  timestamp: number;
};

export async function listZulipDrafts(
  client: ZulipClient,
): Promise<ZulipDraft[]> {
  const data = await client.request<{ drafts: ZulipDraft[] }>("/drafts");
  return data.drafts ?? [];
}

export async function createZulipDraft(
  client: ZulipClient,
  params: {
    type: "stream" | "private";
    to: number[];
    topic?: string;
    content: string;
  },
): Promise<number[]> {
  const draft: Record<string, unknown> = {
    type: params.type,
    to: params.to,
    content: params.content,
  };
  if (params.topic !== undefined) draft.topic = params.topic;
  // Always include a timestamp so the server knows when the draft was composed
  draft.timestamp = Math.floor(Date.now() / 1000);

  const body = new URLSearchParams();
  body.set("drafts", JSON.stringify([draft]));
  const data = await client.request<{ ids: number[]; result: string }>("/drafts", {
    method: "POST",
    body: body.toString(),
  });
  return data.ids ?? [];
}

export async function editZulipDraft(
  client: ZulipClient,
  draftId: number,
  params: {
    type: "stream" | "private";
    to: number[];
    topic?: string;
    content: string;
  },
): Promise<void> {
  const draft: Record<string, unknown> = {
    type: params.type,
    to: params.to,
    content: params.content,
    timestamp: Math.floor(Date.now() / 1000),
  };
  if (params.topic !== undefined) draft.topic = params.topic;

  const body = new URLSearchParams();
  body.set("draft", JSON.stringify(draft));
  await client.request<{ result: string }>(`/drafts/${draftId}`, {
    method: "PATCH",
    body: body.toString(),
  });
}

export async function deleteZulipDraft(
  client: ZulipClient,
  draftId: number,
): Promise<void> {
  await client.request<{ result: string }>(`/drafts/${draftId}`, {
    method: "DELETE",
  });
}

// ── Topics ──

/**
 * Delete a topic by removing all messages in it.
 * This is an admin-only endpoint. The server processes deletions in batches;
 * when `complete` is false the caller should repeat the request.
 */
export async function deleteZulipTopic(
  client: ZulipClient,
  streamId: number,
  topicName: string,
): Promise<{ complete: boolean }> {
  const body = new URLSearchParams();
  body.set("topic_name", topicName);
  const data = await client.request<{ complete: boolean; result: string }>(
    `/streams/${streamId}/delete_topic`,
    { method: "POST", body: body.toString() },
  );
  return { complete: data.complete };
}

// ── Linkifiers ──

export type ZulipLinkifier = {
  id: number;
  pattern: string;
  url_template: string;
};

export async function listZulipLinkifiers(
  client: ZulipClient,
): Promise<ZulipLinkifier[]> {
  const data = await client.request<{ linkifiers: ZulipLinkifier[] }>(
    "/realm/linkifiers",
  );
  return data.linkifiers ?? [];
}

export async function addZulipLinkifier(
  client: ZulipClient,
  params: {
    pattern: string;
    urlTemplate: string;
  },
): Promise<{ id: number }> {
  const body = new URLSearchParams();
  body.set("pattern", params.pattern);
  body.set("url_template", params.urlTemplate);
  const data = await client.request<{ id: number; result: string }>(
    "/realm/filters",
    { method: "POST", body: body.toString() },
  );
  return { id: data.id };
}

export async function updateZulipLinkifier(
  client: ZulipClient,
  filterId: number,
  params: {
    pattern: string;
    urlTemplate: string;
  },
): Promise<void> {
  const body = new URLSearchParams();
  body.set("pattern", params.pattern);
  body.set("url_template", params.urlTemplate);
  await client.request<{ result: string }>(
    `/realm/filters/${filterId}`,
    { method: "PATCH", body: body.toString() },
  );
}

export async function removeZulipLinkifier(
  client: ZulipClient,
  filterId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/realm/filters/${filterId}`,
    { method: "DELETE" },
  );
}

export async function reorderZulipLinkifiers(
  client: ZulipClient,
  orderedIds: number[],
): Promise<void> {
  const body = new URLSearchParams();
  body.set("ordered_linkifier_ids", JSON.stringify(orderedIds));
  await client.request<{ result: string }>(
    "/realm/linkifiers",
    { method: "PATCH", body: body.toString() },
  );
}

// ── User Status ──

export type ZulipUserStatus = {
  status_text?: string;
  emoji_name?: string;
  emoji_code?: string;
  reaction_type?: string;
  away?: boolean;
};

export async function getZulipUserStatus(
  client: ZulipClient,
  userId: number,
): Promise<ZulipUserStatus> {
  const data = await client.request<{ status: ZulipUserStatus; result: string }>(
    `/users/${userId}/status`,
  );
  return data.status ?? {};
}

export async function updateZulipOwnStatus(
  client: ZulipClient,
  params: {
    statusText?: string;
    emojiName?: string;
    emojiCode?: string;
    reactionType?: string;
    away?: boolean;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.statusText !== undefined) body.set("status_text", params.statusText);
  if (params.emojiName !== undefined) body.set("emoji_name", params.emojiName);
  if (params.emojiCode !== undefined) body.set("emoji_code", params.emojiCode);
  if (params.reactionType !== undefined) body.set("reaction_type", params.reactionType);
  if (params.away !== undefined) body.set("away", String(params.away));
  await client.request<{ result: string }>("/users/me/status", {
    method: "POST",
    body: body.toString(),
  });
}

// ── Server & Organization Settings ──

export type ZulipServerSettings = {
  zulip_version: string;
  zulip_feature_level: number;
  zulip_merge_base?: string;
  push_notifications_enabled: boolean;
  is_incompatible: boolean;
  realm_name?: string;
  realm_description?: string;
  realm_icon?: string;
  realm_uri?: string;
};

export async function getZulipServerSettings(
  client: ZulipClient,
): Promise<ZulipServerSettings> {
  const data = await client.request<ZulipServerSettings & { result: string }>(
    "/server_settings",
  );
  return data;
}

// ── Custom Profile Fields ──

export type ZulipCustomProfileField = {
  id: number;
  name: string;
  type: number;
  hint: string;
  order: number;
  field_data?: string;
  display_in_profile_summary?: boolean;
};

/**
 * Type values:
 * 1 = Short text, 2 = Long text, 3 = List of options,
 * 4 = Date picker, 5 = Link, 6 = Person picker,
 * 7 = External account, 8 = Pronouns
 */
const PROFILE_FIELD_TYPE_NAMES: Record<number, string> = {
  1: "Short text",
  2: "Long text",
  3: "List of options",
  4: "Date picker",
  5: "Link",
  6: "Person picker",
  7: "External account",
  8: "Pronouns",
};

export function getProfileFieldTypeName(typeId: number): string {
  return PROFILE_FIELD_TYPE_NAMES[typeId] ?? `Unknown (${typeId})`;
}

export async function listZulipCustomProfileFields(
  client: ZulipClient,
): Promise<ZulipCustomProfileField[]> {
  const data = await client.request<{
    custom_fields: ZulipCustomProfileField[];
    result: string;
  }>("/realm/profile_fields");
  return data.custom_fields ?? [];
}

// ── User Profile Data ──

export type ZulipUserProfileData = Record<
  string,
  { value: string; rendered_value?: string }
>;

export async function getZulipUserProfileData(
  client: ZulipClient,
  userId: number,
): Promise<ZulipUserProfileData> {
  const data = await client.request<{
    user: { profile_data?: ZulipUserProfileData };
    result: string;
  }>(`/users/${userId}`);
  return data.user?.profile_data ?? {};
}

// ── Message Flags ──

export type ZulipMessageFlag =
  | "read"
  | "starred"
  | "collapsed"
  | "mentioned"
  | "wildcard_mentioned"
  | "has_alert_word"
  | "historical";

export type ZulipUpdateFlagsResult = {
  messages: number[];
};

/**
 * Add or remove personal message flags on a collection of message IDs.
 * Supports flags: read, starred, collapsed, etc.
 */
export async function updateZulipMessageFlags(
  client: ZulipClient,
  params: {
    messages: number[];
    op: "add" | "remove";
    flag: ZulipMessageFlag;
  },
): Promise<ZulipUpdateFlagsResult> {
  const body = new URLSearchParams();
  body.set("messages", JSON.stringify(params.messages));
  body.set("op", params.op);
  body.set("flag", params.flag);
  const data = await client.request<{
    messages: number[];
    result: string;
  }>("/messages/flags", {
    method: "POST",
    body: body.toString(),
  });
  return { messages: data.messages ?? [] };
}

/**
 * Add or remove personal message flags on a range of messages within a narrow.
 * More efficient than updateZulipMessageFlags for bulk operations on topics/streams.
 */
export async function updateZulipMessageFlagsForNarrow(
  client: ZulipClient,
  params: {
    anchor: string | number;
    numBefore: number;
    numAfter: number;
    narrow: Array<{ operator: string; operand: string | number }>;
    op: "add" | "remove";
    flag: ZulipMessageFlag;
    includeAnchor?: boolean;
  },
): Promise<{
  processed_count: number;
  updated_count: number;
  first_processed_id: number | null;
  last_processed_id: number | null;
  found_oldest: boolean;
  found_newest: boolean;
}> {
  const body = new URLSearchParams();
  body.set("anchor", String(params.anchor));
  body.set("num_before", String(params.numBefore));
  body.set("num_after", String(params.numAfter));
  body.set("narrow", JSON.stringify(params.narrow));
  body.set("op", params.op);
  body.set("flag", params.flag);
  if (params.includeAnchor !== undefined) {
    body.set("include_anchor", String(params.includeAnchor));
  }
  const data = await client.request<{
    processed_count: number;
    updated_count: number;
    first_processed_id: number | null;
    last_processed_id: number | null;
    found_oldest: boolean;
    found_newest: boolean;
    result: string;
  }>("/messages/flags/narrow", {
    method: "POST",
    body: body.toString(),
  });
  return {
    processed_count: data.processed_count,
    updated_count: data.updated_count,
    first_processed_id: data.first_processed_id,
    last_processed_id: data.last_processed_id,
    found_oldest: data.found_oldest,
    found_newest: data.found_newest,
  };
}

/**
 * Get the list of user IDs who have read a specific message.
 */
export async function getZulipReadReceipts(
  client: ZulipClient,
  messageId: number,
): Promise<number[]> {
  const data = await client.request<{
    user_ids: number[];
    result: string;
  }>(`/messages/${messageId}/read_receipts`);
  return data.user_ids ?? [];
}

// ── Alert Words ──

/**
 * Get the list of alert words configured for the bot user.
 * Alert words trigger notifications when any message contains one of these words.
 */
export async function listZulipAlertWords(
  client: ZulipClient,
): Promise<string[]> {
  const data = await client.request<{ alert_words: string[]; result: string }>(
    "/users/me/alert_words",
  );
  return data.alert_words ?? [];
}

/**
 * Add new alert words for the bot user.
 * Returns the full updated list of alert words.
 */
export async function addZulipAlertWords(
  client: ZulipClient,
  words: string[],
): Promise<string[]> {
  const body = new URLSearchParams();
  body.set("alert_words", JSON.stringify(words));
  const data = await client.request<{ alert_words: string[]; result: string }>(
    "/users/me/alert_words",
    { method: "POST", body: body.toString() },
  );
  return data.alert_words ?? [];
}

/**
 * Remove alert words for the bot user.
 * Returns the full updated list of alert words.
 */
export async function removeZulipAlertWords(
  client: ZulipClient,
  words: string[],
): Promise<string[]> {
  const body = new URLSearchParams();
  body.set("alert_words", JSON.stringify(words));
  const data = await client.request<{ alert_words: string[]; result: string }>(
    "/users/me/alert_words",
    { method: "DELETE", body: body.toString() },
  );
  return data.alert_words ?? [];
}

// ── User Topic Preferences (Visibility Policy) ──

/**
 * Visibility policy values for user topics:
 * 0 = None (remove policy)
 * 1 = Muted
 * 2 = Unmuted (useful in muted streams)
 * 3 = Followed
 */
export type ZulipTopicVisibilityPolicy = 0 | 1 | 2 | 3;

export const TOPIC_VISIBILITY_POLICIES: Record<string, ZulipTopicVisibilityPolicy> = {
  none: 0,
  muted: 1,
  unmuted: 2,
  followed: 3,
};

export const TOPIC_VISIBILITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Muted",
  2: "Unmuted",
  3: "Followed",
};

/**
 * Update the personal visibility policy for a topic in a stream.
 * Uses POST /user_topics (Zulip 7.0+, feature level 170).
 */
export async function updateZulipUserTopic(
  client: ZulipClient,
  params: {
    streamId: number;
    topic: string;
    visibilityPolicy: ZulipTopicVisibilityPolicy;
  },
): Promise<void> {
  const body = new URLSearchParams();
  body.set("stream_id", String(params.streamId));
  body.set("topic", params.topic);
  body.set("visibility_policy", String(params.visibilityPolicy));
  await client.request<{ result: string }>("/user_topics", {
    method: "POST",
    body: body.toString(),
  });
}

// ── User Topic Visibility Policies (list) ──

export type ZulipUserTopicEntry = {
  stream_id: number;
  topic_name: string;
  visibility_policy: ZulipTopicVisibilityPolicy;
  last_updated: number;
};

/**
 * List all topics for which the current user has set a visibility policy.
 * Returns topics with policies: muted (1), unmuted (2), or followed (3).
 * Topics with the default policy (0) are not returned.
 * Uses GET /user_topics (Zulip 9.0+, feature level 250).
 */
export async function listZulipUserTopics(
  client: ZulipClient,
): Promise<ZulipUserTopicEntry[]> {
  const data = await client.request<{
    user_topics: ZulipUserTopicEntry[];
    result: string;
  }>("/user_topics");
  return data.user_topics ?? [];
}

// ── Muted Users ──

export type ZulipMutedUser = {
  id: number;
  timestamp: number;
};

/**
 * Get the list of users muted by the current user.
 */
export async function listZulipMutedUsers(
  client: ZulipClient,
): Promise<ZulipMutedUser[]> {
  const data = await client.request<{ muted_users: ZulipMutedUser[]; result: string }>(
    "/users/me/muted_users",
  );
  return data.muted_users ?? [];
}

/**
 * Mute a user. Messages from muted users are automatically marked as read.
 */
export async function muteZulipUser(
  client: ZulipClient,
  userId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/users/me/muted_users/${userId}`,
    { method: "POST" },
  );
}

/**
 * Unmute a previously muted user.
 */
export async function unmuteZulipUser(
  client: ZulipClient,
  userId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/users/me/muted_users/${userId}`,
    { method: "DELETE" },
  );
}

// ── Stream Subscription Properties ──


export type ZulipSubscriptionProperty = {
  stream_id: number;
  property: string;
  value: unknown;
};

/**
 * Update per-stream subscription properties for the current user.
 * Each entry specifies a stream_id, property name, and new value.
 *
 * Supported properties:
 * - color (string): hex color like "#c6c6ff"
 * - is_muted (boolean): mute/unmute the entire stream
 * - pin_to_top (boolean): pin stream to top of sidebar
 * - desktop_notifications (boolean | null): per-stream desktop notification override (null = use global)
 * - audible_notifications (boolean | null): per-stream audible notification override (null = use global)
 * - push_notifications (boolean | null): per-stream push notification override (null = use global)
 * - email_notifications (boolean | null): per-stream email notification override (null = use global)
 * - wildcard_mentions_notify (boolean | null): per-stream wildcard mention (@all/@everyone) override (null = use global)
 */
export async function updateZulipSubscriptionProperties(
  client: ZulipClient,
  properties: ZulipSubscriptionProperty[],
): Promise<void> {
  const body = new URLSearchParams();
  body.set("subscription_data", JSON.stringify(properties));
  await client.request<{ result: string }>("/users/me/subscriptions/properties", {
    method: "POST",
    body: body.toString(),
  });
}

// ── Attachments ──

export type ZulipAttachment = {
  id: number;
  name: string;
  size: number;
  path_id: string;
  create_time: number;
  messages: Array<{
    id: number;
    date_sent: number;
  }>;
};

export type ZulipAttachmentsResult = {
  attachments: ZulipAttachment[];
  uploadSpaceUsed: number;
};

/**
 * List all files uploaded by the current user and return upload space usage.
 * Returns both the attachment list and total upload space used (in bytes).
 */
export async function listZulipAttachments(
  client: ZulipClient,
): Promise<ZulipAttachmentsResult> {
  const data = await client.request<{
    attachments: ZulipAttachment[];
    upload_space_used: number;
    result: string;
  }>("/attachments");
  return {
    attachments: data.attachments ?? [],
    uploadSpaceUsed: data.upload_space_used ?? 0,
  };
}

/**
 * Delete an uploaded file by its attachment ID.
 * Only the user who uploaded the file (or an admin) can delete it.
 */
export async function deleteZulipAttachment(
  client: ZulipClient,
  attachmentId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/attachments/${attachmentId}`,
    { method: "DELETE" },
  );
}

// ── Message Edit History ──

export type ZulipMessageHistoryEntry = {
  user_id: number | null;
  timestamp: number;
  prev_content?: string;
  content?: string;
  prev_rendered_content?: string;
  rendered_content?: string;
  prev_topic?: string;
  topic?: string;
  prev_stream?: number;
  stream?: number;
  content_html_diff?: string;
};

/**
 * Get the edit history of a message.
 * Returns a list of snapshots in chronological order (oldest first).
 * The first entry represents the original message; subsequent entries are edits.
 *
 * Requires the organization to have "allow_edit_history" enabled.
 */
export async function getZulipMessageHistory(
  client: ZulipClient,
  messageId: number,
): Promise<ZulipMessageHistoryEntry[]> {
  const data = await client.request<{
    message_history: ZulipMessageHistoryEntry[];
    result: string;
  }>(`/messages/${messageId}/history`);
  return data.message_history ?? [];
}

// ── Saved Snippets ──

export type ZulipSavedSnippet = {
  id: number;
  title: string;
  content: string;
  date_created: number;
};

/**
 * Get all saved snippets for the current user.
 * Saved snippets are reusable text templates that can be quickly inserted into messages.
 *
 * Requires Zulip 10.0+ (feature level 297).
 */
export async function listZulipSavedSnippets(
  client: ZulipClient,
): Promise<ZulipSavedSnippet[]> {
  const data = await client.request<{
    saved_snippets: ZulipSavedSnippet[];
    result: string;
  }>("/saved_snippets");
  return data.saved_snippets ?? [];
}

/**
 * Create a new saved snippet for the current user.
 * Returns the ID of the newly created snippet.
 *
 * Requires Zulip 10.0+ (feature level 297).
 */
export async function createZulipSavedSnippet(
  client: ZulipClient,
  params: {
    title: string;
    content: string;
  },
): Promise<{ saved_snippet_id: number }> {
  const body = new URLSearchParams();
  body.set("title", params.title);
  body.set("content", params.content);
  const data = await client.request<{
    saved_snippet_id: number;
    result: string;
  }>("/saved_snippets", {
    method: "POST",
    body: body.toString(),
  });
  return { saved_snippet_id: data.saved_snippet_id };
}

/**
 * Edit an existing saved snippet for the current user.
 *
 * Requires Zulip 10.0+ (feature level 368).
 */
export async function editZulipSavedSnippet(
  client: ZulipClient,
  snippetId: number,
  params: {
    title?: string;
    content?: string;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.title !== undefined) body.set("title", params.title);
  if (params.content !== undefined) body.set("content", params.content);
  await client.request<{ result: string }>(
    `/saved_snippets/${snippetId}`,
    { method: "PATCH", body: body.toString() },
  );
}

/**
 * Delete a saved snippet.
 *
 * Requires Zulip 10.0+ (feature level 297).
 */
export async function deleteZulipSavedSnippet(
  client: ZulipClient,
  snippetId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/saved_snippets/${snippetId}`,
    { method: "DELETE" },
  );
}

// ── Message Reminders ──

export type ZulipReminder = {
  reminder_id: number;
  type: string;
  to: number[];
  content: string;
  rendered_content: string;
  scheduled_delivery_timestamp: number;
  failed: boolean;
  reminder_target_message_id: number;
};

/**
 * Get all undelivered reminders for the current user.
 * Returns reminders ordered by scheduled_delivery_timestamp (ascending).
 *
 * Requires Zulip 11.0+ (feature level 399).
 */
export async function listZulipReminders(
  client: ZulipClient,
): Promise<ZulipReminder[]> {
  const data = await client.request<{
    reminders: ZulipReminder[];
    result: string;
  }>("/reminders");
  return data.reminders ?? [];
}

/**
 * Create a message reminder for the current user.
 * The reminder will be sent via Notification Bot at the specified time.
 *
 * Requires Zulip 11.0+ (feature level 381).
 * The `note` parameter requires feature level 415.
 */
export async function createZulipReminder(
  client: ZulipClient,
  params: {
    messageId: number;
    scheduledDeliveryTimestamp: number;
    note?: string;
  },
): Promise<{ reminder_id: number }> {
  const body = new URLSearchParams();
  body.set("message_id", String(params.messageId));
  body.set("scheduled_delivery_timestamp", String(params.scheduledDeliveryTimestamp));
  if (params.note !== undefined) body.set("note", params.note);
  const data = await client.request<{
    reminder_id: number;
    result: string;
  }>("/reminders", {
    method: "POST",
    body: body.toString(),
  });
  return { reminder_id: data.reminder_id };
}

/**
 * Delete a scheduled reminder.
 *
 * Requires Zulip 11.0+ (feature level 399).
 */
export async function deleteZulipReminder(
  client: ZulipClient,
  reminderId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/reminders/${reminderId}`,
    { method: "DELETE" },
  );
}

// ── Invitations ──

export type ZulipInvite = {
  id: number;
  invited_by_user_id: number;
  email?: string;
  is_multiuse: boolean;
  link?: string;
  invite_as: number;
  stream_ids: number[];
  invited: number;
  expiry_date: number | null;
  status: number;
};

/**
 * Human-friendly labels for the invite_as role values.
 */
export const INVITE_AS_LABELS: Record<number, string> = {
  100: "Organization owner",
  200: "Organization administrator",
  300: "Organization moderator",
  400: "Member",
  600: "Guest",
};

/**
 * List all unexpired invitations (both email invitations and reusable
 * invitation links) that the current user has permission to manage.
 */
export async function listZulipInvites(
  client: ZulipClient,
): Promise<ZulipInvite[]> {
  const data = await client.request<{
    invites: ZulipInvite[];
    result: string;
  }>("/invites");
  return data.invites ?? [];
}

/**
 * Send individual email invitations.
 * Requires appropriate permissions (typically admin or member with invite permission).
 */
export async function sendZulipInvites(
  client: ZulipClient,
  params: {
    inviteeEmails: string;
    streamIds: number[];
    inviteAs?: number;
    inviteExpiresInMinutes?: number | null;
    includeRealmDefaultSubscriptions?: boolean;
  },
): Promise<void> {
  const body = new URLSearchParams();
  body.set("invitee_emails", params.inviteeEmails);
  body.set("stream_ids", JSON.stringify(params.streamIds));
  if (params.inviteAs !== undefined) {
    body.set("invite_as", String(params.inviteAs));
  }
  if (params.inviteExpiresInMinutes !== undefined) {
    body.set(
      "invite_expires_in_minutes",
      params.inviteExpiresInMinutes === null ? "null" : String(params.inviteExpiresInMinutes),
    );
  }
  if (params.includeRealmDefaultSubscriptions !== undefined) {
    body.set(
      "include_realm_default_subscriptions",
      String(params.includeRealmDefaultSubscriptions),
    );
  }
  await client.request<{ result: string }>("/invites", {
    method: "POST",
    body: body.toString(),
  });
}

/**
 * Create a reusable invitation link.
 * Returns the invitation link URL.
 * Requires appropriate permissions (typically admin, or member with invite permission since Zulip 8.0).
 */
export async function createZulipInviteLink(
  client: ZulipClient,
  params: {
    streamIds: number[];
    inviteAs?: number;
    inviteExpiresInMinutes?: number | null;
    includeRealmDefaultSubscriptions?: boolean;
  },
): Promise<{ invite_link: string }> {
  const body = new URLSearchParams();
  body.set("stream_ids", JSON.stringify(params.streamIds));
  if (params.inviteAs !== undefined) {
    body.set("invite_as", String(params.inviteAs));
  }
  if (params.inviteExpiresInMinutes !== undefined) {
    body.set(
      "invite_expires_in_minutes",
      params.inviteExpiresInMinutes === null ? "null" : String(params.inviteExpiresInMinutes),
    );
  }
  if (params.includeRealmDefaultSubscriptions !== undefined) {
    body.set(
      "include_realm_default_subscriptions",
      String(params.includeRealmDefaultSubscriptions),
    );
  }
  const data = await client.request<{
    invite_link: string;
    result: string;
  }>("/invites/multiuse", {
    method: "POST",
    body: body.toString(),
  });
  return { invite_link: data.invite_link };
}

/**
 * Revoke (delete) an email invitation by its invite ID.
 */
export async function revokeZulipInvite(
  client: ZulipClient,
  inviteId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/invites/${inviteId}`,
    { method: "DELETE" },
  );
}

/**
 * Revoke (delete) a reusable invitation link by its invite ID.
 */
export async function revokeZulipInviteLink(
  client: ZulipClient,
  inviteId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/invites/multiuse/${inviteId}`,
    { method: "DELETE" },
  );
}

/**
 * Resend an email invitation by its invite ID.
 */
export async function resendZulipInvite(
  client: ZulipClient,
  inviteId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/invites/${inviteId}/resend`,
    { method: "POST" },
  );
}

// ── Render Message ──

export type ZulipRenderResult = {
  rendered: string;
};

/**
 * Render a Zulip-flavored markdown message into HTML without sending it.
 * Useful for previewing how content will appear, testing linkifiers,
 * validating emoji/mentions, or generating rendered HTML.
 *
 * Uses POST /messages/render.
 */
export async function renderZulipMessage(
  client: ZulipClient,
  content: string,
): Promise<ZulipRenderResult> {
  const body = new URLSearchParams();
  body.set("content", content);
  const data = await client.request<{
    rendered: string;
    result: string;
  }>("/messages/render", {
    method: "POST",
    body: body.toString(),
  });
  return { rendered: data.rendered };
}

// ── Own Profile Data ──

/**
 * Update the current user's (bot's) custom profile field values.
 * Each entry maps a field ID to the value to set.
 * Pass an empty string as the value to clear a field.
 *
 * Uses PATCH /users/me/profile_data.
 */
export async function updateZulipOwnProfileData(
  client: ZulipClient,
  data: Array<{ id: number; value: string }>,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("profile_data", JSON.stringify(data));
  await client.request<{ result: string }>("/users/me/profile_data", {
    method: "PATCH",
    body: body.toString(),
  });
}

// ── Default Streams ──

/**
 * List the streams that new users are auto-subscribed to when they join the organization.
 * These are the "default streams" configured by organization administrators.
 *
 * Uses GET /default_streams.
 */

// ── Stream ID lookup ──

/**
 * Look up a stream ID by name using the dedicated endpoint.
 * Works for any stream the bot has permission to access, including
 * private streams the bot is subscribed to.
 *
 * Uses GET /get_stream_id.
 */
export async function getZulipStreamId(
  client: ZulipClient,
  streamName: string,
): Promise<number> {
  const qs = new URLSearchParams();
  qs.set("stream", streamName);
  const data = await client.request<{
    stream_id: number;
    result: string;
  }>(`/get_stream_id?${qs.toString()}`);
  return data.stream_id;
}

export async function listZulipDefaultStreams(
  client: ZulipClient,
): Promise<ZulipStream[]> {
  const data = await client.request<{
    default_streams: ZulipStream[];
    result: string;
  }>("/default_streams");
  return data.default_streams ?? [];
}

/**
 * Add a stream to the set of default streams that new users are auto-subscribed to.
 * Requires organization administrator permissions.
 *
 * Uses POST /default_streams.
 */
export async function addZulipDefaultStream(
  client: ZulipClient,
  streamId: number,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("stream_id", String(streamId));
  await client.request<{ result: string }>("/default_streams", {
    method: "POST",
    body: body.toString(),
  });
}

/**
 * Remove a stream from the set of default streams.
 * New users will no longer be auto-subscribed to this stream.
 * Requires organization administrator permissions.
 *
 * Uses DELETE /default_streams.
 */
export async function removeZulipDefaultStream(
  client: ZulipClient,
  streamId: number,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("stream_id", String(streamId));
  await client.request<{ result: string }>("/default_streams", {
    method: "DELETE",
    body: body.toString(),
  });
}

// ── Code Playgrounds ──

export type ZulipCodePlayground = {
  id: number;
  name: string;
  pygments_language: string;
  url_template: string;
};

/**
 * List all configured code playgrounds for the organization.
 * Code playgrounds add an "Open in playground" button to code blocks
 * in messages, linking to an online code editor for the language.
 *
 * Uses GET /realm/playgrounds.
 */
export async function listZulipCodePlaygrounds(
  client: ZulipClient,
): Promise<ZulipCodePlayground[]> {
  const data = await client.request<{
    playgrounds: ZulipCodePlayground[];
    result: string;
  }>("/realm/playgrounds");
  return data.playgrounds ?? [];
}

/**
 * Add a new code playground for the organization.
 * Requires organization administrator permissions.
 *
 * Uses POST /realm/playgrounds.
 */
export async function addZulipCodePlayground(
  client: ZulipClient,
  params: {
    name: string;
    pygmentsLanguage: string;
    urlTemplate: string;
  },
): Promise<{ id: number }> {
  const body = new URLSearchParams();
  body.set("name", params.name);
  body.set("pygments_language", params.pygmentsLanguage);
  body.set("url_template", params.urlTemplate);
  const data = await client.request<{ id: number; result: string }>(
    "/realm/playgrounds",
    { method: "POST", body: body.toString() },
  );
  return { id: data.id };
}

/**
 * Remove a code playground from the organization.
 * Requires organization administrator permissions.
 *
 * Uses DELETE /realm/playgrounds/{playground_id}.
 */
export async function removeZulipCodePlayground(
  client: ZulipClient,
  playgroundId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/realm/playgrounds/${playgroundId}`,
    { method: "DELETE" },
  );
}


// ── User Admin ──

/**
 * Human-readable labels for Zulip user roles.
 */
export const USER_ROLE_LABELS: Record<number, string> = {
  100: "Organization owner",
  200: "Organization administrator",
  300: "Organization moderator",
  400: "Member",
  600: "Guest",
};

/**
 * Create a new user in the organization.
 * Requires admin permissions and the can_create_users permission.
 *
 * Uses POST /users.
 */
export async function createZulipUser(
  client: ZulipClient,
  params: {
    email: string;
    password: string;
    fullName: string;
  },
): Promise<{ user_id: number }> {
  const body = new URLSearchParams();
  body.set("email", params.email);
  body.set("password", params.password);
  body.set("full_name", params.fullName);
  const data = await client.request<{
    user_id: number;
    result: string;
  }>("/users", {
    method: "POST",
    body: body.toString(),
  });
  return { user_id: data.user_id };
}

/**
 * Deactivate a user account. The user is immediately logged out of all sessions,
 * their bots are deactivated, and their invitations are disabled.
 * This preserves message history (preferred over deletion).
 * Requires organization administrator permissions.
 * Admins cannot deactivate organization owners.
 *
 * Uses DELETE /users/{user_id}.
 */
export async function deactivateZulipUser(
  client: ZulipClient,
  userId: number,
  params?: {
    deactivationNotificationComment?: string;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params?.deactivationNotificationComment) {
    body.set("deactivation_notification_comment", params.deactivationNotificationComment);
  }
  await client.request<{ result: string }>(
    `/users/${userId}`,
    {
      method: "DELETE",
      ...(body.toString() ? { body: body.toString() } : {}),
    },
  );
}

/**
 * Reactivate a previously deactivated user account.
 * Requires organization administrator permissions.
 *
 * Uses POST /users/{user_id}/reactivate.
 */
export async function reactivateZulipUser(
  client: ZulipClient,
  userId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/users/${userId}/reactivate`,
    { method: "POST" },
  );
}

/**
 * Update a user's full name and/or role.
 * Requires organization administrator permissions.
 * Role values: 100=owner, 200=admin, 300=moderator, 400=member, 600=guest.
 *
 * Uses PATCH /users/{user_id}.
 */
export async function updateZulipUser(
  client: ZulipClient,
  userId: number,
  params: {
    fullName?: string;
    role?: number;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.fullName !== undefined) body.set("full_name", params.fullName);
  if (params.role !== undefined) body.set("role", String(params.role));
  await client.request<{ result: string }>(
    `/users/${userId}`,
    { method: "PATCH", body: body.toString() },
  );
}

// ── Custom Profile Field Management ──

/**
 * Create a new custom profile field for the organization.
 * Requires organization administrator permissions.
 *
 * Uses POST /realm/profile_fields.
 *
 * @param fieldType - Field type: 1=Short text, 2=Long text, 3=List of options,
 *   4=Date picker, 5=Link, 6=Person picker, 7=External account, 8=Pronouns
 */
export async function createZulipCustomProfileField(
  client: ZulipClient,
  params: {
    name: string;
    hint?: string;
    fieldType: number;
    fieldData?: string;
    displayInProfileSummary?: boolean;
    required?: boolean;
  },
): Promise<{ id: number }> {
  const body = new URLSearchParams();
  body.set("name", params.name);
  body.set("field_type", String(params.fieldType));
  if (params.hint !== undefined) body.set("hint", params.hint);
  if (params.fieldData !== undefined) body.set("field_data", params.fieldData);
  if (params.displayInProfileSummary !== undefined) {
    body.set("display_in_profile_summary", String(params.displayInProfileSummary));
  }
  if (params.required !== undefined) {
    body.set("required", String(params.required));
  }
  const data = await client.request<{ id: number; result: string }>(
    "/realm/profile_fields",
    { method: "POST", body: body.toString() },
  );
  return { id: data.id };
}

/**
 * Update an existing custom profile field definition.
 * Requires organization administrator permissions.
 *
 * Uses PATCH /realm/profile_fields/{field_id}.
 */
export async function updateZulipCustomProfileField(
  client: ZulipClient,
  fieldId: number,
  params: {
    name?: string;
    hint?: string;
    fieldData?: string;
    displayInProfileSummary?: boolean;
    required?: boolean;
  },
): Promise<void> {
  const body = new URLSearchParams();
  if (params.name !== undefined) body.set("name", params.name);
  if (params.hint !== undefined) body.set("hint", params.hint);
  if (params.fieldData !== undefined) body.set("field_data", params.fieldData);
  if (params.displayInProfileSummary !== undefined) {
    body.set("display_in_profile_summary", String(params.displayInProfileSummary));
  }
  if (params.required !== undefined) {
    body.set("required", String(params.required));
  }
  await client.request<{ result: string }>(
    `/realm/profile_fields/${fieldId}`,
    { method: "PATCH", body: body.toString() },
  );
}

/**
 * Delete a custom profile field from the organization.
 * All user data associated with this field will be lost.
 * Requires organization administrator permissions.
 *
 * Uses DELETE /realm/profile_fields/{field_id}.
 */
export async function deleteZulipCustomProfileField(
  client: ZulipClient,
  fieldId: number,
): Promise<void> {
  await client.request<{ result: string }>(
    `/realm/profile_fields/${fieldId}`,
    { method: "DELETE" },
  );
}

/**
 * Reorder the custom profile fields in the organization.
 * Requires organization administrator permissions.
 *
 * Uses PATCH /realm/profile_fields with an `order` parameter.
 *
 * @param orderedIds - Array of all custom profile field IDs in the desired display order.
 *   Must include every existing field ID exactly once.
 */
export async function reorderZulipCustomProfileFields(
  client: ZulipClient,
  orderedIds: number[],
): Promise<void> {
  const body = new URLSearchParams();
  body.set("order", JSON.stringify(orderedIds));
  await client.request<{ result: string }>(
    "/realm/profile_fields",
    { method: "PATCH", body: body.toString() },
  );
}
