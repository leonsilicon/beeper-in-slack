import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { BeeperClient, BeeperStream } from "#beeper";
import type { BeeperEvent } from "#types";

const quiet = () => {};

async function fakeBeeper(
  handler: (req: IncomingMessage, body: string) => { status?: number; json?: unknown },
) {
  const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const { status = 200, json = {} } = handler(req, body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("send encodes the chat ID, sends the token, and returns the pending ID", async () => {
  const fake = await fakeBeeper(() => ({ json: { chatID: "c", pendingMessageID: "p1" } }));
  const client = new BeeperClient(fake.base, "secret");
  const result = await client.send("!abc:beeper.com", { text: "hi", replyToMessageID: "m1" });
  assert.equal(result.pendingMessageID, "p1");
  assert.equal(fake.seen[0].method, "POST");
  assert.equal(fake.seen[0].url, "/v1/chats/!abc%3Abeeper.com/messages");
  assert.equal(fake.seen[0].auth, "Bearer secret");
  assert.deepEqual(JSON.parse(fake.seen[0].body), { text: "hi", replyToMessageID: "m1" });
  await fake.close();
});

test("an error response becomes an exception that never contains the token", async () => {
  const fake = await fakeBeeper(() => ({ status: 401 }));
  const client = new BeeperClient(fake.base, "secret");
  await assert.rejects(
    client.chat("c"),
    (error: Error) => /401/.test(error.message) && !error.message.includes("secret"),
  );
  await fake.close();
});

test("search follows pages backwards, includes muted and low-priority chats, and returns oldest first", async () => {
  let page = 0;
  const fake = await fakeBeeper(() => {
    page++;
    if (page === 1)
      return {
        json: {
          items: [{ id: "new", timestamp: "2026-11-05T12:00:03Z" }],
          hasMore: true,
          oldestCursor: "cur1",
        },
      };
    return { json: { items: [{ id: "old", timestamp: "2026-11-05T12:00:01Z" }], hasMore: false } };
  });
  const result = await new BeeperClient(fake.base, "t").searchSince("2026-11-05T00:00:00.000Z");
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["old", "new"],
  );
  assert.equal(result.truncated, false);
  const first = new URL(fake.seen[0].url, fake.base).searchParams;
  assert.equal(first.get("excludeLowPriority"), "false");
  assert.equal(first.get("includeMuted"), "true");
  assert.equal(first.get("dateAfter"), "2026-11-05T00:00:00.000Z");
  const second = new URL(fake.seen[1].url, fake.base).searchParams;
  assert.equal(second.get("cursor"), "cur1");
  assert.equal(second.get("direction"), "before");
  await fake.close();
});

test("search reports when it stops early rather than silently dropping messages", async () => {
  const fake = await fakeBeeper(() => ({
    json: {
      items: [{ id: "x", timestamp: "2026-11-05T12:00:00Z" }],
      hasMore: true,
      oldestCursor: "more",
    },
  }));
  const result = await new BeeperClient(fake.base, "t").searchSince("2026-11-05T00:00:00.000Z");
  assert.equal(result.truncated, true);
  await fake.close();
});

test("a missing downloaded file is an error, and file URLs become paths", async () => {
  let reply: unknown = { error: "gone" };
  const fake = await fakeBeeper(() => ({ json: reply }));
  const client = new BeeperClient(fake.base, "t");
  await assert.rejects(client.downloadAsset("mxc://a/b"), /gone/);
  reply = { srcURL: "file:///tmp/my%20photo.jpg" };
  assert.equal(await client.downloadAsset("mxc://a/b"), "/tmp/my photo.jpg");
  await fake.close();
});

test("the stream authenticates, subscribes after ready, forwards events and reconnects", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: "/v1/ws" });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const auths: Array<string | undefined> = [];
  const subscriptions: unknown[] = [];
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket, req) => {
    auths.push(req.headers.authorization);
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      subscriptions.push(message);
      socket.send(
        JSON.stringify({
          type: "subscriptions.updated",
          requestID: message.requestID,
          chatIDs: message.chatIDs,
        }),
      );
    });
    socket.send(JSON.stringify({ type: "ready", version: 1, chatIDs: [] }));
  });

  const stream = new BeeperStream(base, "secret", quiet);
  const events: BeeperEvent[] = [];
  const states: string[] = [];
  stream.on("event", (event) => events.push(event));
  stream.on("appState", (state) => states.push(state));
  const firstConnect = once(stream, "connected");
  stream.start();
  await firstConnect;

  assert.equal(auths[0], "Bearer secret");
  assert.deepEqual(subscriptions[0], {
    type: "subscriptions.set",
    requestID: "relay",
    chatIDs: ["*"],
    app: { state: true },
  });

  const received = once(stream, "event");
  sockets[0].send("not json");
  sockets[0].send(
    JSON.stringify({
      type: "app.state.updated",
      seq: 1,
      ts: "",
      appState: { state: "needs-login" },
    }),
  );
  sockets[0].send(
    JSON.stringify({ type: "message.upserted", seq: 2, ts: "", chatID: "c", ids: ["m"] }),
  );
  await received;
  assert.equal(events[0].type, "message.upserted");
  assert.deepEqual(states, ["needs-login"]);

  const reconnected = once(stream, "connected");
  const dropped = once(stream, "disconnected");
  sockets[0].terminate();
  await dropped;
  await reconnected;
  assert.equal(sockets.length, 2);

  stream.stop();
  for (const socket of sockets) socket.terminate();
  wss.close();
  await new Promise((resolve) => http.close(resolve));
});
