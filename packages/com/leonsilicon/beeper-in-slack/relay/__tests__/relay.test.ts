import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentFeed } from "#agent-feed";
import { Relay, type SlackMessageEvent } from "#relay";
import { Store } from "#store";
import type { BeeperApi, BeeperChat, BeeperMessage, SidebarApi, SlackApi, SlackPost } from "#types";

const OWNER = "UOWNER";
const RELAY_USER = "URELAY";
const RELAY_BOT = "BRELAY";
const T0 = Date.parse("2026-11-05T12:00:00Z");
const quiet = () => {};

interface Harness {
  relay: Relay;
  store: Store;
  posts: SlackPost[];
  sends: Array<{ chatId: string; body: Record<string, unknown> }>;
  channels: string[];
  invites: Array<[string, string]>;
  unarchives: string[];
  reactions: Array<[string, string]>;
  ephemerals: string[];
  updates: Array<[string, string]>;
  uploads: string[];
  uploadThreads: Array<string | undefined>;
  feed: FeedSpy;
  chats: Map<string, BeeperChat>;
  messages: Map<string, BeeperMessage>;
  searchResult: BeeperMessage[];
  setNow(value: number): void;
  failNextPost: Error | null;
  failPostChannel: string | null;
  failNextSend: Error | null;
  failNextUpload: Error | null;
  failNextInvite: Error | null;
  messageLookups: Array<[string, string]>;
  filed: string[][];
  failNextFiling: Error | null;
}
type FeedSpy = Array<{ sender: string; fromOwner: boolean; text: string }>;

function harness(
  options: {
    sendEnabled?: boolean;
    agent?: string | null;
    mirrorMuted?: boolean;
    routedSendChatId?: string;
    sidebar?: boolean;
  } = {},
): Harness {
  let now = T0;
  const h = {
    posts: [] as SlackPost[],
    sends: [] as Harness["sends"],
    channels: [] as string[],
    invites: [] as Array<[string, string]>,
    unarchives: [] as string[],
    reactions: [] as Array<[string, string]>,
    ephemerals: [] as string[],
    updates: [] as Array<[string, string]>,
    uploads: [] as string[],
    uploadThreads: [] as Array<string | undefined>,
    chats: new Map<string, BeeperChat>([
      [
        "chat1",
        {
          id: "chat1",
          accountID: "whatsapp",
          network: "WhatsApp",
          title: "Alice Smith",
          type: "single",
        },
      ],
    ]),
    messages: new Map<string, BeeperMessage>(),
    messageLookups: [] as Array<[string, string]>,
    failPostChannel: null as string | null,
    failNextInvite: null as Error | null,
    searchResult: [] as BeeperMessage[],
    failNextPost: null as Error | null,
    failNextSend: null as Error | null,
    failNextUpload: null as Error | null,
    filed: [] as string[][],
    failNextFiling: null as Error | null,
  };
  let ts = 0;
  const privateChannels = new Map<string, { id: string; marker: string }>();
  const slack: SlackApi = {
    identity: async () => ({ userId: RELAY_USER, botId: RELAY_BOT }),
    createPrivateChannel: async (name, _topic, marker) => {
      if (h.channels.includes(name))
        throw Object.assign(new Error("taken"), { data: { error: "name_taken" } });
      h.channels.push(name);
      const id = `C${h.channels.length}`;
      privateChannels.set(name, { id, marker: marker ?? "" });
      return id;
    },
    findPrivateChannel: async (name) => privateChannels.get(name) ?? null,
    invite: async (channel, user) => {
      if (h.failNextInvite) {
        const error = h.failNextInvite;
        h.failNextInvite = null;
        throw error;
      }
      h.invites.push([channel, user]);
    },
    unarchive: async (channel) => void h.unarchives.push(channel),
    post: async (post) => {
      if (h.failNextPost && (!h.failPostChannel || post.channel === h.failPostChannel)) {
        const error = h.failNextPost;
        h.failNextPost = null;
        throw error;
      }
      h.posts.push(post);
      return `ts${++ts}`;
    },
    update: async (_channel, target, text) => void h.updates.push([target, text]),
    react: async (_channel, target, name) => void h.reactions.push([target, name]),
    ephemeral: async (_channel, _user, text) => void h.ephemerals.push(text),
    uploadFile: async (_channel, path, _name, threadTs) => {
      if (h.failNextUpload) {
        const error = h.failNextUpload;
        h.failNextUpload = null;
        throw error;
      }
      h.uploads.push(path);
      h.uploadThreads.push(threadTs);
    },
    downloadFile: async () => ({ path: "/tmp/x", cleanup: async () => {} }),
  };
  const beeper: BeeperApi = {
    chat: async (id) => {
      const chat = h.chats.get(id);
      if (!chat) throw new Error("no chat");
      return chat;
    },
    message: async (_chatId, id) => {
      h.messageLookups.push([_chatId, id]);
      const message = h.messages.get(id);
      if (!message) throw new Error("not available");
      return message;
    },
    listChats: async () => [...h.chats.values()],
    searchSince: async () => ({ messages: h.searchResult, truncated: false }),
    send: async (chatId, body) => {
      if (h.failNextSend) {
        const error = h.failNextSend;
        h.failNextSend = null;
        throw error;
      }
      h.sends.push({ chatId, body });
      const n = h.sends.length;
      h.messages.set(
        `pending${n}`,
        incoming({
          id: `final${n}`,
          chatID: chatId,
          isSender: true,
          text: body.text,
          type: body.attachment ? "IMAGE" : "TEXT",
        }),
      );
      return { chatID: options.routedSendChatId ?? chatId, pendingMessageID: `pending${n}` };
    },
    markRead: async () => {},
    downloadAsset: async () => "/tmp/asset.jpg",
    uploadAsset: async () => "upload1",
  };
  const feedEntries: FeedSpy = [];
  const agentUserId = options.agent === undefined ? null : options.agent;
  const feed = new AgentFeed({ slack, agentUserId, quietMs: 60_000, maxMs: 60_000, log: quiet });
  feed.add = (entry) => void feedEntries.push(entry);
  const sidebar: SidebarApi = {
    place: async (channels) => {
      if (h.failNextFiling) {
        const error = h.failNextFiling;
        h.failNextFiling = null;
        throw error;
      }
      h.filed.push(channels);
    },
  };
  const store = new Store(":memory:");
  const relay = new Relay({
    beeper,
    slack,
    store,
    feed,
    log: quiet,
    sidebar: options.sidebar ? sidebar : null,
    ownerUserId: OWNER,
    agentUserId,
    sendEnabled: options.sendEnabled ?? true,
    mirrorMuted: options.mirrorMuted ?? false,
    excludedChatIds: new Set(["chat-excluded"]),
    excludedNetworks: new Set(["mybot", "my-agents"]),
    now: () => now,
  });
  return Object.assign(h, {
    relay,
    store,
    feed: feedEntries,
    setNow: (value: number) => {
      now = value;
    },
  }) as Harness;
}

