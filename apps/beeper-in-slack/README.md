# @-apps/beeper-in-slack

The runnable application: entrypoints, the Beeper token helper, and the files you copy when setting up.

| File                              | Purpose                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`                         | Starts the relay. Run it with `vpr -w start`.                                                                                     |
| `doctor.ts`                       | Read-only connection checks. Run it with `vpr -w doctor`.                                                                         |
| `_beeper-token.mjs`               | Asks Beeper Desktop for an API token and saves it to `.env` (or `ENV_FILE`) without printing it. Run it with `vpx _beeper-token`. |
| `@assets/.env.example`            | Every setting, to copy to `.env` at the repository root.                                                                          |
| `@assets/slack-app-manifest.json` | The Slack app to create at api.slack.com/apps.                                                                                    |
| `@assets/launchd.plist`           | macOS background service.                                                                                                         |
| `@assets/beeper-in-slack.service` | Linux systemd user service.                                                                                                       |

The relay itself is `@-/com.leonsilicon.beeper-in-slack.relay`.
