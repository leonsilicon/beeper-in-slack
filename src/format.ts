import { createHash } from "node:crypto";
import type { BeeperChat, BeeperMessage, BeeperParticipant } from "#types";

export const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 6);

/** Neutralises Slack control sequences, so a contact's text can't trigger <!channel> or fake links. */
export const escapeSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const PLATFORM_CODES: Record<string, string> = {
  instagramgo: "ig",
  instagram: "ig",
  whatsapp: "wa",
  imessage: "imsg",
  imessagecloud: "imsg",
  discordgo: "dc",
  discord: "dc",
  linkedin: "li",
  twitter: "x",
  telegram: "tg",
  signal: "sig",
  wechat: "wc",
  facebookgo: "fb",
  facebook: "fb",
  gmessages: "sms",
  googlechat: "gc",
  matrix: "mx",
};

/** The bridge name at the start of an account ID, as in `instagramgo.123` or `imessage_abc`. */
export const bridgeOf = (accountID: string): string => accountID.split(/[._:]/)[0].toLowerCase();

export const platformCode = (accountID: string): string => {
  const bridge = bridgeOf(accountID);
  return PLATFORM_CODES[bridge] ?? bridge.replace(/[^a-z0-9-]/g, "").slice(0, 12);
};

const labelSlug = (value: string, maxLength = 60): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, maxLength)
    .replace(/[-_]+$/, "");

// Some networks fill the username with an internal ID, such as LinkedIn's long mixed-case strings.
const isOpaque = (username: string): boolean =>
  username.length >= 24 &&
  /^[A-Za-z0-9_-]+$/.test(username) &&
  /[A-Z]/.test(username) &&
  /[0-9]/.test(username);

const otherParticipant = (chat: Pick<BeeperChat, "participants">): BeeperParticipant | undefined =>
  chat.participants?.items?.find((participant) => !participant.isSelf);

function personHandle(
  person: BeeperParticipant | undefined,
  chat: Pick<BeeperChat, "id" | "title">,
): string {
  const username = person?.username?.replace(/^@/, "");
  if (username && !isOpaque(username)) {
    const handle = labelSlug(username);
    if (handle) return handle;
  }
  const digits = person?.phoneNumber?.replace(/\D/g, "");
  if (digits) return digits;
  const email = person?.email ? labelSlug(person.email) : "";
  if (email) return email;
  // No readable ID exists, so use the name, plus a hash of the stable ID to keep it unique.
  const name = labelSlug(person?.fullName ?? chat.title, 50);
  const hash = shortHash(person?.id ?? chat.id).slice(0, 4);
  return name ? `${name}-${hash}` : hash;
}

/**
 * bp-<platform>-<unique id>, such as bp-ig-janedoe. The same person always gets the same label, even if their
 * display name changes. Groups have no single owner, so they get bp-<platform>-grp-<title>-<hash>.
 */
export function threadLabel(
  chat: Pick<BeeperChat, "id" | "accountID" | "title" | "type" | "participants">,
): string {
  const code = platformCode(chat.accountID);
  if (chat.type === "group") {
    const title = labelSlug(chat.title, 50);
    const hash = shortHash(chat.id).slice(0, 4);
    return `bp-${code}-grp-${title ? `${title}-` : ""}${hash}`;
  }
  return `bp-${code}-${personHandle(otherParticipant(chat), chat)}`;
}

/** A one-to-one chat with someone who isn't an automated account. */
export function isRealPerson(
  chat: Pick<BeeperChat, "accountID" | "type" | "participants">,
): boolean {
  if (chat.type !== "single") return false;
  const person = otherParticipant(chat);
  return Boolean(person) && !person?.isNetworkBot && !person?.cannotMessage;
}

export function channelName(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
  return slug ? `bp-${slug}` : "bp-chat";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const decodeEntities = (text: string): string =>
  text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    const value =
      code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  });

// Only these count as markup. Something like <Foo> stays as text, in case a person literally typed it.
const RICH_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "del",
  "s",
  "strike",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "span",
  "div",
  "font",
  "sub",
  "sup",
]);
const TAG_TOKEN = /(<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>)/;
const TAG_PARTS = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?\/?>$/;
const WRAPPERS: Record<string, string> = {
  strong: "*",
  b: "*",
  em: "_",
  i: "_",
  del: "~",
  s: "~",
  strike: "~",
};

const hrefOf = (attributes = ""): string | null => {
  const match = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  const href = match ? decodeEntities(match[1] ?? match[2]) : null;
  return href && /^(https?:|mailto:)/i.test(href) ? href : null;
};