const incoming = (overrides: Partial<BeeperMessage> = {}): BeeperMessage => ({
  id: "m1",
  chatID: "chat1",
  senderName: "Alice",
  isSender: false,
  timestamp: new Date(T0 + 1000).toISOString(),
  type: "TEXT",
  text: "hello",
  ...overrides,
});
const upsert = (message: BeeperMessage) => ({
  type: "message.upserted",
  chatID: message.chatID,
  ids: [message.id],
  entries: [message],
});
const allContactPosts = (h: Harness) => h.posts.filter((post) => post.username);
const contactPosts = (h: Harness) =>
  allContactPosts(h).filter((post) => post.channel !== h.store.getMeta("feed_channel"));
const feedTs = (h: Harness, id = "seed") =>
  h.store.mirrors(`beeper:${id}`).find((copy) => copy.channel === h.store.getMeta("feed_channel"))!
    .slack_ts;

async function ready(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = harness(options);
  await h.relay.init();
  return h;
}

async function mirroredChannel(h: Harness): Promise<string> {
  await h.relay.onBeeperEvent(upsert(incoming({ id: "seed" })));
  return h.store.chat("chat1")!.channel!;
}

const slackEvent = (h: Harness, overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: "message",
  channel: h.store.chat("chat1")!.channel!,
  thread_ts: feedTs(h),
  user: OWNER,
  ts: "500.1",
  client_msg_id: "client1",
  text: "hi there",
  ...overrides,
});

test("first run creates the feed channel, invites the owner, and says sending is off", async () => {
  const h = await ready({ sendEnabled: false });
  assert.deepEqual(h.channels, ["beeper-feed"]);
  assert.deepEqual(h.invites, [["C1", OWNER]]);
  assert.ok(h.posts.some((post) => /off for now/.test(post.text)));
});

test("each chat gets one private channel on arrival plus flat aggregate copies", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming()));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "m2", text: "again" })));
  assert.equal(h.channels.length, 2);
  assert.match(h.channels[1], /^bp-wa-alice-smith-/);
  assert.deepEqual(h.invites, [
    ["C1", OWNER],
    ["C2", OWNER],
  ]);
  assert.equal(h.store.chat("chat1")!.root_ts, null);
  assert.equal(contactPosts(h).length, 2);
  assert.equal(allContactPosts(h).length, 4);
  assert.ok(allContactPosts(h).every((post) => !post.threadTs));
  assert.equal(contactPosts(h)[0].username, "Alice");
  assert.match(
    allContactPosts(h).find((p) => p.channel === "C1")!.text,
    /^<#C2> · Alice Smith · WhatsApp\nhello$/,
  );
});

test("duplicate upserts mirror once and reach the agent once", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming()));
  await h.relay.onBeeperEvent(upsert(incoming()));
  h.searchResult = [incoming()];
  await h.relay.reconcile();
  assert.equal(contactPosts(h).length, 1);
  assert.equal(h.feed.length, 1);
});

test("reactions, hidden messages and history from before the first run are skipped", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming({ id: "a", type: "REACTION" })));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "b", isHidden: true })));
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "c", timestamp: new Date(T0 - 1000).toISOString() })),
  );
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 0);
});

test("old read history is treated as backfill, but an old unread message still comes through", async () => {
  const h = await ready();
  h.setNow(T0 + 3 * 24 * 3_600_000);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "read", isUnread: false })));
  assert.equal(contactPosts(h).length, 0);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "unread", isUnread: true })));
  assert.equal(contactPosts(h).length, 1);
  assert.match(contactPosts(h)[0].text, /sent <!date/);
});

test("Slack chats bridged into Beeper are never mirrored, which prevents loops", async () => {
  const h = await ready();
  h.chats.set("slackchat", {
    id: "slackchat",
    accountID: "slackgo.T1",
    network: "Slack",
    title: "Work",
  });
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "slackchat" })));
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 0);
});

test("excluded chats are hidden from both Slack and the agent", async () => {
  const h = await ready();
  h.chats.set("chat-excluded", {
    id: "chat-excluded",
    accountID: "signal",
    network: "Signal",
    title: "Private",
  });
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "chat-excluded" })));
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 0);
});

test("excluded networks match by label or account prefix, and stay out of Slack and the agent", async () => {
  const h = await ready();
  h.chats.set("agent", {
    id: "agent",
    accountID: "mybot.cursor:google-oauth2|user/team/0",
    network: "My Bot",
    title: "Agent",
  });
  h.chats.set("helper", { id: "helper", accountID: "x", network: "my-agents", title: "Helper" });
  await h.relay.onBeeperEvent(upsert(incoming({ id: "a", chatID: "agent" })));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "b", chatID: "helper" })));
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 0);
});

test("a message with no text, attachment or known type is skipped", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming({ text: undefined, type: undefined })));
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 0);
});

test("formatted messages reach Slack as Slack text, not raw HTML", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming({ text: "<p><strong>Hi</strong> there</p>" })));
  assert.equal(contactPosts(h)[0].text, "*Hi* there");
  assert.equal(h.feed[0].text, "*Hi* there");
});

