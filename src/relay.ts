import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  bridgeOf,
  escapeSlack,
  hasContent,
  slackHoldBackReason,
  messageBody,
  shortHash,
  slackToOutgoingText,
  threadLabel,
  withDelayNote,
  type SlackMessageContent,
} from "#format";
import type { AgentFeed } from "#agent-feed";
import type { MessageRow, OutboundRow, Store } from "#store";
import type {
  BeeperApi,
  BeeperAttachment,
  BeeperChat,
  BeeperEvent,
  BeeperMessage,
  Logger,
  SidebarApi,
  SlackApi,
  SlackIdentity,
} from "#types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BACKFILL_AGE = 24 * HOUR;
const RECONCILE_OVERLAP = 10 * MINUTE;
const DELAY_NOTE_AFTER = 10 * MINUTE;
const CHAT_CACHE_TTL = 10 * MINUTE;
const STATE_RETENTION = 7 * 24 * HOUR;
const SIDEBAR_RETRY = 10 * MINUTE;
// Slack's answers when the owner's session has been signed out or revoked, so retrying can't help.
const SIGNED_OUT = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);
const sidebarKey = (channel: string): string => `sidebar_placed:${channel}`;

interface ResolvedChat {
  key: string;
  label?: string;
  title: string;
  network: string;
  quiet: boolean;
  excluded: boolean;
  loaded: number;
}

interface SlackFile {
  url_private_download?: string;
  url_private?: string;
  name?: string;
  mimetype?: string;
}

export interface SlackMessageEvent extends SlackMessageContent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  ts: string;
  thread_ts?: string;
  client_msg_id?: string;
  files?: SlackFile[];
  message?: SlackMessageContent & { user?: string };
  previous_message?: SlackMessageContent & { user?: string; ts?: string };
}

export interface RelayOptions {
  beeper: BeeperApi;
  slack: SlackApi;
  store: Store;
  feed: AgentFeed;
  log: Logger;
  /** Files chat channels into a section of the owner's sidebar. Optional, since it needs their session. */
  sidebar?: SidebarApi | null;
  ownerUserId: string;
  agentUserId: string | null;
  sendEnabled: boolean;
  mirrorMuted: boolean;
  excludedChatIds: Set<string>;
  excludedNetworks: Set<string>;
  now?: () => number;
}

const slackErrorCode = (error: unknown): string | undefined =>
  (error as { data?: { error?: string } }).data?.error;

/**
 * Mirrors every chat to its own private channel and a shared feed, automatically inviting the owner.
 * Everything runs through one queue, which keeps messages in order and guarantees a sent message is
 * recorded before its echo from Beeper is handled.
 */