/**
 * Beeper returns formatted messages as HTML. This renders them as Slack text, escaping everything a sender wrote.
 * A link shows its real target beside its label, so a message can't dress one address up as another.
 */
export function richTextToSlack(text: string): string {
  const tokens = text.split(TAG_TOKEN);
  const isMarkup = tokens.some((token) => {
    const parts = TAG_PARTS.exec(token);
    return parts !== null && RICH_TAGS.has(parts[2].toLowerCase());
  });
  if (!isMarkup) return escapeSlack(decodeEntities(text));

  let output = "";
  let preDepth = 0;
  let cell = 0;
  const lists: Array<{ ordered: boolean; next: number }> = [];
  const links: Array<{ href: string | null; start: number }> = [];
  const quotes: number[] = [];
  const startLine = (): void => {
    if (output && !output.endsWith("\n")) output += "\n";
  };

  for (const token of tokens) {
    if (!token) continue;
    const parts = TAG_PARTS.exec(token);
    const name = parts?.[2].toLowerCase();
    if (!parts || !name || !RICH_TAGS.has(name)) {
      if (preDepth === 0 && /^\s*$/.test(token) && token.includes("\n")) continue;
      output += escapeSlack(decodeEntities(token));
      continue;
    }
    const closing = parts[1] === "/";
    if (WRAPPERS[name]) {
      if (preDepth === 0) output += WRAPPERS[name];
      continue;
    }
    switch (name) {
      case "br":
        output += "\n";
        break;
      case "hr":
        startLine();
        output += "---\n";
        break;
      case "p":
      case "div":
        if (closing) output += lists.length > 0 ? "" : "\n\n";
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        if (closing) output += "*\n";
        else {
          startLine();
          output += "*";
        }
        break;
      case "code":
        if (preDepth === 0) output += "`";
        break;
      case "pre":
        if (closing) {
          preDepth--;
          if (!output.endsWith("\n")) output += "\n";
          output += "```\n";
        } else {
          startLine();
          preDepth++;
          output += "```\n";
        }
        break;
      case "ul":
      case "ol":
        if (closing) {
          lists.pop();
          if (lists.length === 0) output += "\n";
        } else {
          startLine();
          lists.push({
            ordered: name === "ol",
            next: Number(/start\s*=\s*"?(\d+)/i.exec(parts[3] ?? "")?.[1] ?? 1),
          });
        }
        break;
      case "li":
        if (!closing) {
          startLine();
          const list = lists.at(-1);
          const marker = list?.ordered ? `${list.next++}.` : "•";
          output += `${"  ".repeat(Math.max(0, lists.length - 1))}${marker} `;
        }
        break;
      case "tr":
        if (!closing) {
          startLine();
          cell = 0;
        }
        break;
      case "th":
      case "td":
        if (!closing && cell++ > 0) output += " | ";
        break;
      case "table":
        if (closing) output += "\n\n";
        break;
      case "blockquote":
        if (closing) {
          const start = quotes.pop() ?? 0;
          const body = output
            .slice(start)
            .trim()
            .split("\n")
            .map((line) => `&gt; ${line}`)
            .join("\n");
          output = `${output.slice(0, start)}${body}\n`;
        } else {
          startLine();
          quotes.push(output.length);
        }
        break;
      case "a":
        if (closing) {
          const link = links.pop();
          if (link?.href) {
            const label = output.slice(link.start);
            const shownUrl = escapeSlack(link.href);
            output = `${output.slice(0, link.start)}${label && label !== shownUrl ? `${label} (${shownUrl})` : shownUrl}`;
          }
        } else {
          links.push({ href: hrefOf(parts[3]), start: output.length });
        }
        break;
    }
  }
  return output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PLACEHOLDERS: Record<string, string> = {
  IMAGE: "photo",
  VIDEO: "video",
  VOICE: "voice note",
  AUDIO: "audio",
  FILE: "file",
  STICKER: "sticker",
  LOCATION: "location",
};

/** False for empty shells, such as a message with no text, no attachment and no known type. */
export const hasContent = (
  message: Pick<BeeperMessage, "text" | "type" | "attachments">,
): boolean =>
  Boolean(message.text || message.attachments?.length || PLACEHOLDERS[message.type ?? ""]);

export function messageBody(message: Pick<BeeperMessage, "text" | "type" | "attachments">): string {
  if (message.text) return richTextToSlack(message.text);
  const placeholder =
    PLACEHOLDERS[message.type ?? ""] ?? (message.attachments?.length ? "attachment" : "message");
  return `_[${placeholder}]_`;
}

export function withDelayNote(
  body: string,
  timestampMs: number,
  nowMs: number,
  delayMs: number,
): string {
  if (nowMs - timestampMs <= delayMs) return body;
  const seconds = Math.floor(timestampMs / 1000);
  const fallback = new Date(timestampMs).toISOString();
  return `_(sent <!date^${seconds}^{date_short_pretty} {time}|${fallback}>)_\n${body}`;
}

/** Compared loosely, because Beeper converts sent Markdown into rich text before echoing it back. */
export const normalizeForEcho = (text: string): string =>
  decodeEntities(text.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, ""))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .normalize("NFKC")
    .replace(/[\s*_~`>[\]()]+/g, "")
    .toLowerCase();

interface RichElement {
  type: string;
  text?: string;
  url?: string;
  name?: string;
  unicode?: string;
  user_id?: string;
  channel_id?: string;
  range?: string;
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
  elements?: RichElement[];
  indent?: number;
}

export interface SlackMessageContent {
  text?: string;
  blocks?: Array<{ type: string; elements?: RichElement[] }>;
}

function styled(text: string, style: RichElement["style"]): string {
  if (!text) return text;
  if (style?.code) return `\`${text}\``;
  let result = text;
  if (style?.italic) result = `*${result}*`;
  if (style?.bold) result = `**${result}**`;
  if (style?.strike) result = `~~${result}~~`;
  return result;
}

function inline(element: RichElement): string {
  switch (element.type) {
    case "text":
      return styled(element.text ?? "", element.style);
    case "emoji":
      return element.unicode
        ? element.unicode
            .split("-")
            .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
            .join("")
        : `:${element.name}:`;
    case "link":
      return element.text && element.text !== element.url
        ? `[${element.text}](${element.url})`
        : (element.url ?? "");
    case "user":
      return `@${element.user_id}`;
    case "channel":
      return `#${element.channel_id}`;
    case "broadcast":
      return `@${element.range}`;
    default:
      return element.text ?? "";
  }
}

const inlineAll = (elements: RichElement[] = []): string => elements.map(inline).join("");

function richBlock(element: RichElement): string {
  switch (element.type) {
    case "rich_text_section":
      return inlineAll(element.elements).replace(/\n$/, "");
    case "rich_text_list": {
      const indent = "  ".repeat(element.indent ?? 0);
      const ordered =
        element.style && (element as { style: { type?: string } }).style.type === "ordered";
      return (element.elements ?? [])
        .map(
          (item, index) =>
            `${indent}${ordered ? `${index + 1}.` : "-"} ${inlineAll(item.elements)}`,
        )
        .join("\n");
    }
    case "rich_text_quote":
      return inlineAll(element.elements)
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rich_text_preformatted":
      return `\`\`\`\n${inlineAll(element.elements).replace(/\n$/, "")}\n\`\`\``;
    default:
      return "";
  }
}

const unescapeSlack = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function plainFromSlackText(text: string): string {
  const converted = text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) =>
      url.startsWith("mailto:") ? label : `[${label}](${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1");
  return unescapeSlack(converted);
}

/** Turns a Slack message into what the contact should read. Blocks are preferred, as they carry real emoji. */
export function slackToOutgoingText(content: SlackMessageContent): string {
  const rich = (content.blocks ?? []).filter((block) => block.type === "rich_text");
  if (rich.length > 0) {
    return rich
      .flatMap((block) => (block.elements ?? []).map(richBlock))
      .join("\n")
      .trim();
  }
  return plainFromSlackText(content.text ?? "").trim();
}

/** Text that must stay in Slack: notes to yourself, or anything addressed to someone in the channel. */
export function holdBackReason(rawSlackText: string): string | null {
  if (rawSlackText.trimStart().startsWith("//"))
    return "It starts with //, so it stays in Slack as a note.";
  if (/<@[UW][A-Z0-9]+>|<!(?:here|channel|everyone)>/.test(rawSlackText)) {
    return "It mentions someone in Slack, so I held it back in case it was not meant for your contact. Remove the mention to send it.";
  }
  return null;
}

/** Connector attribution is a context block, not part of the owner's message to a contact. */
export function slackHoldBackReason(content: SlackMessageContent): string | null {
  let raw = content.text ?? "";
  const attribution = (content.blocks ?? [])
    .filter((block) => block.type === "context")
    .flatMap((block) => block.elements ?? [])
    .filter(
      (element) =>
        element.type === "mrkdwn" && /^\*Sent using\* <@[UW][A-Z0-9]+>$/.test(element.text ?? ""),
    );
  for (const element of attribution) {
    const footer = element.text!;
    if (raw.endsWith(footer)) raw = raw.slice(0, -footer.length).trimEnd();
  }
  return holdBackReason(raw);
}