test("muted chats get no channel by default but the agent still sees them", async () => {
  const h = await ready();
  h.chats.set("chat1", { ...h.chats.get("chat1")!, isMuted: true });
  await h.relay.onBeeperEvent(upsert(incoming()));
  assert.equal(contactPosts(h).length, 0);
  assert.equal(h.feed.length, 1);
});

test("merged chats share one private channel, so a contact on two networks stays together", async () => {
  const h = await ready();
  h.chats.set("merged", { id: "merged", accountID: "merged", network: "Merged", title: "Alice" });
  h.chats.set("wa", {
    id: "wa",
    accountID: "whatsapp",
    network: "WhatsApp",
    title: "Alice",
    mergedIntoChatID: "merged",
  });
  h.chats.set("sig", {
    id: "sig",
    accountID: "signal",
    network: "Signal",
    title: "Alice",
    mergedIntoChatID: "merged",
  });
  await h.relay.onBeeperEvent(upsert(incoming({ id: "a", chatID: "wa" })));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "b", chatID: "sig" })));
  assert.equal(h.channels.length, 2);
  assert.equal(contactPosts(h)[0].channel, contactPosts(h)[1].channel);
  assert.equal(contactPosts(h).length, 2);
});

test("a failed Slack post is retried by the next reconcile without duplicates", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  assert.ok(channel);
  const before = contactPosts(h).length;
  h.failNextPost = new Error("slack down");
  await h.relay.onBeeperEvent(upsert(incoming({ id: "m9" })));
  assert.equal(contactPosts(h).length, before);
  assert.equal(h.store.message("m9"), null);
  h.searchResult = [incoming({ id: "m9" })];
  await h.relay.reconcile();
  await h.relay.reconcile();
  assert.equal(contactPosts(h).length, before + 1);
});

test("the watermark only advances when a reconcile fully succeeds", async () => {
  const h = await ready();
  await mirroredChannel(h);
  h.setNow(T0 + 60_000);
  h.failNextPost = new Error("slack down");
  h.searchResult = [incoming({ id: "m9" })];
  await h.relay.reconcile();
  assert.equal(h.store.getMeta("watermark"), String(T0));
  await h.relay.reconcile();
  assert.equal(h.store.getMeta("watermark"), String(T0 + 60_000));
});

test("an edit updates the Slack message and a deletion replaces it", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming()));
  const ts = h.store.message("m1")!.slack_ts!;
  await h.relay.onBeeperEvent(upsert(incoming({ text: "fixed", editedTimestamp: "e1" })));
  await h.relay.onBeeperEvent(upsert(incoming({ text: "fixed", editedTimestamp: "e1" })));
  assert.deepEqual(h.updates[0], [ts, "fixed _(edited)_"]);
  assert.equal(h.updates.length, 2);
  assert.match(h.updates[1][1], /fixed _\(edited\)_$/);
  await h.relay.onBeeperEvent({ type: "message.deleted", chatID: "chat1", ids: ["m1"] });
  await h.relay.onBeeperEvent({ type: "message.deleted", chatID: "chat1", ids: ["m1"] });
  assert.deepEqual(h.updates[2], [ts, "_(message deleted)_"]);
  assert.equal(h.updates.length, 4);
});

test("attachments are copied to Slack", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(
    upsert(
      incoming({
        text: undefined,
        type: "IMAGE",
        attachments: [{ srcURL: "file:///tmp/p.jpg", fileName: "p.jpg" }],
      }),
    ),
  );
  assert.deepEqual(h.uploads, ["/tmp/p.jpg", "/tmp/p.jpg"]);
  assert.deepEqual(h.uploadThreads, [undefined, feedTs(h, "m1")]);
  assert.match(contactPosts(h)[0].text, /photo/);
});

test("a failed attachment copy leaves a visible note and keeps the message", async () => {
  const h = await ready();
  h.failNextUpload = new Error("too large");
  await h.relay.onBeeperEvent(
    upsert(incoming({ type: "IMAGE", attachments: [{ srcURL: "file:///tmp/p.jpg" }] })),
  );
  assert.equal(h.uploads.length, 1);
  assert.ok(h.posts.some((post) => /couldn't be copied/.test(post.text)));
  assert.ok(h.store.message("m1")?.slack_ts);
});

test("Beeper replies appear as normal messages in their channel and aggregate feed", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(upsert(incoming()));
  const parent = h.store.message("m1")!.slack_ts!;
  await h.relay.onBeeperEvent(upsert(incoming({ id: "m2", linkedMessageID: "m1" })));
  const reply = contactPosts(h).at(-1)!;
  assert.equal(reply.threadTs, undefined);
  assert.equal(allContactPosts(h).filter((p) => p.channel === "C1").length, 2);
});

test("the owner replying to a mapped feed message sends to Beeper", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  assert.deepEqual(h.sends, [{ chatId: "chat1", body: { text: "hi there" } }]);
});

test("with sending off, nothing reaches the contact and the owner is told", async () => {
  const h = await ready({ sendEnabled: false });
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  assert.equal(h.sends.length, 0);
  assert.match(h.ephemerals[0], /turned off/);
});

test("anyone can send: other people, agents, and apps posting as the owner or as themselves", async () => {
  const h = await ready();
  await mirroredChannel(h);
  // An app such as Composio posting with the owner's account: owner user plus the app's bot_id.
  await h.relay.onSlackEvent(
    slackEvent(h, { bot_id: "BCOMPOSIO", client_msg_id: undefined, ts: "501.1", text: "a" }),
  );
  // Another agent's bot user, e.g. an AI agent posting as itself.
  await h.relay.onSlackEvent(
    slackEvent(h, {
      user: "UAGENT",
      bot_id: "BAGENT",
      client_msg_id: undefined,
      ts: "502.1",
      text: "b",
    }),
  );
  // A classic bot post with no user at all.
  await h.relay.onSlackEvent(
    slackEvent(h, {
      subtype: "bot_message",
      user: undefined,
      bot_id: "BOTHER",
      client_msg_id: undefined,
      ts: "503.1",
      text: "c",
    }),
  );
  await h.relay.onSlackEvent(slackEvent(h, { user: "USOMEONE", client_msg_id: "d", text: "d" }));
  assert.deepEqual(
    h.sends.map((send) => send.body.text),
    ["a", "b", "c", "d"],
  );
});

