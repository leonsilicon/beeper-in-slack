# Development

This workspace follows the [Flatcap convention](https://github.com/leonsilicon/flatcap) and uses [Vite+](https://viteplus.dev) for installs, checks and tasks.

## Workspace layout

| Location                                          | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `apps/beeper-in-slack/`                           | Node entrypoints, the Beeper token helper, and setup assets |
| `packages/com/leonsilicon/beeper-in-slack/relay/` | Relay implementation and its tests                          |
| `packages/com/npmjs/`                             | Wrappers for upstream runtime dependencies                  |

Applications use `@-apps/<folder>`. Package names mirror their path beneath `packages/`, joined with dots: `packages/com/leonsilicon/beeper-in-slack/relay` is `@-/com.leonsilicon.beeper-in-slack.relay`.

## Package conventions

- Read the owning package's README before editing it, and update its API documentation when behavior changes. Every package README starts with the exact package name.
- Keep implementation files beside `package.json`. Use `@assets/` or `@fixtures/` for owned data and `__tests__/` for tests. A normal child directory is another package.
- Export public APIs through `+.ts` or `+server.ts`. Those entrypoints contain only explicit re-exports through local `#` imports.
- Define local `#` aliases in `package.json#imports`. Relative imports are not allowed outside tests. Import other packages by their workspace name, with `workspace:*` for workspace dependencies and the root catalog for external ones.
- Upstream npm packages are consumed through wrappers in `packages/com/npmjs/` (for example `@-/com.npmjs.slack__web-api`), so each dependency is declared once.
- Use `_` package segments for internal packages and `__` segments for parent-only packages.
- Register executable `_command` files in `package.json#bin`, with a shebang and executable permission. Double-underscore files are local scripts without a workspace binary.
- Keep root task definitions in `vite.config.ts`. The `eslint-plugin-flatcap` Oxlint preset validates layout, manifests, imports and package boundaries during `vp check`.

## Commands

Use Node 24+, Bun 1.4.4 (the `packageManager`), and Vite+ 1.5.0.

```sh
vp install        # dependencies, from the committed bun.lock
vp check          # format, lint (including Flatcap rules) and type-aware checks
vpr -w test       # node:test suite
vpr -w typecheck  # tsc --noEmit
vpr -w start      # run the relay with .env
vpr -w doctor     # read-only connection checks
```

The tests need no Beeper or Slack credentials. CI runs `vp check`, the typecheck and the tests through `voidzero-dev/setup-vp`.
