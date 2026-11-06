import { EventEmitter } from "node:events";
import { openAsBlob } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type {
  BeeperApi,
  BeeperChat,
  BeeperEvent,
  BeeperMessage,
  Logger,
  SearchResult,
} from "#types";

const SEARCH_MAX_PAGES = 50;
const CHAT_MAX_PAGES = 100;

export class BeeperClient implements BeeperApi {
  #baseUrl: string;
  #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#token = token;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: { Authorization: `Bearer ${this.#token}`, ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Beeper ${init.method ?? "GET"} ${path.split("?")[0]} returned ${response.status}`,
      );
    const type = response.headers.get("content-type") ?? "";
    return (type.includes("json") ? await response.json() : undefined) as T;
  }

  #json<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  chat(chatId: string): Promise<BeeperChat> {
    return this.request(`/v1/chats/${encodeURIComponent(chatId)}`);
  }

  message(chatId: string, messageId: string): Promise<BeeperMessage> {
    return this.request(
      `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  /** Every chat, most recently active first. */
  async listChats(): Promise<BeeperChat[]> {
    const chats: BeeperChat[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < CHAT_MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) {
        query.set("cursor", cursor);
        query.set("direction", "before");
      }
      const result: { items: BeeperChat[]; hasMore?: boolean; oldestCursor?: string | null } =
        await this.request(`/v1/chats?${query}`);
      chats.push(...result.items);
      if (!result.hasMore || !result.oldestCursor) break;
      cursor = result.oldestCursor;
    }
    return chats;
  }

  async searchSince(iso: string): Promise<SearchResult> {
    const messages: BeeperMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        dateAfter: iso,
        excludeLowPriority: "false",
        includeMuted: "true",
        limit: "20",
      });
      if (cursor) {
        query.set("cursor", cursor);
        query.set("direction", "before");
      }
      const result = await this.request<{
        items: BeeperMessage[];
        hasMore?: boolean;
        oldestCursor?: string | null;
      }>(`/v1/messages/search?${query}`);
      messages.push(...result.items);
      if (!result.hasMore || !result.oldestCursor) {
        return { messages: sortOldestFirst(messages), truncated: false };
      }
      cursor = result.oldestCursor;
    }
    return { messages: sortOldestFirst(messages), truncated: true };
  }

  send(
    chatId: string,
    body: { text?: string; replyToMessageID?: string; attachment?: { uploadID: string } },
  ) {
    return this.#json<{ chatID: string; pendingMessageID: string }>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages`,
      body,
    );
  }

  async markRead(chatId: string): Promise<void> {
    await this.#json(`/v1/chats/${encodeURIComponent(chatId)}/read`, {});
  }

  async downloadAsset(url: string): Promise<string> {
    const result = await this.#json<{ srcURL?: string; error?: string }>("/v1/assets/download", {
      url,
    });
    if (!result.srcURL)
      throw new Error(`Beeper asset download failed: ${result.error ?? "no file returned"}`);
    return result.srcURL.startsWith("file:") ? fileURLToPath(result.srcURL) : result.srcURL;
  }

  async uploadAsset(path: string, fileName: string, mimeType?: string): Promise<string> {
    const form = new FormData();
    form.set("file", await openAsBlob(path), fileName);
    form.set("fileName", fileName);
    if (mimeType) form.set("mimeType", mimeType);
    const result = await this.request<{ uploadID: string }>("/v1/assets/upload", {
      method: "POST",
      body: form,
    });
    return result.uploadID;
  }
}

const sortOldestFirst = (messages: BeeperMessage[]): BeeperMessage[] =>
  messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

/** Beeper's stream is at-most-once with no replay, so `connected` is the cue to catch up over HTTP. */
export class BeeperStream extends EventEmitter<{
  connected: [];
  disconnected: [];
  event: [BeeperEvent];
  appState: [string];
}> {
  #url: string;
  #token: string;
  #log: Logger;
  #socket: WebSocket | null = null;
  #stopped = false;
  #attempt = 0;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(baseUrl: string, token: string, log: Logger) {
    super();
    const url = new URL("/v1/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#url = url.href;
    this.#token = token;
    this.#log = log;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#socket?.close(1000);
  }

  #connect(): void {
    const socket = new WebSocket(this.#url, {
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    this.#socket = socket;
    let alive = true;

    socket.on("open", () => {
      this.#heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 30_000);
    });
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("message", (data) => {
      alive = true;
      this.#onMessage(socket, data.toString());
    });
    socket.on("error", (error) =>
      this.#log("warn", "beeper stream error", { error: error.message }),
    );
    socket.on("close", (code) => {
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      if (this.#stopped) return;
      this.emit("disconnected");
      const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++);
      this.#log("warn", "beeper stream closed", { code, retryInMs: delay });
      setTimeout(() => this.#connect(), delay);
    });
  }

  #onMessage(socket: WebSocket, raw: string): void {
    let parsed: {
      type?: string;
      message?: string;
      appState?: { state?: string };
    } & Partial<BeeperEvent>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#log("warn", "beeper stream sent invalid JSON");
      return;
    }
    switch (parsed.type) {
      case "ready":
        socket.send(
          JSON.stringify({
            type: "subscriptions.set",
            requestID: "relay",
            chatIDs: ["*"],
            app: { state: true },
          }),
        );
        break;
      case "subscriptions.updated":
        this.#attempt = 0;
        this.emit("connected");
        break;
      case "app.state.updated":
        if (parsed.appState?.state) this.emit("appState", parsed.appState.state);
        break;
      case "error":
        this.#log("error", "beeper stream reported an error", {
          code: (parsed as { code?: string }).code,
        });
        break;
      default:
        if (parsed.type?.startsWith("message.") || parsed.type?.startsWith("chat.")) {
          this.emit("event", parsed as BeeperEvent);
        }
    }
  }
}
