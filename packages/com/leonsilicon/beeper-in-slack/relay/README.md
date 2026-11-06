# @-/com.leonsilicon.beeper-in-slack.relay

Beeper-to-Slack routing, persistence, startup, and diagnostics. The application in `apps/beeper-in-slack` owns launch and configuration files.

## Usage

```ts
import { startRelay } from "@-/com.leonsilicon.beeper-in-slack.relay";
await startRelay();
```

## API

- `startRelay()` reads settings from the process environment, starts the relay, and installs its shutdown handlers.
- `runDoctor()` runs the read-only connection checks using the process environment and CLI flags (`--watch <seconds>`, `--threads <days>`).

## Modules

| Module          | Role                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `app.ts`        | Wires the clients, the event streams and the reconcile timer together.      |
| `relay.ts`      | Routing: chat channels, the feed, echoes, sending rules and reconciliation. |
| `store.ts`      | SQLite mappings of IDs and hashes. No message text is stored.               |
| `beeper.ts`     | Beeper Desktop API client and its live-events WebSocket.                    |
| `slack.ts`      | Slack Web API gateway.                                                      |
| `sidebar.ts`    | Optional sidebar filing through the owner's Slack web session.              |
| `agent-feed.ts` | Optional batched digests for an AI agent.                                   |
| `format.ts`     | Channel names, labels, and conversion between Beeper and Slack text.        |
| `config.ts`     | Environment settings.                                                       |
| `doctor.ts`     | Connection checks.                                                          |

Implementation files use local `#` imports. Tests live in `__tests__/` and run with `vpr -w test`.
