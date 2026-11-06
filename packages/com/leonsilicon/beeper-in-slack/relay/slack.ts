import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import webApi, { WebClient } from "@-/com.npmjs.slack__web-api";
import type { SlackApi, SlackIdentity, SlackPost } from "#types";

// This is a CommonJS package whose retry policies Node can't detect as a named export.
const { retryPolicies } = webApi;

const errorCode = (error: unknown): string | undefined =>
  (error as { data?: { error?: string } }).data?.error;

export class SlackGateway implements SlackApi {
  #web: WebClient;
  #token: string;
  #privateChannels: Map<string, { id: string; marker: string }> | null = null;

  constructor(token: string) {
    this.#token = token;
    this.#web = new WebClient(token, { retryConfig: retryPolicies.fiveRetriesInFiveMinutes });
  }

  get web(): WebClient {
    return this.#web;
  }

  async identity(): Promise<SlackIdentity> {
    const result = await this.#web.auth.test();
    if (!result.user_id || !result.bot_id)
      throw new Error("Slack did not identify the relay's bot, so it cannot skip its own posts");
    return { userId: result.user_id, botId: result.bot_id };
  }

  async createPrivateChannel(name: string, topic: string, marker?: string): Promise<string> {
    const created = await this.#web.conversations.create({ name, is_private: true });
    const id = created.channel!.id!;
    if (marker) await this.#web.conversations.setPurpose({ channel: id, purpose: marker });
    this.#privateChannels?.set(name, { id, marker: marker ?? "" });
    await this.#web.conversations.setTopic({ channel: id, topic: topic.slice(0, 250) });
    return id;
  }

  async findPrivateChannel(name: string): Promise<{ id: string; marker: string } | null> {
    if (!this.#privateChannels) {
      const channels = new Map<string, { id: string; marker: string }>();
      let cursor: string | undefined;
      do {
        const result = await this.#web.conversations.list({
          types: "private_channel",
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        for (const channel of result.channels ?? []) {
          if (channel.name && channel.id)
            channels.set(channel.name, { id: channel.id, marker: channel.purpose?.value ?? "" });
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
      this.#privateChannels = channels;
    }
    return this.#privateChannels.get(name) ?? null;
  }

  async invite(channel: string, user: string): Promise<void> {
    try {
      await this.#web.conversations.invite({ channel, users: user });
    } catch (error) {
      if (errorCode(error) !== "already_in_channel") throw error;
    }
  }

  async unarchive(channel: string): Promise<void> {
    try {
      await this.#web.conversations.unarchive({ channel });
    } catch (error) {
      if (errorCode(error) !== "not_archived") throw error;
    }
  }

  async post(post: SlackPost): Promise<string> {
    const result = await this.#web.chat.postMessage({
      channel: post.channel,
      text: post.text,
      username: post.username,
      icon_emoji: post.iconEmoji,
      ...(post.threadTs
        ? { thread_ts: post.threadTs, reply_broadcast: Boolean(post.broadcast) }
        : {}),
      // Previews would make Slack fetch links people sent you.
      unfurl_links: false,
      unfurl_media: false,
    } as Parameters<WebClient["chat"]["postMessage"]>[0]);
    return result.ts!;
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.#web.chat.update({ channel, ts, text });
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.#web.reactions.add({ channel, timestamp: ts, name });
    } catch (error) {
      if (errorCode(error) !== "already_reacted") throw error;
    }
  }

  async ephemeral(channel: string, user: string, text: string): Promise<void> {
    await this.#web.chat.postEphemeral({ channel, user, text });
  }

  async uploadFile(
    channel: string,
    path: string,
    fileName: string,
    threadTs?: string,
  ): Promise<void> {
    if (threadTs) {
      await this.#web.filesUploadV2({
        channel_id: channel,
        file: path,
        filename: fileName,
        thread_ts: threadTs,
      });
    } else {
      await this.#web.filesUploadV2({ channel_id: channel, file: path, filename: fileName });
    }
  }

  async downloadFile(
    url: string,
    fileName: string,
  ): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Slack file download returned ${response.status}`);
    const directory = await mkdtemp(join(tmpdir(), "beeper-relay-"));
    const path = join(directory, basename(fileName));
    await pipeline(
      Readable.fromWeb(response.body as NodeWebStream),
      createWriteStream(path, { mode: 0o600 }),
    );
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }
}
