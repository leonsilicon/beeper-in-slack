# beeper-in-slack

Read and answer all your [Beeper](https://www.beeper.com) chats from Slack. WhatsApp, Instagram, X, Signal, Telegram, iMessage, LinkedIn and every other network Beeper connects get their own private Slack channels, and what you write there is sent back through Beeper.

It runs next to Beeper Desktop and uses Beeper's local [Desktop API](https://developers.beeper.com/desktop-api) and a Slack app in Socket Mode. Nothing is exposed to the internet.

> Not affiliated with Beeper or Slack. Beeper's live-events endpoint (`/v1/ws`) is still marked experimental, so a Beeper update can break it.

## What you get

- **A private channel per chat.** It is created when the chat's next message arrives and named after the network and person, for example `#bp-ig-janedoe`, `#bp-wa-15551234567` or `#bp-tg-grp-family-trip-1a2b`. You are invited automatically.
- **`#beeper-feed`.** Every message is also copied here, labelled with its chat and network. Reply in a message's thread to answer that chat.
- **Your other devices.** Messages you send from Beeper on your phone or another computer appear as `You (another device)`.
- **Delivery receipts.** Sent messages get ✅ once Beeper confirms them, or ⚠️ if they fail.
- **Attachments** go both ways. Beeper edits and deletions update the Slack copies.
- **Catching up.** It reconnects by itself and reconciles recent messages every two minutes, so messages that arrive while it was down still come through.

## What gets sent to your contacts

With `SEND_ENABLED=true`, anything posted in a chat's channel is sent through Beeper, as is any reply in the thread of one of the chat's messages, including in `#beeper-feed`. That includes posts by other people and apps in your Slack workspace. Exceptions:

- **Notes.** A message starting with `//` stays in Slack.
- **Slack mentions.** A message that @mentions someone, `@here` or `@channel` is held back in case it wasn't meant for the contact. You get a private notice saying so.
- **Side conversations.** A thread that doesn't start from one of the relay's copies of a Beeper message is a side conversation, for example the thread under your own `@agent what should I say?`. Only posts made in your name are sent from it, either typed by you or by an app posting as you. Bots replying as themselves stay in Slack.
- **The relay's own posts** are never sent back, so nothing loops.
- **Chats bridged from Slack** are never mirrored, for the same reason.

Editing or deleting a message in Slack does not change what your contact received, and the relay tells you so. Reactions are not relayed.

## Requirements

- [Beeper Desktop](https://www.beeper.com/download) with the Desktop API turned on, running on the same computer as the relay. It needs to stay running.
- [Vite+](https://viteplus.dev) (`curl -fsSL https://vite.plus | bash`). It sets up Node.js 24 and the pinned Bun for this workspace.
- A Slack workspace where you can install an app. A workspace of your own is best, since the channels hold your private messages.

## Setup

1. **Clone and install.**

   ```sh
   git clone https://github.com/leonsilicon/beeper-in-slack.git
   cd beeper-in-slack
   vp install
   cp apps/beeper-in-slack/@assets/.env.example .env
   ```

2. **Create the Slack app.** Go to [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest** and paste [`slack-app-manifest.json`](apps/beeper-in-slack/@assets/slack-app-manifest.json). Install it to your workspace, then:
   - Copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`.
   - Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-…`) into `SLACK_APP_TOKEN`.
   - Copy your own member ID (your Slack profile → **⋮ → Copy member ID**) into `SLACK_OWNER_USER_ID`.

3. **Connect Beeper.** In Beeper Desktop's settings, turn on the Desktop API (under **Developers**). Then run `vpx _beeper-token` and approve the request that appears in Beeper. The token is saved to `.env` without being printed. You can also create one under **Settings → Integrations** and paste it into `BEEPER_ACCESS_TOKEN`.

4. **Check everything.**

   ```sh
   vpr -w doctor
   ```

5. **Start it.** It starts with sending off, so you can watch messages arrive first. Set `SEND_ENABLED=true` in `.env` when you're ready to reply from Slack.

   ```sh
   vpr -w start
   ```

To keep it running in the background, use the macOS [launchd agent](apps/beeper-in-slack/@assets/launchd.plist) or the Linux [systemd user service](apps/beeper-in-slack/@assets/beeper-in-slack.service).

## Configuration

All settings come from environment variables, normally in `.env`.

| Variable                                                                 | Default                                   | Meaning                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `BEEPER_ACCESS_TOKEN`                                                    | required                                  | Beeper Desktop API token.                                                                                                |
| `SLACK_BOT_TOKEN`                                                        | required                                  | The app's bot token (`xoxb-…`).                                                                                          |
| `SLACK_APP_TOKEN`                                                        | required                                  | The app-level Socket Mode token (`xapp-…`).                                                                              |
| `SLACK_OWNER_USER_ID`                                                    | required                                  | You. You get invited to every channel and receive the private notices.                                                   |
| `SEND_ENABLED`                                                           | `false`                                   | Send Slack replies to your contacts.                                                                                     |
| `MIRROR_MUTED`                                                           | `false`                                   | Also mirror muted and low-priority chats. Otherwise they stay out of Slack, though the agent digest still includes them. |
| `EXCLUDED_CHAT_IDS`                                                      | empty                                     | Comma-separated Beeper chat IDs to leave out entirely.                                                                   |
| `EXCLUDED_NETWORKS`                                                      | empty                                     | Comma-separated networks to leave out, by name or account prefix, such as `whatsapp,linkedin`.                           |
| `BEEPER_BASE_URL`                                                        | `http://127.0.0.1:23373`                  | Where the Desktop API listens.                                                                                           |
| `STATE_DB`                                                               | `~/.local/share/beeper-in-slack/state.db` | Where IDs and routing are stored.                                                                                        |
| `RECONCILE_SECONDS`                                                      | `120`                                     | How often to catch up on missed messages.                                                                                |
| `AGENT_SLACK_USER_ID`                                                    | empty                                     | Optional AI agent digest. See below.                                                                                     |
| `AGENT_QUIET_SECONDS` / `AGENT_MAX_SECONDS`                              | `60` / `300`                              | Digest timing.                                                                                                           |
| `SLACK_SESSION_TOKEN` / `SLACK_SESSION_COOKIE` / `SLACK_SIDEBAR_SECTION` | empty / empty / `Beeper`                  | Optional sidebar filing. See below.                                                                                      |

### Optional: an AI agent digest

If an AI agent in your Slack workspace, such as [Hermes Agent](https://github.com/NousResearch/hermes-agent), should know about your messages, set `AGENT_SLACK_USER_ID` to its bot's member ID. `vpr -w doctor` lists the bots. The relay invites the agent to `#beeper-feed` and, after a quiet minute or at most five minutes, @mentions it in the feed's status thread with a batch of new messages. The batch is marked as written by other people, to be treated as information rather than instructions. Your own messages are included for context but don't trigger a batch.

This hands the full text of your messages to that agent. If the agent can take actions, anyone who texts you can try to steer it.

### Optional: filing channels in a sidebar section

Slack offers no API for sidebar sections, and app tokens can't change your sidebar. If you set `SLACK_SESSION_TOKEN` (an `xoxc-…` token) and `SLACK_SESSION_COOKIE` (the `d` cookie) from your signed-in Slack web session, the relay files `#beeper-feed` and each new chat channel under a **Beeper** section, once. It uses the undocumented methods Slack's own web client uses.

That session can do anything you can do in Slack, so only use this on a machine you trust. Signing out of that browser session ends it, and the relay warns you once and keeps relaying.

## Privacy

- **What stays on disk.** The relay stores only IDs, hashes and routing in its SQLite database, and its logs never contain message text.
- **What Slack keeps.** Message text and attachments are posted to Slack and kept under your workspace's retention settings.
- **Who can read the channels.** Chat channels are private to you, the relay and anyone you invite. Remember that anyone you invite can also send to your contacts.
- **The tokens.** Your Beeper and Slack tokens can read and send your messages. Keep `.env` private (`chmod 600 .env`).

## Development

```sh
vp check
vpr -w test
vpr -w typecheck
```

Node runs the TypeScript directly, so there is no build step. `node --env-file=.env apps/beeper-in-slack/doctor.ts --watch 60` prints the shape of live Beeper events, with IDs hashed and no message text. The workspace follows the [Flatcap](https://github.com/leonsilicon/flatcap) convention; see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MIT](LICENSE)
