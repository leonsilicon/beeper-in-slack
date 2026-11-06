import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  beeperBaseUrl: string;
  beeperToken: string;
  slackBotToken: string;
  slackAppToken: string;
  ownerUserId: string;
  agentUserId: string | null;
  sendEnabled: boolean;
  mirrorMuted: boolean;
  excludedChatIds: Set<string>;
  excludedNetworks: Set<string>;
  stateDb: string;
  reconcileSeconds: number;
  agentQuietSeconds: number;
  agentMaxSeconds: number;
  /** Set only when the owner's Slack session is configured, since sections can't be changed otherwise. */
  sidebar: { token: string; cookie: string; sectionName: string } | null;
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = [
    "BEEPER_ACCESS_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_OWNER_USER_ID",
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing settings: ${missing.join(", ")}`);

  return {
    beeperBaseUrl: env.BEEPER_BASE_URL ?? "http://127.0.0.1:23373",
    beeperToken: env.BEEPER_ACCESS_TOKEN!,
    slackBotToken: env.SLACK_BOT_TOKEN!,
    slackAppToken: env.SLACK_APP_TOKEN!,
    ownerUserId: env.SLACK_OWNER_USER_ID!,
    agentUserId: env.AGENT_SLACK_USER_ID || null,
    // Sending to real contacts stays off until it is explicitly turned on.
    sendEnabled: env.SEND_ENABLED === "true",
    mirrorMuted: env.MIRROR_MUTED === "true",
    excludedChatIds: new Set(list(env.EXCLUDED_CHAT_IDS)),
    excludedNetworks: new Set(list(env.EXCLUDED_NETWORKS).map((name) => name.toLowerCase())),
    stateDb: env.STATE_DB ?? join(homedir(), ".local/share/beeper-in-slack/state.db"),
    reconcileSeconds: Number(env.RECONCILE_SECONDS ?? 120),
    agentQuietSeconds: Number(env.AGENT_QUIET_SECONDS ?? 60),
    agentMaxSeconds: Number(env.AGENT_MAX_SECONDS ?? 300),
    sidebar:
      env.SLACK_SESSION_TOKEN && env.SLACK_SESSION_COOKIE
        ? {
            token: env.SLACK_SESSION_TOKEN,
            cookie: env.SLACK_SESSION_COOKIE,
            sectionName: env.SLACK_SIDEBAR_SECTION || "Beeper",
          }
        : null,
  };
}
