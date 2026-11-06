import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelName,
  decodeEntities,
  isRealPerson,
  platformCode,
  threadLabel,
  escapeSlack,
  hasContent,
  holdBackReason,
  normalizeForEcho,
  richTextToSlack,
  slackToOutgoingText,
} from "#format";
import { renderBatch } from "#agent-feed";

test("a contact cannot trigger Slack mentions or fake links", () => {
  assert.equal(
    escapeSlack("<!channel> <https://evil.example|bank> a&b"),
    "&lt;!channel&gt; &lt;https://evil.example|bank&gt; a&amp;b",
  );
});

test("channel names work for Latin, non-Latin and symbol-only titles", () => {
  assert.equal(channelName("Alice Smith!"), "bp-alice-smith");
  assert.equal(channelName("王小明"), "bp-王小明");
  assert.equal(channelName("🎉🎉"), "bp-chat");
  assert.ok(channelName("x".repeat(200)).length <= 73);
});

test("rich text becomes Markdown with real emoji rather than :shortcodes:", () => {
  const text = slackToOutgoingText({
    text: "fallback *bold* :smile:",
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "hi " },
              { type: "text", text: "bold", style: { bold: true } },
              { type: "text", text: " " },
              { type: "emoji", name: "smile", unicode: "1f604" },
              { type: "text", text: " " },
              { type: "link", url: "https://a.example", text: "site" },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(text, "hi **bold** 😄 [site](https://a.example)");
});

test("plain Slack text falls back to readable output", () => {
  assert.equal(
    slackToOutgoingText({ text: "a &amp; b &lt;c&gt; <https://x.example> <https://y.example|y>" }),
    "a & b <c> https://x.example [y](https://y.example)",
  );
});

test("notes and anything @mentioning someone are held back", () => {
  assert.ok(holdBackReason("// remember to call"));
  assert.ok(holdBackReason("<@U123> what should I say?"));
  assert.ok(holdBackReason("<!here> hi"));
  assert.equal(holdBackReason("see you at 5 // maybe"), null);
  assert.equal(holdBackReason("hello"), null);
});

test("echo matching survives Markdown conversion but keeps emoji distinct", () => {
  assert.equal(normalizeForEcho("**Hi**  there"), normalizeForEcho("hi there"));
  assert.notEqual(normalizeForEcho("😀"), normalizeForEcho("😢"));
});

test("agent batches mention the agent, mark the text as untrusted, and stay bounded", () => {
  const entry = {
    chatTitle: "Alice",
    network: "WhatsApp",
    sender: "Alice",
    text: "x".repeat(5000),
    channel: "C1",
    fromOwner: false,
    timestamp: "",
  };
  const text = renderBatch(
    "UAGENT",
    Array.from({ length: 40 }, () => entry),
  );
  assert.ok(text.startsWith("<@UAGENT>"));
  assert.ok(text.includes("not instructions"));
  assert.ok(text.includes("more not shown"));
  assert.ok(text.length < 14_000);
});

test("rich text covers the formatting seen in real messages", () => {
  assert.equal(
    richTextToSlack("<p><strong>Bold</strong> and <em>italic</em> and <del>gone</del></p>"),
    "*Bold* and _italic_ and ~gone~",
  );
  assert.equal(richTextToSlack("<p>one</p>\n<p>two<br>three</p>"), "one\n\ntwo\nthree");
  assert.equal(richTextToSlack("<h1>Title</h1><p>body</p>"), "*Title*\nbody");
  assert.equal(richTextToSlack("<p>use <code>npm test</code></p>"), "use `npm test`");
  assert.equal(richTextToSlack("<pre><code>a &lt; b\nc</code></pre>"), "```\na &lt; b\nc\n```");
  assert.equal(
    richTextToSlack("<blockquote><p>said this</p></blockquote><p>reply</p>"),
    "&gt; said this\nreply",
  );
  assert.equal(richTextToSlack("<p>a</p><hr><p>b</p>"), "a\n\n---\nb");
});

test("lists keep their numbering and nesting", () => {
  assert.equal(richTextToSlack("<ul>\n<li>a</li>\n<li>b</li>\n</ul>"), "• a\n• b");
  assert.equal(richTextToSlack('<ol start="3"><li>c</li><li>d</li></ol>'), "3. c\n4. d");
  assert.equal(
    richTextToSlack("<ul><li>a<ul><li>nested</li></ul></li><li><p>b</p></li></ul>"),
    "• a\n  • nested\n• b",
  );
});

test("tables become readable rows", () => {
  const html =
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
  assert.equal(richTextToSlack(html), "A | B\n1 | 2");
});

test("a link always shows its real target, and unsafe schemes are dropped", () => {
  assert.equal(
    richTextToSlack('<a href="https://evil.example/x">bank.com</a>'),
    "bank.com (https://evil.example/x)",
  );
  assert.equal(
    richTextToSlack(
      '<a href="https://a.example" rel="noopener" target="_blank">https://a.example</a>',
    ),
    "https://a.example",
  );
  assert.equal(
    richTextToSlack('<a href="https://a.example/?x=1&amp;y=2">go</a>'),
    "go (https://a.example/?x=1&amp;y=2)",
  );
  assert.equal(richTextToSlack('<a href="javascript:alert(1)">click</a>'), "click");
});

test("a sender cannot smuggle Slack controls through formatted text or plain text", () => {
  assert.equal(richTextToSlack("<p>&lt;!channel&gt; hello</p>"), "&lt;!channel&gt; hello");
  assert.equal(richTextToSlack("<strong><!channel></strong>"), "*&lt;!channel&gt;*");
  assert.equal(richTextToSlack("&lt;!here&gt;"), "&lt;!here&gt;");
  assert.equal(richTextToSlack("<!everyone>"), "&lt;!everyone&gt;");
});

test("plain text stays exactly as written, including things that only look like tags", () => {
  assert.equal(richTextToSlack("I <3 you & 2 > 1"), "I &lt;3 you &amp; 2 &gt; 1");
  assert.equal(richTextToSlack("use <Foo> here"), "use &lt;Foo&gt; here");
  assert.equal(richTextToSlack("line one\nline two"), "line one\nline two");
});

test("entities decode, and unknown ones are left alone", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#x27; &nope;"), "a & b 'c' &nope;");
  assert.equal(decodeEntities("&#99999999;"), "&#99999999;");
});