test("agents replying in a thread that didn't start from Beeper stay in Slack", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "alex"));
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "ig", text: "wanted to share this" })));
  const channel = h.store.chat("ig")!.personal_channel!;
  const contactRoot = h.store.message("m1")!.slack_ts!;
  assert.equal(h.store.message("m1")!.channel, channel);
  const post = (overrides: Partial<SlackMessageEvent> & { ts: string }) =>
    h.relay.onSlackEvent({ type: "message", channel, text: "x", ...overrides });

  // The owner asks an agent at the top level, which is held back because it mentions someone.
  await post({ user: OWNER, ts: "800.1", client_msg_id: "ask", text: "<@UAGENT> block this" });
  assert.equal(h.sends.length, 0);
  // The agent and another bot answer in that thread as themselves: none of it reaches the contact.
  await post({ user: "UAGENT", bot_id: "BAGENT", ts: "800.2", thread_ts: "800.1", text: "a" });
  await post({
    user: "UOTHERBOT",
    bot_id: "BOTHERBOT",
    ts: "800.3",
    thread_ts: "800.1",
    text: "b",
  });
  // Under a message the owner sent, too, and in a thread whose root the relay doesn't know.
  await post({ user: OWNER, ts: "801.1", client_msg_id: "sent", text: "hey" });
  await post({ user: "UAGENT", bot_id: "BAGENT", ts: "801.2", thread_ts: "801.1", text: "c" });
  await post({ user: "UAGENT", bot_id: "BAGENT", ts: "802.2", thread_ts: "802.1", text: "d" });
  assert.deepEqual(
    h.sends.map((send) => send.body.text),
    ["hey"],
  );
  // Posts in the owner's name still send from a side thread: typed, or by an app such as Composio.
  await post({ user: OWNER, ts: "800.4", thread_ts: "800.1", client_msg_id: "typed", text: "e" });
  await post({ user: OWNER, bot_id: "BCOMPOSIO", ts: "800.5", thread_ts: "800.1", text: "f" });
  // The agent replying under the contact's own message is talking to the contact, so it sends.
  await post({
    user: "UAGENT",
    bot_id: "BAGENT",
    ts: "803.1",
    thread_ts: contactRoot,
    text: "g",
  });
  assert.deepEqual(
    h.sends.map((send) => send.body.text),
    ["hey", "e", "f", "g"],
  );
  assert.equal(h.ephemerals.length, 1);
});

test("the relay never sends its own posts, so mirrored messages cannot loop", async () => {
  const h = await ready();
  await mirroredChannel(h);
  // Slack echoes the relay's mirrored post (custom username) back as a bot_message from its own bot.
  const echo = (overrides: Partial<SlackMessageEvent>) =>
    slackEvent(h, { client_msg_id: undefined, text: "hello", ...overrides });
  await h.relay.onSlackEvent(
    echo({ subtype: "bot_message", user: undefined, bot_id: RELAY_BOT, ts: "600.1" }),
  );
  await h.relay.onSlackEvent(echo({ user: RELAY_USER, bot_id: RELAY_BOT, ts: "601.1" }));
  await h.relay.onSlackEvent(echo({ user: RELAY_USER, ts: "602.1" }));
  assert.equal(h.sends.length, 0);
  // The same post from any other bot is routed and sent, so the checks above were reachable.
  await h.relay.onSlackEvent(
    echo({ subtype: "bot_message", user: undefined, bot_id: "BOTHER", ts: "603.1" }),
  );
  assert.equal(h.sends.length, 1);
});

test("housekeeping and messages outside a chat's channel or thread are ignored", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h, { subtype: "channel_join", client_msg_id: "c" }));
  await h.relay.onSlackEvent(slackEvent(h, { channel: "CUNKNOWN", client_msg_id: "d" }));
  await h.relay.onSlackEvent(slackEvent(h, { thread_ts: undefined, client_msg_id: "e" }));
  assert.equal(h.sends.length, 0);
});

test("a redelivered Slack event can never send twice", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  await h.relay.onSlackEvent(slackEvent(h));
  assert.equal(h.sends.length, 1);
});

test("notes and @mentions stay in Slack", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h, { client_msg_id: "a", text: "// note to self" }));
  await h.relay.onSlackEvent(
    slackEvent(h, { client_msg_id: "b", text: "<@UAGENT> draft a reply" }),
  );
  assert.equal(h.sends.length, 0);
  assert.equal(h.ephemerals.length, 2);
});

test("sent messages are not mirrored back, and delivery gets a checkmark", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h, { ts: "500.1" }));
  const before = contactPosts(h).length;
  await h.relay.onBeeperEvent(
    upsert(
      incoming({
        id: "pending1",
        isSender: true,
        text: "hi there",
        sendStatus: { status: "PENDING" },
      }),
    ),
  );
  assert.equal(h.reactions.length, 0);
  await h.relay.onBeeperEvent(
    upsert(
      incoming({
        id: "pending1",
        isSender: true,
        text: "hi there",
        sendStatus: { status: "SUCCESS" },
      }),
    ),
  );
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "final1", isSender: true, text: "<p><strong>hi</strong> there</p>" })),
  );
  assert.equal(contactPosts(h).length, before + 1);
  assert.deepEqual(h.reactions, [["500.1", "white_check_mark"]]);
});

test("a send that fails later is flagged on the Slack message", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h, { ts: "500.1" }));
  await h.relay.onBeeperEvent(
    upsert(
      incoming({
        id: "pending1",
        isSender: true,
        text: "hi there",
        sendStatus: { status: "FAIL_PERMANENT" },
      }),
    ),
  );
  assert.deepEqual(h.reactions, [["500.1", "warning"]]);
  assert.match(h.ephemerals.at(-1)!, /failed to send/);
});

