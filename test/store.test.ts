import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "#store";

test("deployed per-channel mappings migrate safely and shared thread routes survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "beeper-store-"));
  const path = join(directory, "state.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE chats (key TEXT PRIMARY KEY, channel TEXT UNIQUE, title TEXT NOT NULL,
        network TEXT NOT NULL, invited INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, slack_ts TEXT, thread_ts TEXT,
        edited_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, from_slack INTEGER NOT NULL DEFAULT 0);
      INSERT INTO chats VALUES ('alice', 'C_OLD', 'Alice', 'WhatsApp', 1, 0);
      INSERT INTO messages VALUES ('message1', 'alice', '123.4', NULL, NULL, 0, 0);
    `);
    legacy.close();
    let store = new Store(path);
    assert.equal(store.chat("alice")!.channel, "C_OLD");
    assert.equal(store.message("message1")!.channel, "C_OLD");
    store.saveChat("alice", "C_FEED", "Alice", "WhatsApp", "200.1");
    store.saveChat("bob", "C_FEED", "Bob", "Signal", "200.2");
    store.setPersonalChannel("alice", "C_PERSON");
    store.saveMirror("beeper:message1", "C_PERSON", "300.1", undefined, "alice");
    store.saveChat("alice", "C_FEED", "Alice renamed", "WhatsApp", "200.1");
    store.addOutbound({
      chatKey: "alice",
      pendingId: "pending-1",
      echoHash: "legacy-hash",
      channel: "C_PERSON",
      slackTs: "500.1",
      now: Date.now(),
      sendChatKey: "member",
    });
    const outbound = store.findOutbound("alice", "pending-1")!;
    store.setOutboundMessageId(outbound.id, "final-1");
    store.close();
    store = new Store(path);
    assert.equal(store.chatByThread("C_FEED", "200.1")!.key, "alice");
    assert.equal(store.chatByThread("C_FEED", "200.2")!.key, "bob");
    assert.equal(store.chatByThread("C_FEED", "unmapped"), null);
    assert.equal(store.message("message1")!.channel, "C_OLD");
    assert.equal(store.chatByPersonalChannel("C_PERSON")!.key, "alice");
    assert.equal(store.mirrors("beeper:message1")[0].slack_ts, "300.1");
    assert.equal(store.chatForSlackMessage("C_PERSON", "300.1")!.key, "alice");
    assert.equal(store.chatForSlackMessage("C_OLD", "123.4")!.key, "alice");
    assert.equal(store.chatForSlackMessage("C_FEED", "300.1"), null);
    assert.equal(store.findOutbound("alice", "final-1")!.send_chat_key, "member");
    assert.equal(
      store.findOutbound("alice", "pending-1")!.id,
      store.findOutbound("alice", "final-1")!.id,
    );
    assert.equal(store.findOutbound("alice", "native-same-text"), null);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
