import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ChatRow {
  key: string;
  channel: string | null;
  root_ts: string | null;
  personal_channel: string | null;
  title: string;
  network: string;
  invited: number;
  ignored: number;
}

export interface MessageRow {
  id: string;
  chat_key: string;
  slack_ts: string | null;
  thread_ts: string | null;
  channel: string | null;
  edited_at: string | null;
  deleted: number;
  from_slack: number;
  outbound_id: number | null;
}

export interface OutboundRow {
  id: number;
  chat_key: string;
  pending_id: string;
  echo_hash: string;
  channel: string;
  slack_ts: string;
  created_at: number;
  confirmed: number;
  message_id: string | null;
  send_chat_key: string | null;
}

/** Holds ID mappings and hashes only. No message text is stored at rest. */
export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (
        key TEXT PRIMARY KEY, channel TEXT, title TEXT NOT NULL, network TEXT NOT NULL, root_ts TEXT,
        invited INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, slack_ts TEXT, thread_ts TEXT, channel TEXT, edited_at TEXT,
        deleted INTEGER NOT NULL DEFAULT 0, from_slack INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_by_ts ON messages (chat_key, slack_ts);
      CREATE TABLE IF NOT EXISTS outbound (
        id INTEGER PRIMARY KEY, chat_key TEXT NOT NULL, pending_id TEXT NOT NULL, echo_hash TEXT NOT NULL,
        channel TEXT NOT NULL, slack_ts TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS slack_events (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    `);
    // Preserve deployed channel/message mappings while moving chats into one shared channel.
    const chatColumns = this.#db.prepare("PRAGMA table_info(chats)").all() as Array<{
      name: string;
    }>;
    if (!chatColumns.some((column) => column.name === "root_ts")) {
      this.#db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE chats RENAME TO legacy_chats;
        CREATE TABLE chats (
          key TEXT PRIMARY KEY, channel TEXT, title TEXT NOT NULL, network TEXT NOT NULL, root_ts TEXT,
          invited INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO chats (key, channel, title, network, invited, ignored)
          SELECT key, channel, title, network, invited, ignored FROM legacy_chats;
        DROP TABLE legacy_chats;
        COMMIT;
      `);
    }
    const messageColumns = this.#db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    if (!messageColumns.some((column) => column.name === "channel")) {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT;
        UPDATE messages SET channel = (SELECT channel FROM chats WHERE chats.key = messages.chat_key);`);
    }
    if (!messageColumns.some((column) => column.name === "outbound_id")) {
      this.#db.exec("ALTER TABLE messages ADD COLUMN outbound_id INTEGER");
    }
    const outboundColumns = this.#db.prepare("PRAGMA table_info(outbound)").all() as Array<{
      name: string;
    }>;
    if (!outboundColumns.some((column) => column.name === "message_id")) {
      this.#db.exec("ALTER TABLE outbound ADD COLUMN message_id TEXT");
    }
    if (!outboundColumns.some((column) => column.name === "send_chat_key")) {
      this.#db.exec("ALTER TABLE outbound ADD COLUMN send_chat_key TEXT");
    }
    this.#db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS chats_by_thread ON chats(channel, root_ts) WHERE root_ts IS NOT NULL",
    );
    if (
      !(this.#db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).some(
        (column) => column.name === "personal_channel",
      )
    ) {
      this.#db.exec("ALTER TABLE chats ADD COLUMN personal_channel TEXT");
    }
    this.#db
      .exec(`CREATE UNIQUE INDEX IF NOT EXISTS chats_by_personal_channel ON chats(personal_channel) WHERE personal_channel IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mirrors (
        source_key TEXT NOT NULL, channel TEXT NOT NULL, slack_ts TEXT NOT NULL, thread_ts TEXT, chat_key TEXT,
        PRIMARY KEY (source_key, channel)
      );`);
    if (
      !(this.#db.prepare("PRAGMA table_info(mirrors)").all() as Array<{ name: string }>).some(
        (column) => column.name === "chat_key",
      )
    ) {
      this.#db.exec("ALTER TABLE mirrors ADD COLUMN chat_key TEXT");
    }
    this.#db.exec(`CREATE INDEX IF NOT EXISTS mirrors_by_location ON mirrors(channel, slack_ts);
      CREATE INDEX IF NOT EXISTS messages_by_location ON messages(channel, slack_ts)`);
  }

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  deleteMeta(key: string): void {
    this.#db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  chat(key: string): ChatRow | null {
    return (
      (this.#db.prepare("SELECT * FROM chats WHERE key = ?").get(key) as unknown as
        | ChatRow
        | undefined) ?? null
    );
  }

  chats(): ChatRow[] {
    return this.#db.prepare("SELECT * FROM chats").all() as unknown as ChatRow[];
  }

  chatByChannel(channel: string): ChatRow | null {
    return (
      (this.#db.prepare("SELECT * FROM chats WHERE channel = ?").get(channel) as unknown as
        | ChatRow
        | undefined) ?? null
    );
  }

  chatByThread(channel: string, rootTs: string): ChatRow | null {
    return (
      (this.#db
        .prepare("SELECT * FROM chats WHERE channel = ? AND root_ts = ?")
        .get(channel, rootTs) as unknown as ChatRow | undefined) ?? null
    );
  }

  chatByPersonalChannel(channel: string): ChatRow | null {
    return (
      (this.#db
        .prepare("SELECT * FROM chats WHERE personal_channel = ?")
        .get(channel) as unknown as ChatRow | undefined) ?? null
    );
  }

  setPersonalChannel(key: string, channel: string): void {
    this.#db.prepare("UPDATE chats SET personal_channel = ? WHERE key = ?").run(channel, key);
  }

  mirrors(
    sourceKey: string,
  ): Array<{ channel: string; slack_ts: string; thread_ts: string | null }> {
    return this.#db
      .prepare("SELECT channel, slack_ts, thread_ts FROM mirrors WHERE source_key = ?")
      .all(sourceKey) as unknown as Array<{
      channel: string;
      slack_ts: string;
      thread_ts: string | null;
    }>;
  }

  saveMirror(
    sourceKey: string,
    channel: string,
    slackTs: string,
    threadTs?: string,
    chatKey?: string,
  ): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO mirrors (source_key, channel, slack_ts, thread_ts, chat_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sourceKey, channel, slackTs, threadTs ?? null, chatKey ?? null);
  }

  /** Feed replies route by the individual message, never by an ambiguous channel-wide default. */
  chatForSlackMessage(channel: string, ts: string): ChatRow | null {
    const row = this.#db
      .prepare(`SELECT chats.* FROM chats WHERE key = (
      SELECT chat_key FROM messages WHERE channel = ? AND slack_ts = ?
      UNION ALL SELECT chat_key FROM mirrors WHERE channel = ? AND slack_ts = ?
      UNION ALL SELECT chat_key FROM outbound WHERE channel = ? AND slack_ts = ? LIMIT 1
    )`)
      .get(channel, ts, channel, ts, channel, ts) as unknown as ChatRow | undefined;
    return row ?? null;
  }

  /** Whether the relay itself made this post: a chat thread's root, a mirrored Beeper message or a copy. */
  isRelayPost(channel: string, ts: string): boolean {
    return (
      this.#db
        .prepare(`SELECT 1 FROM chats WHERE channel = ? AND root_ts = ?
      UNION ALL SELECT 1 FROM messages WHERE channel = ? AND slack_ts = ? AND from_slack = 0
      UNION ALL SELECT 1 FROM mirrors WHERE channel = ? AND slack_ts = ? LIMIT 1`)
        .get(channel, ts, channel, ts, channel, ts) !== undefined
    );
  }

  saveChat(
    key: string,
    channel: string,
    title: string,
    network: string,
    rootTs: string | null = null,
  ): void {
    this.#db
      .prepare(`INSERT INTO chats (key, channel, title, network, root_ts) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET channel=excluded.channel, title=excluded.title, network=excluded.network, root_ts=excluded.root_ts`)
      .run(key, channel, title, network, rootTs);
  }

  setInvited(key: string, invited = true): void {
    this.#db.prepare("UPDATE chats SET invited = ? WHERE key = ?").run(invited ? 1 : 0, key);
  }

  setIgnored(key: string): void {
    this.#db.prepare("UPDATE chats SET ignored = 1 WHERE key = ?").run(key);
  }

  forgetChannel(key: string): void {
    this.#db.prepare("DELETE FROM chats WHERE key = ?").run(key);
  }

  message(id: string): MessageRow | null {
    return (
      (this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as
        | MessageRow
        | undefined) ?? null
    );
  }

  saveMessage(row: {
    id: string;
    chatKey: string;
    slackTs: string | null;
    threadTs?: string | null;
    channel?: string | null;
    editedAt?: string | null;
    fromSlack?: boolean;
    outboundId?: number;
  }): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO messages (id, chat_key, slack_ts, thread_ts, channel, edited_at, deleted, from_slack, outbound_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        row.id,
        row.chatKey,
        row.slackTs,
        row.threadTs ?? null,
        row.channel ?? null,
        row.editedAt ?? null,
        row.fromSlack ? 1 : 0,
        row.outboundId ?? null,
      );
  }

  setEdited(id: string, editedAt: string): void {
    this.#db.prepare("UPDATE messages SET edited_at = ? WHERE id = ?").run(editedAt, id);
  }

  setDeleted(id: string): void {
    this.#db.prepare("UPDATE messages SET deleted = 1 WHERE id = ?").run(id);
  }

  forgetMessage(id: string): void {
    this.#db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }

  /** Newest row wins: a sent message can map to both its pending ID and its final ID. */
  messageIdForSlackTs(chatKey: string, slackTs: string): string | null {
    const row = this.#db
      .prepare(
        "SELECT id FROM messages WHERE chat_key = ? AND slack_ts = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(chatKey, slackTs) as { id: string } | undefined;
    return row?.id ?? null;
  }

  addOutbound(row: {
    chatKey: string;
    pendingId: string;
    echoHash: string;
    channel: string;
    slackTs: string;
    now: number;
    sendChatKey?: string;
  }): void {
    this.#db
      .prepare(
        "INSERT INTO outbound (chat_key, pending_id, echo_hash, channel, slack_ts, created_at, send_chat_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.chatKey,
        row.pendingId,
        row.echoHash,
        row.channel,
        row.slackTs,
        row.now,
        row.sendChatKey ?? row.chatKey,
      );
  }

  findOutbound(chatKey: string, messageId: string): OutboundRow | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM outbound WHERE chat_key = ? AND (pending_id = ? OR message_id = ?) LIMIT 1`,
      )
      .get(chatKey, messageId, messageId) as unknown as OutboundRow | undefined;
    return row ?? null;
  }

  unresolvedOutbound(chatKey: string): OutboundRow[] {
    return this.#db
      .prepare("SELECT * FROM outbound WHERE chat_key = ? AND message_id IS NULL ORDER BY id")
      .all(chatKey) as unknown as OutboundRow[];
  }

  setOutboundMessageId(id: number, messageId: string): void {
    this.#db.prepare("UPDATE outbound SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  outboundById(id: number): OutboundRow | null {
    return (
      (this.#db.prepare("SELECT * FROM outbound WHERE id = ?").get(id) as unknown as
        | OutboundRow
        | undefined) ?? null
    );
  }

  outboundBySlackTs(slackTs: string): OutboundRow | null {
    return (
      (this.#db
        .prepare("SELECT * FROM outbound WHERE slack_ts = ? LIMIT 1")
        .get(slackTs) as unknown as OutboundRow | undefined) ?? null
    );
  }

  setOutboundConfirmed(id: number): void {
    this.#db.prepare("UPDATE outbound SET confirmed = 1 WHERE id = ?").run(id);
  }

  /** Returns false if this Slack message was already claimed, so a redelivered event can't send twice. */
  claimSlackEvent(key: string, now: number): boolean {
    return (
      Number(
        this.#db
          .prepare("INSERT OR IGNORE INTO slack_events (key, created_at) VALUES (?, ?)")
          .run(key, now).changes,
      ) === 1
    );
  }

  prune(before: number): void {
    this.#db.prepare("DELETE FROM outbound WHERE created_at < ?").run(before);
    this.#db.prepare("DELETE FROM slack_events WHERE created_at < ?").run(before);
  }

  close(): void {
    this.#db.close();
  }
}