test("a send rejected outright is flagged immediately", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  h.failNextSend = new Error("nope");
  await h.relay.onSlackEvent(slackEvent(h, { ts: "500.1" }));
  assert.deepEqual(h.reactions, [["500.1", "warning"]]);
  assert.match(h.ephemerals.at(-1)!, /failed to send/);
});

test("messages you send from your phone are shown, and add context for the agent without waking it", async () => {
  const h = await ready();
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "phone", isSender: true, text: "from my phone" })),
  );
  assert.match(contactPosts(h)[0].username!, /another device/);
  assert.equal(h.feed[0].sender, "You");
  assert.equal(h.feed[0].fromOwner, true);
});

test("partial live events fetch sender direction before echo matching", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  const complete = incoming({ id: "final1", isSender: true, text: "hi there" });
  h.messages.set(complete.id, complete);
  const before = contactPosts(h).length;
  await h.relay.onBeeperEvent(upsert({ ...complete, isSender: undefined, senderName: undefined }));
  assert.equal(contactPosts(h).length, before + 1);
  assert.equal(h.store.message("final1")!.from_slack, 1);
  assert.deepEqual(h.reactions, [["500.1", "white_check_mark"]]);
});

test("a feed reply sends normal chat text without quoting a routing header", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  assert.deepEqual(h.sends[0].body, { text: "hi there" });
});

test("files typed into Slack are uploaded and sent, with text only on the first", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(
    slackEvent(h, {
      subtype: "file_share",
      files: [
        { url_private_download: "https://files/a", name: "a.png" },
        { url_private_download: "https://files/b", name: "b.png" },
      ],
    }),
  );
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[0].body, { text: "hi there", attachment: { uploadID: "upload1" } });
  assert.deepEqual(h.sends[1].body, { attachment: { uploadID: "upload1" } });
});

test("editing a sent message warns that the contact still has the original, but notes do not", async () => {
  const h = await ready();
  const channel = await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h, { ts: "500.1" }));
  const change = (ts: string): SlackMessageEvent => ({
    type: "message",
    subtype: "message_changed",
    channel,
    ts: "501.0",
    message: { text: "new", user: OWNER },
    previous_message: { text: "old", user: OWNER, ts },
  });
  await h.relay.onSlackEvent(change("999.9"));
  assert.equal(h.ephemerals.length, 0);
  await h.relay.onSlackEvent(change("500.1"));
  assert.match(h.ephemerals[0], /still has the original/);
});

test("a temporarily unavailable aggregate feed retries without duplicating its chat channel", async () => {
  const h = await ready();
  await mirroredChannel(h);
  for (const code of ["channel_not_found", "is_archived"]) {
    const message = incoming({ id: code });
    h.failPostChannel = "C1";
    h.failNextPost = Object.assign(new Error(code), { data: { error: code } });
    await h.relay.onBeeperEvent(upsert(message));
    assert.ok(h.store.message(code));
    assert.equal(h.store.mirrors(`beeper:${code}`).length, 0);
    const count = contactPosts(h).length;
    h.searchResult = [message];
    await h.relay.reconcile();
    await h.relay.reconcile();
    assert.equal(contactPosts(h).length, count);
    assert.equal(h.store.mirrors(`beeper:${code}`).length, 1);
  }
  assert.equal(h.channels.length, 2);
});

test("two chats get separate channels and feed replies route by the particular message", async () => {
  const h = await ready();
  h.chats.set("chat2", { id: "chat2", accountID: "signal", network: "Signal", title: "Bob" });
  await h.relay.onBeeperEvent(upsert(incoming({ id: "seed" })));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "bob1", chatID: "chat2" })));
  const alice = h.store.chat("chat1")!;
  const bob = h.store.chat("chat2")!;
  assert.notEqual(alice.personal_channel, bob.personal_channel);
  assert.equal(h.channels.length, 3);
  assert.equal(alice.root_ts, null);
  assert.equal(bob.root_ts, null);
  await h.relay.onSlackEvent(
    slackEvent(h, { thread_ts: feedTs(h, "bob1"), client_msg_id: "bob-reply" }),
  );
  await h.relay.onSlackEvent(slackEvent(h, { thread_ts: undefined, client_msg_id: "top-level" }));
  await h.relay.onSlackEvent(
    slackEvent(h, { thread_ts: h.store.getMeta("feed_status_thread")!, client_msg_id: "digest" }),
  );
  assert.deepEqual(h.sends, [{ chatId: "chat2", body: { text: "hi there" } }]);
});

const realPerson = (id: string, username: string): BeeperChat => ({
  id,
  accountID: "instagramgo.1",
  network: "Instagram",
  title: `Name ${username}`,
  type: "single",
  participants: {
    items: [
      { id: "me", isSelf: true },
      { id: `@${username}:x`, username },
    ],
  },
});

test("channel names use platform and readable identity, and only new messages create them", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "leonsilicon"));
  await h.relay.relabelThreads();
  assert.deepEqual(h.channels, ["beeper-feed"]);
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "ig" })));
  assert.deepEqual(h.channels, ["beeper-feed", "bp-ig-leonsilicon"]);
  assert.equal(h.store.chat("ig")!.root_ts, null);
});

test("groups and bots also get their own channel on arrival", async () => {
  const h = await ready();
  h.chats.set("group", { ...realPerson("group", "leon"), title: "Friends", type: "group" });
  h.chats.set("assistant", {
    id: "assistant",
    accountID: "aibridge.owner",
    network: "aibridge",
    title: "Assistant",
    type: "single",
  });
  for (const chatID of ["group", "assistant"])
    await h.relay.onBeeperEvent(upsert(incoming({ id: chatID, chatID })));
  assert.ok(h.channels.some((name) => name.startsWith("bp-ig-grp-friends-")));
  assert.ok(h.channels.some((name) => name.startsWith("bp-aibridge-assistant-")));
  assert.equal(allContactPosts(h).length, 4);
  assert.deepEqual(h.invites, [
    ["C1", OWNER],
    ["C2", OWNER],
    ["C3", OWNER],
  ]);
});

