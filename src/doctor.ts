// Read-only checks. Run with `--watch <seconds>` to print the shape of live events, without any message text.
import WebSocket from "ws";
import { BeeperClient } from "#beeper";
import { isRealPerson, shortHash, threadLabel } from "#format";
import { SlackSidebar } from "#sidebar";
import { SlackGateway } from "#slack";

export async function runDoctor(): Promise<void> {
  const env = process.env;
  const baseUrl = env.BEEPER_BASE_URL ?? "http://127.0.0.1:23373";
  const report = (ok: boolean, label: string, detail = ""): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  };
  const attempt = async (label: string, check: () => Promise<string | void>): Promise<void> => {
    try {
      report(true, label, (await check()) ?? "");
    } catch (error) {
      report(false, label, (error as Error).message);
    }
  };

  await attempt("Beeper API is running", async () => {
    const response = await fetch(new URL("/v1/info", baseUrl));
    const info = (await response.json()) as { app: { version: string } };
    return `version ${info.app.version}`;
  });

  if (env.BEEPER_ACCESS_TOKEN) {
    const beeper = new BeeperClient(baseUrl, env.BEEPER_ACCESS_TOKEN);
    await attempt("Beeper token works", async () => {
      const accounts =
        await beeper.request<Array<{ network?: string; status?: string }>>("/v1/accounts");
      return accounts
        .map((account) => `${account.network ?? "unknown"} (${account.status ?? "?"})`)
        .join(", ");
    });
  } else report(false, "BEEPER_ACCESS_TOKEN is set");

  if (env.SLACK_BOT_TOKEN) {
    const { web } = new SlackGateway(env.SLACK_BOT_TOKEN);
    await attempt("Slack bot token works", async () => {
      const auth = await web.auth.test();
      return `@${auth.user} in ${auth.team}`;
    });
    await attempt("Slack owner", async () => {
      if (!env.SLACK_OWNER_USER_ID) throw new Error("SLACK_OWNER_USER_ID is not set");
      const { user } = await web.users.info({ user: env.SLACK_OWNER_USER_ID });
      return user?.real_name ?? user?.name ?? "unknown";
    });
    // Candidates for AGENT_SLACK_USER_ID, the optional agent that receives message digests.
    await attempt("Bot users", async () => {
      const { members = [] } = await web.users.list({});
      const bots = members.filter((member) => member.is_bot && !member.deleted);
      return (
        bots.map((bot) => `${bot.real_name} @${bot.name} ${bot.id}`).join(", ") || "none found"
      );
    });
  } else report(false, "SLACK_BOT_TOKEN is set");
  report(Boolean(env.SLACK_APP_TOKEN?.startsWith("xapp-")), "SLACK_APP_TOKEN looks right");

  if (env.SLACK_SESSION_TOKEN && env.SLACK_SESSION_COOKIE) {
    const name = env.SLACK_SIDEBAR_SECTION || "Beeper";
    const sidebar = new SlackSidebar({
      token: env.SLACK_SESSION_TOKEN,
      cookie: env.SLACK_SESSION_COOKIE,
      sectionName: name,
    });
    await attempt("Slack session can sort the sidebar", async () => {
      const section = (await sidebar.sections()).find(
        (candidate) => candidate.type === "standard" && candidate.name === name,
      );
      return section
        ? `"${name}" holds ${section.channel_ids_page?.channel_ids?.length ?? 0} channels`
        : `"${name}" will be created for the next channel`;
    });
  } else
    console.log(`skip Sidebar sorting is off without SLACK_SESSION_TOKEN and SLACK_SESSION_COOKIE`);

  const threadsFlag = process.argv.indexOf("--threads");
  if (threadsFlag !== -1 && env.BEEPER_ACCESS_TOKEN) {
    // A preview only. Labels are masked, because they contain usernames and phone numbers.
    const days = Number(process.argv[threadsFlag + 1] ?? 7);
    const chats = await new BeeperClient(baseUrl, env.BEEPER_ACCESS_TOKEN).listChats();
    const people = chats.filter(isRealPerson);
    const recent = people.filter(
      (chat) => Date.parse(chat.lastActivity ?? "") >= Date.now() - days * 86_400_000,
    );
    const tally = (list: typeof chats): string => {
      const counts: Record<string, number> = {};
      for (const chat of list) {
        const code = threadLabel(chat).split("-")[1];
        counts[code] = (counts[code] ?? 0) + 1;
      }
      return JSON.stringify(counts);
    };
    const labels = people.map(threadLabel);
    const mask = (label: string): string => {
      const [bp, code, ...rest] = label.split("-");
      const id = rest.join("-");
      return `${bp}-${code}-${id.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(id.length - 2, 6)))}`;
    };
    console.log(`\nreal people: ${people.length} ${tally(people)}`);
    console.log(`active in the last ${days} days: ${recent.length} ${tally(recent)}`);
    console.log(`people sharing a label: ${labels.length - new Set(labels).size}`);
    console.log(
      `sample: ${recent
        .slice(0, 8)
        .map((chat) => mask(threadLabel(chat)))
        .join(", ")}`,
    );
  }

  const watchFlag = process.argv.indexOf("--watch");
  if (watchFlag !== -1 && env.BEEPER_ACCESS_TOKEN) {
    const seconds = Number(process.argv[watchFlag + 1] ?? 60);
    console.log(
      `\nWatching events for ${seconds}s. Chat and message IDs are hashed and no text is printed.`,
    );
    const url = new URL("/v1/ws", baseUrl);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${env.BEEPER_ACCESS_TOKEN}` },
    });
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "ready")
        socket.send(
          JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"], app: { state: true } }),
        );
      const entries = (event.entries ?? []).map((entry: Record<string, unknown>) => ({
        id: shortHash(String(entry.id)),
        type: entry.type,
        isSender: entry.isSender,
        isUnread: entry.isUnread,
        edited: Boolean(entry.editedTimestamp),
        status: (entry.sendStatus as { status?: string } | undefined)?.status,
        attachments: (entry.attachments as unknown[] | undefined)?.length ?? 0,
        reactions: (entry.reactions as unknown[] | undefined)?.length ?? 0,
        fields: Object.keys(entry).length,
      }));
      console.log(
        JSON.stringify({
          type: event.type,
          chat: event.chatID ? shortHash(event.chatID) : undefined,
          ids: event.ids?.length,
          entries,
        }),
      );
    });
    socket.on("error", (error) => report(false, "Beeper stream", error.message));
    setTimeout(() => {
      socket.close();
      process.exit(0);
    }, seconds * 1000);
  }
}