export class Relay {
  #options: RelayOptions;
  #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #chats = new Map<string, ResolvedChat>();
  #self: SlackIdentity | null = null;
  #sidebarRetryAt = 0;
  #sidebarSignedOut = false;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    const { store, slack, feed, ownerUserId, agentUserId, sendEnabled } = this.#options;
    this.#self = await slack.identity();
    const firstRun = store.getMeta("first_run_at") === null;
    if (firstRun) {
      const now = String(this.#now());
      store.setMeta("first_run_at", now);
      store.setMeta("watermark", now);
    }
    let channel = store.getMeta("feed_channel");
    if (!channel) {
      channel = await this.#createChannel(
        "beeper-feed",
        "Beeper relay status and the feed an AI agent can read",
      );
      store.setMeta("feed_channel", channel);
    }
    if (store.getMeta("feed_owner_invited") === null) {
      await slack.invite(channel, ownerUserId);
      store.setMeta("feed_owner_invited", "1");
    }
    if (agentUserId && store.getMeta("feed_agent_invited") !== agentUserId) {
      await slack.invite(channel, agentUserId);
      store.setMeta("feed_agent_invited", agentUserId);
    }
    let statusThread = store.getMeta("feed_status_thread");
    if (!statusThread) {
      statusThread = await slack.post({
        channel,
        text: "Every Beeper chat gets a private Slack channel when a new message arrives, and you are invited automatically. Messages also appear here. Write in the chat channel or reply to a feed message to send through Beeper. Top-level feed posts stay in Slack.",
      });
      store.setMeta("feed_status_thread", statusThread);
    }
    feed.setChannel(channel, statusThread);
    // Also repairs existing bot-only channels and stale invitation flags from earlier versions.
    const joined = [channel];
    for (const chat of store.chats()) {
      if (!chat.personal_channel) continue;
      try {
        await this.#inviteOwner(chat.key, chat.personal_channel, { place: false });
        joined.push(chat.personal_channel);
      } catch (error) {
        this.#options.log("warn", "could not invite owner to an existing chat channel", {
          error: (error as Error).message,
        });
      }
    }
    // One request for everything not yet filed, including channels whose earlier attempt failed.
    await this.#placeInSidebar(joined);
    if (firstRun) {
      await slack.post({
        channel,
        threadTs: statusThread,
        text: `Beeper relay is running. Replying from Slack is ${sendEnabled ? "on" : "off for now, so nothing you type will reach a contact"}.`,
      });
    }
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task).catch((error) => {
      this.#options.log("error", "relay task failed", { error: (error as Error).message });
    });
    this.#queue = run;
    return run;
  }

  onBeeperEvent(event: BeeperEvent): Promise<void> {
    return this.#enqueue(() => this.#handleBeeperEvent(event));
  }

  onSlackEvent(event: SlackMessageEvent): Promise<void> {
    return this.#enqueue(() => this.#handleSlackEvent(event));
  }

  /** Picks up anything the at-most-once stream dropped, plus anything that failed earlier. */
  reconcile(): Promise<void> {
    return this.#enqueue(async () => {
      const { store, beeper, feed, log } = this.#options;
      const started = this.#now();
      const watermark = Number(store.getMeta("watermark") ?? started);
      const { messages, truncated } = await beeper.searchSince(
        new Date(watermark - RECONCILE_OVERLAP).toISOString(),
      );
      if (truncated)
        await feed.alert(
          "Too many messages arrived while the relay was catching up, so the oldest may be missing from Slack.",
        );
      let clean = true;
      for (const message of messages) {
        try {
          await this.#processMessage(message);
        } catch (error) {
          clean = false;
          log("error", "could not mirror message", {
            messageId: message.id,
            error: (error as Error).message,
          });
        }
      }
      if (clean) store.setMeta("watermark", String(started));
      store.prune(started - STATE_RETENTION);
    });
  }

  async #handleBeeperEvent(event: BeeperEvent): Promise<void> {
    const { beeper, log } = this.#options;
    switch (event.type) {
      case "chat.upserted":
      case "chat.deleted":
        this.#chats.delete(event.chatID);
        return;
      case "message.deleted":
        for (const id of event.ids) await this.#mirrorDeletion(id);
        return;
      case "message.upserted":
        for (const id of event.ids) {
          const entry = event.entries?.find((candidate) => candidate.id === id);
          try {
            // Stream entries can omit sender direction. Fetch it before echo matching or waking the agent.
            const message =
              entry?.timestamp && typeof entry.isSender === "boolean"
                ? ({ chatID: event.chatID, ...entry } as BeeperMessage)
                : await beeper.message(event.chatID, id);
            await this.#processMessage(message);
          } catch (error) {
            // Left unrecorded on purpose: the next reconcile retries it.
            log("warn", "could not mirror message yet", {
              messageId: id,
              error: (error as Error).message,
            });
          }
        }
        return;
    }
  }

  async #mirrorDeletion(id: string): Promise<void> {
    const { store, slack } = this.#options;
    const known = store.message(id);
    if (!known?.slack_ts || known.deleted || known.from_slack) return;
    const chat = store.chat(known.chat_key);
    const channel = known.channel ?? chat?.channel;
    const resolved = {
      key: known.chat_key,
      title: chat?.title ?? "Chat",
      network: chat?.network ?? "",
    };
    if (channel)
      await slack.update(
        channel,
        known.slack_ts,
        this.#destinationText(channel, resolved, "_(message deleted)_"),
      );
    for (const copy of store.mirrors(`beeper:${id}`)) {
      await slack.update(
        copy.channel,
        copy.slack_ts,
        this.#destinationText(copy.channel, resolved, "_(message deleted)_"),
      );
    }
    store.setDeleted(id);
  }

  async #processMessage(message: BeeperMessage): Promise<void> {
    const { store } = this.#options;
    const known = store.message(message.id);
    if (known) {
      await this.#updateKnown(message, known);
      return;
    }
    if (
      message.type === "REACTION" ||
      message.isHidden ||
      message.isDeleted ||
      !hasContent(message)
    )
      return;

    const sentAt = Date.parse(message.timestamp);
    const now = this.#now();
    if (sentAt < Number(store.getMeta("first_run_at"))) return;
    if (now - sentAt > BACKFILL_AGE && message.isUnread !== true) return;

    const chat = await this.#resolveChat(message.chatID);
    if (chat.excluded) return;

    if (message.isSender) {
      const outbound = await this.#findOutbound(chat.key, message.id);
      if (outbound) {
        if (message.sendStatus?.status === "PENDING") return;
        store.saveMessage({
          id: message.id,
          chatKey: chat.key,
          slackTs: outbound.slack_ts,
          channel: outbound.channel,
          fromSlack: true,
          outboundId: outbound.id,
        });
        await this.#reportSendStatus(outbound, message);
        await this.#mirrorEcho(chat, message, outbound);
        return;
      }
    }

    const channel = chat.quiet ? null : await this.#personalFor(chat);
    const target = channel ? { channel } : null;
    const posted = target ? await this.#mirror(target, chat, message, sentAt, now) : undefined;
    store.saveMessage({
      id: message.id,
      chatKey: chat.key,
      slackTs: posted?.ts ?? null,
      threadTs: posted?.threadTs ?? null,
      channel: target?.channel ?? null,
      editedAt: message.editedTimestamp,
    });
    if (target && posted)
      await this.#ensureCopies(chat, message, target.channel, `beeper:${message.id}`);

    this.#options.feed.add({
      chatTitle: chat.title,
      network: chat.network,
      sender: message.isSender ? "You" : (message.senderName ?? chat.title),
      text: messageBody(message),
      channel: target?.channel ?? null,
      fromOwner: Boolean(message.isSender),
      timestamp: message.timestamp,
    });
  }

  async #updateKnown(message: BeeperMessage, known: MessageRow): Promise<void> {
    const { store, slack } = this.#options;
    if (known.from_slack) {
      const outbound = known.outbound_id
        ? store.outboundById(known.outbound_id)
        : known.slack_ts
          ? store.outboundBySlackTs(known.slack_ts)
          : null;
      if (outbound) {
        // Earlier versions also matched text, which could hide a separate message sent in Beeper.
        const resolved = await this.#resolveOutbound(outbound);
        if (message.id !== resolved.pending_id && message.id !== resolved.message_id) {
          store.forgetMessage(message.id);
          await this.#processMessage(message);
          return;
        }
        await this.#reportSendStatus(outbound, message);
        await this.#mirrorEcho(await this.#resolveChat(message.chatID), message, outbound);
      }
      return;
    }
    if (!known.slack_ts) return;
    if (message.isDeleted) {
      await this.#mirrorDeletion(message.id);
      return;
    }
    if (message.editedTimestamp && message.editedTimestamp !== known.edited_at) {
      const chat = store.chat(known.chat_key);
      const channel = known.channel ?? chat?.channel;
      const resolved = await this.#resolveChat(message.chatID);
      if (channel)
        await slack.update(
          channel,
          known.slack_ts,
          this.#destinationText(channel, resolved, `${messageBody(message)} _(edited)_`),
        );
      for (const copy of store.mirrors(`beeper:${message.id}`)) {
        await slack.update(
          copy.channel,
          copy.slack_ts,
          this.#destinationText(copy.channel, resolved, `${messageBody(message)} _(edited)_`),
        );
      }
      store.setEdited(message.id, message.editedTimestamp);
    }
    const chat = await this.#resolveChat(message.chatID);
    if (!chat.excluded && !chat.quiet) {
      await this.#ensureCopies(
        chat,
        message,
        known.channel ?? store.chat(chat.key)?.channel ?? "",
        `beeper:${message.id}`,
      );
    }
  }

  async #resolveOutbound(outbound: OutboundRow): Promise<OutboundRow> {
    if (outbound.message_id) return outbound;
    // Beeper resolves a pending send ID to the final message. Text is never evidence of an echo.
    const resolved = await this.#options.beeper.message(
      outbound.send_chat_key ?? outbound.chat_key,
      outbound.pending_id,
    );
    if (resolved.id === outbound.pending_id) return outbound;
    this.#options.store.setOutboundMessageId(outbound.id, resolved.id);
    return { ...outbound, message_id: resolved.id };
  }

  async #findOutbound(chatKey: string, messageId: string): Promise<OutboundRow | null> {
    const { store } = this.#options;
    const known = store.findOutbound(chatKey, messageId);
    if (known) return known;
    for (const candidate of store.unresolvedOutbound(chatKey)) {
      try {
        const resolved = await this.#resolveOutbound(candidate);
        if (resolved.message_id === messageId) return resolved;
      } catch (error) {
        // An old, unresolvable send must not hide new messages written in Beeper.
        this.#options.log("warn", "could not resolve a Slack send ID", {
          error: (error as Error).message,
        });
      }
    }
    return null;
  }

  async #mirrorEcho(
    chat: ResolvedChat,
    message: BeeperMessage,
    outbound: OutboundRow,
  ): Promise<void> {
    if (["PENDING", "FAIL_PERMANENT", "FAIL_RETRIABLE"].includes(message.sendStatus?.status ?? ""))
      return;
    await this.#ensureCopies(
      chat,
      message,
      outbound.channel,
      `slack:${outbound.channel}:${outbound.slack_ts}:${outbound.id}`,
    );
  }

  async #ensureCopies(
    chat: ResolvedChat,
    message: BeeperMessage,
    sourceChannel: string,
    sourceKey: string,
  ): Promise<void> {
    const { store } = this.#options;
    const personal = await this.#personalFor(chat);
    const feedChannel = store.getMeta("feed_channel");
    const targets: Array<{ channel: string; threadTs?: string }> = [];
    if (personal) targets.push({ channel: personal });
    if (feedChannel) targets.push({ channel: feedChannel });
    for (const target of targets) {
      if (
        target.channel === sourceChannel ||
        store.mirrors(sourceKey).some((copy) => copy.channel === target.channel)
      )
        continue;
      const posted = await this.#mirror(
        target,
        chat,
        message,
        Date.parse(message.timestamp),
        this.#now(),
        sourceKey.startsWith("slack:"),
      );
      store.saveMirror(sourceKey, target.channel, posted.ts, target.threadTs, chat.key);
    }
  }

  async #reportSendStatus(outbound: OutboundRow, message: BeeperMessage): Promise<void> {
    const { slack, store, ownerUserId } = this.#options;
    const status = message.sendStatus?.status;
    if (status === "PENDING") return;
    if (status === "FAIL_PERMANENT" || status === "FAIL_RETRIABLE") {
      await slack.react(outbound.channel, outbound.slack_ts, "warning");
      await slack.ephemeral(
        outbound.channel,
        ownerUserId,
        "That message failed to send, so your contact did not get it.",
      );
      return;
    }
    if (!outbound.confirmed) {
      await slack.react(outbound.channel, outbound.slack_ts, "white_check_mark");
      store.setOutboundConfirmed(outbound.id);
    }
  }

  async #mirror(
    target: { channel: string; threadTs?: string },
    chat: ResolvedChat,
    message: BeeperMessage,
    sentAt: number,
    now: number,
    fromSlack = false,
  ): Promise<{ ts: string; threadTs: string | null }> {
    const { slack } = this.#options;
    const { channel, threadTs } = target;
    const body = withDelayNote(messageBody(message), sentAt, now, DELAY_NOTE_AFTER);
    const text = this.#destinationText(channel, chat, body);
    const post = {
      channel,
      text,
      username: message.isSender
        ? fromSlack
          ? "You (via Slack)"
          : "You (another device)"
        : (message.senderName ?? chat.title),
      iconEmoji: message.isSender ? ":iphone:" : ":speech_balloon:",
      threadTs,
      broadcast: false,
    };
    let ts: string;
    try {
      ts = await slack.post(post);
    } catch (error) {
      const personal = this.#options.store.chat(chat.key)?.personal_channel;
      if (slackErrorCode(error) !== "is_archived" || channel !== personal) throw error;
      await this.#reopen(channel);
      await this.#inviteOwner(chat.key, channel);
      ts = await slack.post(post);
    }
    for (const attachment of message.attachments ?? []) {
      await this.#copyAttachment(
        channel,
        threadTs ?? (channel === this.#options.store.getMeta("feed_channel") ? ts : undefined),
        attachment,
        message,
      );
    }
    return { ts, threadTs: threadTs ?? null };
  }

  async #copyAttachment(
    channel: string,
    threadTs: string | undefined,
    attachment: BeeperAttachment,
    message: BeeperMessage,
  ): Promise<void> {
    const { beeper, slack, log } = this.#options;
    try {
      const path = attachment.srcURL?.startsWith("file:")
        ? fileURLToPath(attachment.srcURL)
        : await beeper.downloadAsset(attachment.id ?? attachment.srcURL ?? "");
      await slack.uploadFile(
        channel,
        path,
        attachment.fileName ?? `attachment-${shortHash(message.id)}`,
        threadTs,
      );
    } catch (error) {
      log("warn", "could not copy attachment", {
        messageId: message.id,
        error: (error as Error).message,
      });
      await slack.post({
        channel,
        threadTs,
        text: "_(An attachment couldn't be copied here. Open Beeper to see it.)_",
      });
    }
  }

  async #resolveChat(chatId: string): Promise<ResolvedChat> {
    const cached = this.#chats.get(chatId);
    if (cached && this.#now() - cached.loaded < CHAT_CACHE_TTL) return cached;
    const { beeper, excludedChatIds, excludedNetworks, mirrorMuted } = this.#options;
    const member = await beeper.chat(chatId);
    const chat: BeeperChat = member.mergedIntoChatID
      ? await beeper.chat(member.mergedIntoChatID)
      : member;
    const resolved: ResolvedChat = {
      key: chat.id,
      label: threadLabel(member),
      title: chat.title,
      network: chat.network,
      quiet: !mirrorMuted && Boolean(chat.isMuted || chat.isLowPriority),
      // Chats bridged from Slack would loop straight back into Slack, so they are never mirrored.
      excluded:
        /slack/i.test(member.network) ||
        /slack/i.test(member.accountID) ||
        excludedChatIds.has(member.id) ||
        excludedChatIds.has(chat.id) ||
        excludedNetworks.has(member.network.toLowerCase()) ||
        excludedNetworks.has(bridgeOf(member.accountID)),
      loaded: this.#now(),
    };
    this.#chats.set(chatId, resolved);
    return resolved;
  }

  async #createChannel(name: string, topic: string): Promise<string> {
    const { slack } = this.#options;
    try {
      return await slack.createPrivateChannel(name, topic);
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "name_taken")
        return slack.createPrivateChannel(`${name.slice(0, 73)}-${shortHash(topic)}`, topic);
      if (code?.startsWith("invalid_name"))
        return slack.createPrivateChannel(`bp-${shortHash(topic)}`, topic);
      throw error;
    }
  }

  #destinationText(
    channel: string,
    chat: Pick<ResolvedChat, "key" | "label" | "title" | "network">,
    body: string,
  ): string {
    if (channel !== this.#options.store.getMeta("feed_channel")) return body;
    const personal = this.#options.store.chat(chat.key)?.personal_channel;
    const label = personal ? `<#${personal}>` : escapeSlack(chat.label ?? chat.title);
    return `${label} · ${escapeSlack(chat.title)} · ${escapeSlack(chat.network)}\n${body}`;
  }

  /** Updates old feed headers without provisioning any historical chat channels. */
  async relabelThreads(): Promise<void> {
    const { store, slack } = this.#options;
    if (store.getMeta("channel_layout_version") === "4") return;
    const channel = store.getMeta("feed_channel");
    const status = store.getMeta("feed_status_thread");
    if (channel && status)
      await slack.update(
        channel,
        status,
        "Every Beeper chat gets a private Slack channel when a new message arrives, and you are invited automatically. Messages also appear here. Write in a chat channel or reply to a feed message to send through Beeper. Top-level feed posts stay in Slack.",
      );
    for (const row of store.chats()) {
      if (row.channel === channel && row.root_ts) {
        await slack.update(
          channel!,
          row.root_ts,
          `*${escapeSlack(row.title)} · ${escapeSlack(row.network)}*\nNew messages appear in a private channel for this chat and in the aggregate feed. You are automatically invited to its channel. Existing replies here still send to Beeper.`,
        );
      }
    }
    store.setMeta("channel_layout_version", "4");
  }

  async #inviteOwner(chatKey: string, channel: string, { place = true } = {}): Promise<void> {
    const { slack, store, ownerUserId } = this.#options;
    try {
      try {
        await slack.invite(channel, ownerUserId);
      } catch (error) {
        if (slackErrorCode(error) !== "is_archived") throw error;
        await this.#reopen(channel);
        await slack.invite(channel, ownerUserId);
      }
      store.setInvited(chatKey);
    } catch (error) {
      store.setInvited(chatKey, false);
      throw error;
    }
    if (place) await this.#placeInSidebar([channel]);
  }

  /** A reopened channel is filed again, so it returns to the section rather than the default list. */
  async #reopen(channel: string): Promise<void> {
    await this.#options.slack.unarchive(channel);
    this.#options.store.deleteMeta(sidebarKey(channel));
  }

  /**
   * Files each channel once, so one the owner later drags elsewhere stays there. This never throws:
   * sorting the sidebar must not hold up a message, and unfiled channels are retried later.
   */
  async #placeInSidebar(channels: string[]): Promise<void> {
    const { sidebar, store, log, feed } = this.#options;
    if (!sidebar || this.#sidebarSignedOut || this.#now() < this.#sidebarRetryAt) return;
    const pending = [...new Set(channels)].filter((id) => store.getMeta(sidebarKey(id)) === null);
    if (pending.length === 0) return;
    try {
      await sidebar.place(pending);
      for (const id of pending) store.setMeta(sidebarKey(id), "1");
      log("info", "filed channels in the sidebar section", { channels: pending.length });
    } catch (error) {
      const code = slackErrorCode(error);
      log("warn", "could not file channels in the sidebar section", {
        error: code ?? (error as Error).message,
        channels: pending.length,
      });
      this.#sidebarRetryAt = this.#now() + SIDEBAR_RETRY;
      if (code && SIGNED_OUT.has(code)) {
        this.#sidebarSignedOut = true;
        await feed.alert(
          `New Beeper channels are no longer being filed in your sidebar section, because the Slack sign-in the relay uses for that has ended (\`${code}\`). Messages still relay normally. Save a new Slack session in the relay's settings and restart it to fix it.`,
        );
      }
    }
  }

  async #personalFor(chat: ResolvedChat): Promise<string | null> {
    if (chat.excluded || chat.quiet) return null;
    const { store, slack } = this.#options;
    let previous = store.chat(chat.key);
    if (!previous) {
      store.saveChat(chat.key, store.getMeta("feed_channel")!, chat.title, chat.network);
      previous = store.chat(chat.key);
    }
    if (previous?.ignored) return null;
    if (previous?.personal_channel) {
      if (!previous.invited) await this.#inviteOwner(chat.key, previous.personal_channel);
      else await this.#placeInSidebar([previous.personal_channel]);
      return previous.personal_channel;
    }
    const marker = `beeper-relay:${createHash("sha256").update(chat.key).digest("hex")}`;
    const base = (chat.label ?? `bp-chat-${shortHash(chat.key)}`)
      .normalize("NFKD")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+$/g, "")
      .slice(0, 72);
    const names = [base, `${base.slice(0, 65)}-${shortHash(chat.key)}`];
    let channel: string | null = null;
    for (const name of names) {
      const existing = await slack.findPrivateChannel(name);
      if (existing) {
        if (existing.marker === marker) {
          channel = existing.id;
          break;
        }
        continue;
      }
      try {
        channel = await slack.createPrivateChannel(
          name,
          `${chat.title} on ${chat.network}. Also mirrored in beeper-feed.`,
          marker,
        );
        break;
      } catch (error) {
        if (slackErrorCode(error) !== "name_taken") throw error;
      }
    }
    if (!channel) throw new Error("A different chat already owns both deterministic channel names");
    store.setPersonalChannel(chat.key, channel);
    await this.#inviteOwner(chat.key, channel);
    return channel;
  }

  async #handleSlackEvent(event: SlackMessageEvent): Promise<void> {
    const { store, slack, ownerUserId, sendEnabled, beeper, log } = this.#options;
    if (event.type !== "message") return;
    if (event.subtype === "message_changed" || event.subtype === "message_deleted") {
      await this.#warnAboutChange(event);
      return;
    }
    const chat =
      store.chatByPersonalChannel(event.channel) ??
      (event.thread_ts
        ? (store.chatForSlackMessage(event.channel, event.thread_ts) ??
          store.chatByThread(event.channel, event.thread_ts))
        : null);
    if (!chat) return;
    const allowed =
      event.subtype === undefined ||
      event.subtype === "file_share" ||
      event.subtype === "thread_broadcast" ||
      event.subtype === "bot_message";
    if (!allowed || this.#isOwnPost(event)) return;
    if (this.#isSideReply(event)) {
      log("info", "kept a reply in a side thread in Slack", {
        channel: event.channel,
        ts: event.ts,
        user: event.user ?? event.bot_id,
      });
      return;
    }
    if (!store.claimSlackEvent(event.client_msg_id ?? `${event.channel}:${event.ts}`, this.#now()))
      return;

    const text = slackToOutgoingText(event);
    if (text.split("\n")[0].trim() === "//join") {
      const personal = await this.#personalFor(await this.#resolveChat(chat.key));
      if (personal) {
        await slack.invite(personal, ownerUserId);
        store.setInvited(chat.key);
        await slack.ephemeral(
          event.channel,
          ownerUserId,
          `You can now open <#${personal}>. Replies there also send to Beeper.`,
        );
      } else {
        await slack.ephemeral(event.channel, ownerUserId, "This chat is excluded from the relay.");
      }
      return;
    }

    const held = slackHoldBackReason(event);
    if (held) {
      await slack.ephemeral(event.channel, ownerUserId, `Not sent. ${held}`);
      return;
    }
    if (!sendEnabled) {
      await slack.ephemeral(
        event.channel,
        ownerUserId,
        "Not sent. Replying from Slack is turned off right now.",
      );
      return;
    }

    if (!text && !event.files?.length) return;
    try {
      const files = event.files ?? [];
      const sends = files.length > 0 ? files : [null];
      for (const [index, file] of sends.entries()) {
        const attachment = file ? { uploadID: await this.#uploadSlackFile(file) } : undefined;
        const body = {
          ...(index === 0 && text ? { text } : {}),
          ...(attachment ? { attachment } : {}),
        };
        const result = await beeper.send(chat.key, body);
        store.addOutbound({
          chatKey: chat.key,
          pendingId: result.pendingMessageID,
          // Kept only for compatibility with the original database schema.
          echoHash: "",
          sendChatKey: result.chatID,
          channel: event.channel,
          slackTs: event.ts,
          now: this.#now(),
        });
      }
    } catch (error) {
      log("error", "could not send to beeper", { error: (error as Error).message });
      await slack.react(event.channel, event.ts, "warning");
      await slack.ephemeral(
        event.channel,
        ownerUserId,
        "That message failed to send, so your contact did not get it.",
      );
      return;
    }
    await beeper
      .markRead(chat.key)
      .catch((error: Error) => log("warn", "could not mark chat read", { error: error.message }));
  }

  /**
   * A thread that doesn't start from one of the relay's Beeper posts is a side conversation, such as
   * the owner asking an AI agent about the chat. Only posts in the owner's name send from there, so agents
   * replying as themselves stay in Slack while apps posting as the owner (such as Composio) still send.
   */
  #isSideReply(event: SlackMessageEvent): boolean {
    const root = event.thread_ts;
    if (!root || root === event.ts || event.user === this.#options.ownerUserId) return false;
    return !this.#options.store.isRelayPost(event.channel, root);
  }

  /**
   * Anyone may send through a chat's channel or a thread on one of its Beeper messages: the owner,
   * other people, and agents or apps posting as themselves or as the owner. Only the relay's own
   * posts are skipped, since those are copies of Beeper messages and sending them would loop.
   */
  #isOwnPost(event: SlackMessageEvent): boolean {
    const self = this.#self;
    // Without its own identity the relay can't recognize its posts, so only typed owner messages go.
    if (!self) return Boolean(event.bot_id) || event.user !== this.#options.ownerUserId;
    return event.bot_id === self.botId || event.user === self.userId;
  }

  async #uploadSlackFile(file: SlackFile): Promise<string> {
    const { slack, beeper } = this.#options;
    const url = file.url_private_download ?? file.url_private;
    if (!url) throw new Error("Slack file has no download URL");
    const name = file.name ?? "attachment";
    const local = await slack.downloadFile(url, name);
    try {
      return await beeper.uploadAsset(local.path, name, file.mimetype);
    } finally {
      await local.cleanup();
    }
  }

  /** Edits and deletions in Slack don't reach the contact, so say so rather than leaving a false impression. */
  async #warnAboutChange(event: SlackMessageEvent): Promise<void> {
    const { slack, store, ownerUserId } = this.#options;
    const before = event.previous_message;
    if (
      before?.user !== ownerUserId ||
      !before.ts ||
      store.outboundBySlackTs(before.ts)?.channel !== event.channel
    )
      return;
    if (event.subtype === "message_changed" && event.message?.text === before.text) return;
    const what = event.subtype === "message_changed" ? "edit" : "deletion";
    await slack.ephemeral(
      event.channel,
      ownerUserId,
      `That ${what} only changed Slack. Your contact still has the original message.`,
    );
  }
}
