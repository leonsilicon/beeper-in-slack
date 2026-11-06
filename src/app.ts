import { SocketModeClient } from "@slack/socket-mode";
import { BeeperClient, BeeperStream } from "#beeper";
import { loadConfig } from "#config";
import { AgentFeed } from "#agent-feed";
import { log } from "#log";
import { Relay, type SlackMessageEvent } from "#relay";
import { SlackSidebar } from "#sidebar";
import { SlackGateway } from "#slack";
import { Store } from "#store";

export async function startRelay(): Promise<void> {
  const STREAM_DOWN_ALERT_MS = 5 * 60_000;

  const config = loadConfig();
  const store = new Store(config.stateDb);
  const beeper = new BeeperClient(config.beeperBaseUrl, config.beeperToken);
  const slack = new SlackGateway(config.slackBotToken);
  const feed = new AgentFeed({
    slack,
    agentUserId: config.agentUserId,
    quietMs: config.agentQuietSeconds * 1000,
    maxMs: config.agentMaxSeconds * 1000,
    log,
  });
  const relay = new Relay({
    beeper,
    slack,
    store,
    feed,
    log,
    sidebar: config.sidebar ? new SlackSidebar(config.sidebar) : null,
    ownerUserId: config.ownerUserId,
    agentUserId: config.agentUserId,
    sendEnabled: config.sendEnabled,
    mirrorMuted: config.mirrorMuted,
    excludedChatIds: config.excludedChatIds,
    excludedNetworks: config.excludedNetworks,
  });

  await relay.init();

  const stream = new BeeperStream(config.beeperBaseUrl, config.beeperToken, log);
  let downTimer: NodeJS.Timeout | null = null;
  let alerted = false;

  stream.on("event", (event) => void relay.onBeeperEvent(event));
  stream.on("connected", () => {
    if (downTimer) clearTimeout(downTimer);
    downTimer = null;
    if (alerted) void feed.alert("Reconnected to Beeper. Catching up on anything missed.");
    alerted = false;
    log("info", "beeper stream connected");
    void relay.reconcile();
  });
  stream.on("disconnected", () => {
    downTimer ??= setTimeout(() => {
      alerted = true;
      void feed.alert(
        "The relay has lost its connection to Beeper, so new messages are not reaching Slack. Is Beeper Desktop running on the same computer as the relay?",
      );
    }, STREAM_DOWN_ALERT_MS);
  });
  stream.on("appState", (state) => {
    if (state !== "ready")
      void feed.alert(`Beeper Desktop needs attention. Its state is "${state}".`);
  });

  const socket = new SocketModeClient({ appToken: config.slackAppToken });
  socket.on(
    "message",
    async ({ event, ack }: { event: SlackMessageEvent; ack: () => Promise<void> }) => {
      await ack();
      void relay.onSlackEvent(event);
    },
  );

  await socket.start();
  stream.start();
  void relay
    .relabelThreads()
    .catch((error: Error) =>
      log("warn", "could not update legacy feed headers", { error: error.message }),
    );
  const reconcileTimer = setInterval(() => void relay.reconcile(), config.reconcileSeconds * 1000);
  log("info", "relay started", {
    sendEnabled: config.sendEnabled,
    agent: Boolean(config.agentUserId),
    sidebar: Boolean(config.sidebar),
  });

  async function shutdown(): Promise<void> {
    clearInterval(reconcileTimer);
    stream.stop();
    await feed.flush();
    await socket.disconnect();
    store.close();
    process.exit(0);
  }
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