test("existing feed threads keep routing while the migration waits for new messages to create channels", async () => {
  const h = await ready();
  h.store.saveChat("chat1", "C1", "Alice", "WhatsApp", "legacy.1");
  await h.relay.relabelThreads();
  await h.relay.relabelThreads();
  assert.equal(h.updates.length, 2); // Status and one legacy header, updated once.
  assert.deepEqual(h.channels, ["beeper-feed"]);
  await h.relay.onSlackEvent({
    type: "message",
    channel: "C1",
    thread_ts: "legacy.1",
    user: OWNER,
    text: "hello",
    ts: "legacy.reply",
    client_msg_id: "legacy",
  });
  assert.equal(h.sends.length, 1);
});

test("chat channels automatically invite the owner, with //join retained as a shortcut", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "leon"));
  const message = incoming({ chatID: "ig" });
  await h.relay.onBeeperEvent(upsert(message));
  await h.relay.onBeeperEvent(upsert(message));
  const route = h.store.chat("ig")!;
  assert.deepEqual(h.channels, ["beeper-feed", "bp-ig-leon"]);
  assert.deepEqual(h.invites, [
    ["C1", OWNER],
    ["C2", OWNER],
  ]);
  assert.equal(allContactPosts(h).length, 2);
  assert.ok(allContactPosts(h).every((post) => !post.threadTs));
  await h.relay.onSlackEvent({
    type: "message",
    channel: "C1",
    thread_ts: feedTs(h, "m1"),
    user: OWNER,
    text: "//join",
    ts: "join.1",
    client_msg_id: "join",
  });
  assert.deepEqual(h.invites.at(-1), [route.personal_channel, OWNER]);
  assert.equal(h.sends.length, 0);
});

test("owner replies in a chat channel forward to Beeper and echo into the feed once", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "leon"));
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "ig" })));
  const row = h.store.chat("ig")!;
  const before = allContactPosts(h).length;
  await h.relay.onSlackEvent({
    type: "message",
    channel: row.personal_channel!,
    user: OWNER,
    text: "hi there",
    ts: "700.1",
    client_msg_id: "personal-reply",
  });
  assert.deepEqual(h.sends, [{ chatId: "ig", body: { text: "hi there" } }]);
  for (const id of ["pending1", "final1"]) {
    await h.relay.onBeeperEvent(
      upsert(
        incoming({
          id,
          chatID: "ig",
          isSender: true,
          text: "hi there",
          sendStatus: { status: "SUCCESS" },
        }),
      ),
    );
  }
  const added = allContactPosts(h).slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].channel, "C1");
  assert.equal(added[0].threadTs, undefined);
  assert.match(added[0].username!, /via Slack/);
});

test("owner replies to a feed message echo into its chat channel once", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "leon"));
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "ig" })));
  const row = h.store.chat("ig")!;
  const before = allContactPosts(h).length;
  await h.relay.onSlackEvent({
    type: "message",
    channel: "C1",
    thread_ts: feedTs(h, "m1"),
    user: OWNER,
    text: "hi there",
    ts: "800.1",
    client_msg_id: "feed-reply",
  });
  for (const id of ["pending1", "final1"]) {
    await h.relay.onBeeperEvent(
      upsert(
        incoming({
          id,
          chatID: "ig",
          isSender: true,
          text: "hi there",
          sendStatus: { status: "SUCCESS" },
        }),
      ),
    );
  }
  const added = allContactPosts(h).slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].channel, row.personal_channel);
  assert.equal(added[0].threadTs, undefined);
});

test("Beeper edits and deletions update both destinations while retaining feed attribution", async () => {
  const h = await ready();
  h.chats.set("ig", realPerson("ig", "leon"));
  await h.relay.onBeeperEvent(upsert(incoming({ chatID: "ig" })));
  await h.relay.onBeeperEvent(
    upsert(incoming({ chatID: "ig", text: "fixed", editedTimestamp: "changed" })),
  );
  assert.equal(h.updates.filter(([, text]) => text.endsWith("fixed _(edited)_")).length, 2);
  assert.match(h.updates[1][1], /^<#C2> · Name leon · Instagram/);
  await h.relay.onBeeperEvent({ type: "message.deleted", chatID: "ig", ids: ["m1"] });
  assert.equal(h.updates.filter(([, text]) => text.endsWith("_(message deleted)_")).length, 2);
});

// Empty-text attachment sends must retain independent echo mappings.
test("multiple files in one Slack message each echo once to the other destination", async () => {
  const h = await ready();
  await mirroredChannel(h);
  const channel = h.store.chat("chat1")!.personal_channel!;
  await h.relay.onSlackEvent(
    slackEvent(h, {
      channel,
      thread_ts: undefined,
      text: "",
      subtype: "file_share",
      files: [
        { url_private_download: "https://files/a", name: "a.png" },
        { url_private_download: "https://files/b", name: "b.png" },
      ],
    }),
  );
  const before = allContactPosts(h).length;
  for (const id of ["pending1", "pending2"]) {
    await h.relay.onBeeperEvent(
      upsert(
        incoming({
          id,
          isSender: true,
          text: "",
          type: "IMAGE",
          sendStatus: { status: "PENDING" },
        }),
      ),
    );
  }
  for (const id of ["final1", "final2"]) {
    const message = incoming({ id, isSender: true, text: "", type: "IMAGE" });
    await h.relay.onBeeperEvent(upsert(message));
    await h.relay.onBeeperEvent(upsert(message));
  }
  assert.equal(allContactPosts(h).length, before + 2);
  assert.equal(h.store.message("final1")!.from_slack, 1);
  assert.equal(h.store.message("final2")!.from_slack, 1);
});

test("two distinct chats with the same readable label never reuse each other's channel", async () => {
  const h = await ready();
  for (const id of ["first", "second"]) {
    h.chats.set(id, realPerson(id, "same"));
    await h.relay.onBeeperEvent(upsert(incoming({ id, chatID: id })));
  }
  const first = h.store.chat("first")!.personal_channel!;
  const second = h.store.chat("second")!.personal_channel!;
  assert.notEqual(first, second);
  assert.equal(h.channels[1], "bp-ig-same");
  assert.match(h.channels[2], /^bp-ig-same-[a-z0-9]+$/);
  await h.relay.onSlackEvent({
    type: "message",
    channel: second,
    user: OWNER,
    text: "second chat",
    ts: "1.0",
  });
  assert.equal(h.sends[0].chatId, "second");
});

test("failed echo copies of separate attachments retry using their own outbound records", async () => {
  const h = await ready();
  await mirroredChannel(h);
  const channel = h.store.chat("chat1")!.personal_channel!;
  await h.relay.onSlackEvent(
    slackEvent(h, {
      channel,
      thread_ts: undefined,
      text: "",
      subtype: "file_share",
      files: [
        { url_private_download: "https://files/a" },
        { url_private_download: "https://files/b" },
      ],
    }),
  );
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "final1", isSender: true, text: "", type: "IMAGE" })),
  );
  h.failPostChannel = "C1";
  h.failNextPost = new Error("temporary");
  const second = incoming({ id: "final2", isSender: true, text: "", type: "IMAGE" });
  await h.relay.onBeeperEvent(upsert(second));
  const before = allContactPosts(h).length;
  h.searchResult = [second];
  await h.relay.reconcile();
  await h.relay.reconcile();
  assert.equal(allContactPosts(h).length, before + 1);
});

