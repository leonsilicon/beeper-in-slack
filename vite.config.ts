import { defineConfig } from "vite-plus";
import flatcap from "eslint-plugin-flatcap";

const relay = "packages/com/leonsilicon/beeper-in-slack/relay";

export default defineConfig({
  lint: {
    ...flatcap.configs.oxlint,
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // node:test registers top-level tests through promises managed by its runner.
        files: ["**/__tests__/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
    ],
  },
  run: {
    tasks: {
      start: {
        cache: false,
        command: "node --env-file-if-exists=.env apps/beeper-in-slack/main.ts",
      },
      doctor: {
        cache: false,
        command: "node --env-file-if-exists=.env apps/beeper-in-slack/doctor.ts",
      },
      test: { cache: false, command: `node --test ${relay}/__tests__/*.test.ts` },
      typecheck: { command: "tsc --noEmit" },
    },
  },
});
