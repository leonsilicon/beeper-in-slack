import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackSidebar, type SidebarSection } from "#sidebar";

interface Call {
  method: string;
  cookie: string | null;
  params: Record<string, string>;
}

function fakeSlack(sections: SidebarSection[], failWith?: string) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const params = Object.fromEntries(init!.body as URLSearchParams);
    calls.push({ method, cookie: new Headers(init!.headers).get("cookie"), params });
    const reply = (body: object) => new Response(JSON.stringify(body));
    if (failWith) return reply({ ok: false, error: failWith });
    if (method === "users.channelSections.list")
      return reply({ ok: true, channel_sections: sections });
    if (method === "users.channelSections.create") {
      sections.push({ channel_section_id: "LNEW", name: params.name, type: "standard" });
      return reply({ ok: true, channel_section_id: "LNEW" });
    }
    return reply({ ok: true });
  }) as typeof globalThis.fetch;
  const sidebar = new SlackSidebar({
    token: "xoxc-test",
    cookie: "xoxd-a%2Fb",
    sectionName: "Beeper",
    fetch,
  });
  return { sidebar, calls, sections };
}

const builtIn: SidebarSection = { channel_section_id: "LCH", name: "Channels", type: "channels" };

test("channels are added to the named section using the owner's session", async () => {
  const { sidebar, calls } = fakeSlack([
    builtIn,
    { channel_section_id: "LBP", name: "Beeper", type: "standard" },
  ]);
  await sidebar.place(["C1", "C2"]);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["users.channelSections.list", "users.channelSections.channels.bulkUpdate"],
  );
  assert.ok(
    calls.every((call) => call.cookie === "d=xoxd-a%2Fb" && call.params.token === "xoxc-test"),
  );
  assert.deepEqual(JSON.parse(calls[1].params.insert), [
    { channel_section_id: "LBP", channel_ids: ["C1", "C2"] },
  ]);
});

test("a missing section is created once, and a renamed one is still found by its ID", async () => {
  const { sidebar, calls, sections } = fakeSlack([builtIn]);
  await sidebar.place(["C1"]);
  assert.equal(calls.filter((call) => call.method === "users.channelSections.create").length, 1);
  sections.at(-1)!.name = "Chats";
  await sidebar.place(["C2"]);
  assert.equal(calls.filter((call) => call.method === "users.channelSections.create").length, 1);
  assert.deepEqual(JSON.parse(calls.at(-1)!.params.insert)[0].channel_section_id, "LNEW");
});

test("nothing is sent for an empty list", async () => {
  const { sidebar, calls } = fakeSlack([builtIn]);
  await sidebar.place([]);
  assert.equal(calls.length, 0);
});

test("Slack errors carry their code like the official client's, so callers can tell a sign-out", async () => {
  const { sidebar } = fakeSlack([], "invalid_auth");
  await assert.rejects(sidebar.place(["C1"]), (error: Error & { data?: { error?: string } }) => {
    assert.equal(error.data?.error, "invalid_auth");
    return true;
  });
});