test("Slack connector context attribution does not change //join or get sent to Beeper", async () => {
  const h = await ready();
  await mirroredChannel(h);
  const blocks = (text: string) => [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "*Sent using* <@UAPP>" }] },
  ];
  await h.relay.onSlackEvent(
    slackEvent(h, { text: "//join *Sent using* <@UAPP>", blocks: blocks("//join") }),
  );
  assert.deepEqual(h.invites.at(-1), [h.store.chat("chat1")!.personal_channel, OWNER]);
  assert.equal(h.sends.length, 0);
  await h.relay.onSlackEvent(
    slackEvent(h, {
      text: "hello *Sent using* <@UAPP>",
      blocks: blocks("hello"),
      client_msg_id: "tool-reply",
    }),
  );
  assert.deepEqual(h.sends, [{ chatId: "chat1", body: { text: "hello" } }]);
  await h.relay.onSlackEvent(
    slackEvent(h, {
      text: "<@UAGENT> draft this *Sent using* <@UAPP>",
      blocks: blocks("<@UAGENT> draft this"),
      client_msg_id: "held-tool-reply",
    }),
  );
  assert.equal(h.sends.length, 1);
});

test("sending the same text again from Beeper appears in its own chat channel and feed", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "final1", isSender: true, text: "hi there" })));
  const before = allContactPosts(h).length;
  const native = incoming({ id: "native1", isSender: true, text: "hi there" });
  await h.relay.onBeeperEvent(upsert(native));
  await h.relay.onBeeperEvent(upsert(native));
  const saved = h.store.message("native1")!;
  assert.equal(saved.from_slack, 0);
  assert.equal(saved.channel, h.store.chat("chat1")!.personal_channel);
  const copies = allContactPosts(h).slice(before);
  assert.equal(copies.length, 2);
  assert.deepEqual(new Set(copies.map((p) => p.channel)), new Set([saved.channel, "C1"]));
  assert.ok(copies.every((p) => /another device/.test(p.username!)));
});

test("a native Beeper message with identical text cannot consume an in-flight Slack send", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "native-first", isSender: true, text: "hi there" })),
  );
  assert.equal(h.store.message("native-first")!.from_slack, 0);
  assert.equal(h.reactions.length, 0);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "final1", isSender: true, text: "hi there" })));
  assert.equal(h.store.message("final1")!.from_slack, 1);
  assert.deepEqual(h.reactions, [["500.1", "white_check_mark"]]);
});

test("previously misclassified native Beeper sends are repaired during reconciliation", async () => {
  const h = await ready();
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "final1", isSender: true, text: "hi there" })));
  const original = h.store.message("final1")!;
  h.store.saveMessage({
    id: "native-old",
    chatKey: "chat1",
    slackTs: original.slack_ts,
    channel: original.channel,
    fromSlack: true,
    outboundId: original.outbound_id!,
  });
  const before = allContactPosts(h).length;
  h.searchResult = [incoming({ id: "native-old", isSender: true, text: "hi there" })];
  await h.relay.reconcile();
  await h.relay.reconcile();
  assert.equal(h.store.message("native-old")!.from_slack, 0);
  assert.equal(allContactPosts(h).length, before + 2);
});

test("an unresolvable old Slack send cannot block messages sent from Beeper", async () => {
  const h = await ready();
  await mirroredChannel(h);
  h.store.addOutbound({
    chatKey: "chat1",
    pendingId: "expired-send",
    echoHash: "",
    channel: "C1",
    slackTs: "old.1",
    now: T0,
  });
  const before = allContactPosts(h).length;
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "phone-new", isSender: true, text: "a native message" })),
  );
  assert.equal(h.store.message("phone-new")!.from_slack, 0);
  assert.equal(allContactPosts(h).length, before + 2);
});

test("merged-chat Slack sends resolve IDs using the member chat Beeper actually selected", async () => {
  const h = await ready({ routedSendChatId: "member-chat" });
  await mirroredChannel(h);
  await h.relay.onSlackEvent(slackEvent(h));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "final1", isSender: true, text: "hi there" })));
  assert.ok(h.messageLookups.some(([chatId, id]) => chatId === "member-chat" && id === "pending1"));
  assert.equal(h.store.message("final1")!.from_slack, 1);
});