test("echo matching sees through HTML and Markdown links", () => {
  assert.equal(
    normalizeForEcho('<p><strong>Hi</strong> <a href="https://a.example">site</a></p>'),
    normalizeForEcho("**Hi** [site](https://a.example)"),
  );
});

test("empty shells have no content, but a photo with no caption does", () => {
  assert.equal(hasContent({ text: undefined, type: undefined }), false);
  assert.equal(hasContent({ text: undefined, type: "IMAGE" }), true);
  assert.equal(hasContent({ text: "x" }), true);
});

const single = (accountID: string, person: Record<string, unknown>, title = "Some Name") => ({
  id: "!chat:beeper",
  accountID,
  title,
  type: "single",
  participants: {
    items: [
      { id: "me", isSelf: true },
      { id: "@p:x", ...person },
    ],
  },
});

test("people get bp-<platform>-<id> labels from their real identifiers", () => {
  assert.equal(
    threadLabel(single("instagramgo.110550", { username: "leonsilicon" })),
    "bp-ig-leonsilicon",
  );
  assert.equal(
    threadLabel(single("instagramgo.110550", { username: "@Leon.Silicon_" })),
    "bp-ig-leon-silicon",
  );
  assert.equal(
    threadLabel(single("whatsapp.19147455366", { phoneNumber: "+1 (415) 555-0100" })),
    "bp-wa-14155550100",
  );
  assert.equal(
    threadLabel(single("imessage_ecdb4eb8", { phoneNumber: "+14155550100" })),
    "bp-imsg-14155550100",
  );
  assert.equal(
    threadLabel(single("imessage_ecdb4eb8", { email: "Alice@Example.com" })),
    "bp-imsg-alice-example-com",
  );
  assert.equal(threadLabel(single("discordgo.1", { username: "leon.s" })), "bp-dc-leon-s");
  assert.equal(threadLabel(single("twitter.1", { username: "leon_si" })), "bp-x-leon_si");
});

test("a label stays the same when the display name changes", () => {
  assert.equal(
    threadLabel(single("instagramgo.1", { username: "leon", fullName: "Leon" }, "Leon")),
    threadLabel(single("instagramgo.1", { username: "leon", fullName: "Leon S" }, "Leon S")),
  );
});

test("unreadable usernames fall back to the name plus a stable hash", () => {
  const person = {
    username: "ACoAABcDeFgHiJ1kL2mN3oP4qR5sT6uV7w",
    fullName: "Alice Smith",
    id: "@li:x",
  };
  assert.match(threadLabel(single("linkedin.1", person)), /^bp-li-alice-smith-[0-9a-f]{4}$/);
  assert.equal(
    threadLabel(single("linkedin.1", person)),
    threadLabel(single("linkedin.1", person)),
  );
  assert.match(
    threadLabel(single("wechat.1", { fullName: "王小明", id: "@w:x" })),
    /^bp-wc-王小明-[0-9a-f]{4}$/,
  );
  assert.match(
    threadLabel(single("wechat.1", { fullName: "🎉", id: "@w:x" }, "🎉")),
    /^bp-wc-[0-9a-f]{4}$/,
  );
});

test("group labels are stable and can never look like a person", () => {
  const group = { id: "!g:x", accountID: "whatsapp.1", title: "Family Trip!", type: "group" };
  assert.match(threadLabel(group), /^bp-wa-grp-family-trip-[0-9a-f]{4}$/);
  assert.match(threadLabel({ ...group, title: "🎉" }), /^bp-wa-grp-[0-9a-f]{4}$/);
});

test("unknown platforms still get a short, valid code", () => {
  assert.equal(platformCode("somenewbridge.123"), "somenewbridg");
  assert.equal(platformCode("my-agents.abc"), "my-agents");
});

test("real people exclude groups, automated accounts and unreachable people", () => {
  assert.equal(isRealPerson(single("instagramgo.1", { username: "a" })), true);
  assert.equal(isRealPerson(single("whatsapp.1", { isNetworkBot: true })), false);
  assert.equal(isRealPerson(single("whatsapp.1", { cannotMessage: true })), false);
  assert.equal(
    isRealPerson({
      accountID: "whatsapp.1",
      type: "group",
      participants: { items: [{ id: "a" }] },
    }),
    false,
  );
  assert.equal(
    isRealPerson({
      accountID: "whatsapp.1",
      type: "single",
      participants: { items: [{ id: "me", isSelf: true }] },
    }),
    false,
  );
});
