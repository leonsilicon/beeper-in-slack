#!/usr/bin/env node
// Run on the computer running Beeper Desktop. Asks Beeper Desktop for a token, which you approve inside the
// app, then saves it as BEEPER_ACCESS_TOKEN in the env file (`.env`, or ENV_FILE). The token is never printed.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const BASE = process.env.BEEPER_BASE_URL ?? "http://127.0.0.1:23373";
const ENV_PATH = process.env.ENV_FILE ?? ".env";
const REDIRECT = "http://127.0.0.1:53682/callback";
const SCOPE = "read write";
const WAIT_MS = 60 * 60_000;

const json = { "Content-Type": "application/json" };
const say = (message) => console.log(`${new Date().toISOString()} ${message}`);

const registered = await fetch(`${BASE}/oauth/register`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({
    client_name: "Beeper in Slack",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  }),
});
if (!registered.ok) throw new Error(`Registering the client returned ${registered.status}`);
const client = await registered.json();

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(8).toString("hex");

// Beeper drops an unanswered prompt after about 2 minutes, so keep a fresh one waiting until someone answers.
const deadline = Date.now() + WAIT_MS;
let result;
while (true) {
  say("Waiting for approval in Beeper Desktop");
  const approval = await fetch(`${BASE}/oauth/authorize/callback`, {
    method: "POST",
    headers: json,
    signal: AbortSignal.timeout(WAIT_MS),
    body: JSON.stringify({
      mode: "oauth2",
      clientInfo: { name: "Beeper in Slack", clientURI: null, clientID: client.client_id },
      scopes: SCOPE.split(" "),
      redirectUri: REDIRECT,
      scope: SCOPE,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  result = await approval.json();
  if (result.code) break;
  const reason = typeof result.error === "object" ? result.error?.message : result.error;
  if (reason !== "server_error" || Date.now() > deadline) {
    say(`Not approved: ${reason}`);
    process.exit(1);
  }
}
if (result.state && result.state !== state)
  throw new Error("State mismatch in the approval response");

const exchanged = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: result.code,
    code_verifier: verifier,
    client_id: client.client_id,
  }),
});
if (!exchanged.ok) throw new Error(`Exchanging the code returned ${exchanged.status}`);
const { access_token: token, scope } = await exchanged.json();
if (!token) throw new Error("The token response had no access token");

const check = await fetch(`${BASE}/v1/accounts`, { headers: { Authorization: `Bearer ${token}` } });
if (!check.ok) throw new Error(`The new token was rejected with ${check.status}`);

const lines = (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "")
  .split("\n")
  .filter((line) => !line.startsWith("BEEPER_ACCESS_TOKEN=") && line !== "");
writeFileSync(`${ENV_PATH}.tmp`, `${lines.join("\n")}\nBEEPER_ACCESS_TOKEN=${token}\n`, {
  mode: 0o600,
});
renameSync(`${ENV_PATH}.tmp`, ENV_PATH);
say(`Token saved (scope: ${scope ?? SCOPE})`);