test("a Beeper send reopens its archived Slack chat channel and keeps the same channel mapping", async () => {
  const h = await ready();
  await mirroredChannel(h);
  const original = h.store.chat("chat1")!.personal_channel!;
  const count = h.channels.length;
  h.failPostChannel = original;
  h.failNextPost = Object.assign(new Error("archived"), { data: { error: "is_archived" } });
  const before = allContactPosts(h).length;
  await h.relay.onBeeperEvent(
    upsert(incoming({ id: "from-phone", isSender: true, text: "from Beeper" })),
  );
  assert.deepEqual(h.unarchives, [original]);
  assert.equal(h.channels.length, count);
  assert.equal(h.store.message("from-phone")!.channel, original);
  assert.equal(allContactPosts(h).length, before + 2);
  assert.deepEqual(h.invites, [
    ["C1", OWNER],
    ["C2", OWNER],
    ["C2", OWNER],
  ]);
});

test("startup invites the owner to every existing channel even when an old invited flag is stale", async () => {
  const h = await ready();
  await mirroredChannel(h);
  h.chats.set("second", realPerson("second", "second"));
  await h.relay.onBeeperEvent(upsert(incoming({ id: "second", chatID: "second" })));
  h.invites.length = 0;
  await h.relay.init();
  assert.deepEqual(new Set(h.invites.map(([channel]) => channel)), new Set(["C2", "C3"]));
  assert.ok(h.invites.every(([, user]) => user === OWNER));
  assert.equal(h.channels.length, 3);
});

test("a failed automatic invitation is retried without creating another channel", async () => {
  const h = await ready();
  h.failNextInvite = new Error("temporary Slack failure");
  await h.relay.onBeeperEvent(upsert(incoming()));
  const channel = h.store.chat("chat1")!.personal_channel!;
  assert.equal(h.store.chat("chat1")!.invited, 0);
  assert.equal(h.store.message("m1"), null);
  h.searchResult = [incoming()];
  await h.relay.reconcile();
  await h.relay.reconcile();
  assert.equal(h.channels.length, 2);
  assert.equal(h.store.chat("chat1")!.personal_channel, channel);
  assert.equal(h.store.chat("chat1")!.invited, 1);
  assert.deepEqual(h.invites.at(-1), [channel, OWNER]);
  assert.equal(allContactPosts(h).length, 2);
});

test("startup reopens an archived chat channel before inviting the owner", async () => {
  const h = await ready();
  await mirroredChannel(h);
  const channel = h.store.chat("chat1")!.personal_channel!;
  h.failNextInvite = Object.assign(new Error("archived"), { data: { error: "is_archived" } });
  await h.relay.init();
  assert.deepEqual(h.unarchives, [channel]);
  assert.deepEqual(h.invites.at(-1), [channel, OWNER]);
});

test("the feed and each new chat channel are filed in the sidebar section once, after the owner joins", async () => {
  const h = await ready({ sidebar: true });
  const feed = h.store.getMeta("feed_channel")!;
  assert.deepEqual(h.filed, [[feed]]);
  await mirroredChannel(h);
  const personal = h.store.chat("chat1")!.personal_channel!;
  assert.deepEqual(h.filed, [[feed], [personal]]);
  assert.deepEqual(h.invites.at(-1), [personal, OWNER]);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "second" })));
  await h.relay.init();
  assert.deepEqual(h.filed, [[feed], [personal]]);
});

test("without the owner's session nothing is filed and relaying is unchanged", async () => {
  const h = await ready();
  await mirroredChannel(h);
  assert.deepEqual(h.filed, []);
  assert.equal(contactPosts(h).length, 1);
});

test("a failed filing never holds up a message and is retried after a pause", async () => {
  const h = await ready({ sidebar: true });
  h.failNextFiling = Object.assign(new Error("slow down"), { data: { error: "ratelimited" } });
  await mirroredChannel(h);
  const personal = h.store.chat("chat1")!.personal_channel!;
  assert.equal(contactPosts(h).length, 1);
  assert.equal(h.filed.length, 1);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "soon" })));
  assert.equal(h.filed.length, 1);
  h.setNow(T0 + 11 * 60_000);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "later" })));
  assert.deepEqual(h.filed.at(-1), [personal]);
  assert.equal(contactPosts(h).length, 3);
});

test("startup files every channel a failed attempt missed, in one request", async () => {
  const h = await ready({ sidebar: true });
  h.failNextFiling = new Error("network down");
  await mirroredChannel(h);
  h.chats.set("second", realPerson("second", "second"));
  h.setNow(T0 + 11 * 60_000);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "second", chatID: "second" })));
  const [first, second] = ["chat1", "second"].map((key) => h.store.chat(key)!.personal_channel!);
  assert.deepEqual(h.filed.at(-1), [second]);
  h.filed.length = 0;
  h.setNow(T0 + 22 * 60_000);
  await h.relay.init();
  assert.deepEqual(h.filed, [[first]]);
});

test("a signed-out session stops filing and warns once in the status thread", async () => {
  const h = await ready({ sidebar: true });
  h.failNextFiling = Object.assign(new Error("signed out"), { data: { error: "invalid_auth" } });
  await mirroredChannel(h);
  const warnings = h.posts.filter((post) => post.text.includes("sidebar section"));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].threadTs, h.store.getMeta("feed_status_thread"));
  assert.match(warnings[0].text, /invalid_auth/);
  h.chats.set("second", realPerson("second", "second"));
  h.setNow(T0 + 60 * 60_000);
  await h.relay.onBeeperEvent(upsert(incoming({ id: "second", chatID: "second" })));
  assert.equal(h.filed.length, 1);
  assert.equal(contactPosts(h).length, 2);
});

test("a reopened archived chat channel is filed in the section again", async () => {
  const h = await ready({ sidebar: true });
  await mirroredChannel(h);
  const personal = h.store.chat("chat1")!.personal_channel!;
  h.failPostChannel = personal;
  h.failNextPost = Object.assign(new Error("archived"), { data: { error: "is_archived" } });
  await h.relay.onBeeperEvent(upsert(incoming({ id: "after-archive" })));
  assert.deepEqual(h.unarchives, [personal]);
  assert.deepEqual(h.filed.at(-1), [personal]);
  assert.equal(h.filed.filter((channels) => channels.includes(personal)).length, 2);
});
