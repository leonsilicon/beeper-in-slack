import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Imports run before config is read, so reaching the settings check proves every module loads under real Node ESM.
test("the service loads all its modules and then refuses to start without settings", () => {
  const result = spawnSync(process.execPath, ["bin/start.ts"], {
    env: {},
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Missing settings: BEEPER_ACCESS_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID/,
  );
});

test("the doctor loads and reports missing tokens without crashing", () => {
  const result = spawnSync(process.execPath, ["bin/doctor.ts"], {
    env: { BEEPER_BASE_URL: "http://127.0.0.1:1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAIL BEEPER_ACCESS_TOKEN is set/);
  assert.match(result.stdout, /FAIL SLACK_BOT_TOKEN is set/);
});
