export interface BeeperAttachment {
  id?: string;
  type?: string;
  srcURL?: string;
  mimeType?: string;
  fileName?: string;
}

export interface BeeperMessage {
  id: string;
  chatID: string;
  accountID?: string;
  senderID?: string;
  senderName?: string;
  timestamp: string;
  sortKey?: string;
  type?: string;
  text?: string;
  editedTimestamp?: string;
  isSender?: boolean;
  isHidden?: boolean;
  isDeleted?: boolean;
  isUnread?: boolean;
  linkedMessageID?: string;
  attachments?: BeeperAttachment[];
  sendStatus?: { status?: string; message?: string };
}

export interface BeeperParticipant {
  id: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  fullName?: string;
  isSelf?: boolean;
  isNetworkBot?: boolean;
  cannotMessage?: boolean;
}

export interface BeeperChat {
  id: string;
  accountID: string;
  network: string;
  title: string;
  type?: string;
  isMuted?: boolean;
  isLowPriority?: boolean;
  mergedIntoChatID?: string;
  lastActivity?: string;
  participants?: { items?: BeeperParticipant[] };
}

export interface BeeperEvent {
  type: string;
  chatID: string;
  ids: string[];
  entries?: Array<Partial<BeeperMessage>>;
}

export interface SearchResult {
  messages: BeeperMessage[];
  truncated: boolean;
}

export interface BeeperApi {
  chat(chatId: string): Promise<BeeperChat>;
  listChats(): Promise<BeeperChat[]>;
  message(chatId: string, messageId: string): Promise<BeeperMessage>;
  searchSince(iso: string): Promise<SearchResult>;
  send(
    chatId: string,
    body: { text?: string; replyToMessageID?: string; attachment?: { uploadID: string } },
  ): Promise<{ chatID: string; pendingMessageID: string }>;
  markRead(chatId: string): Promise<void>;
  downloadAsset(url: string): Promise<string>;
  uploadAsset(path: string, fileName: string, mimeType?: string): Promise<string>;
}

export interface SlackPost {
  channel: string;
  text: string;
  username?: string;
  iconEmoji?: string;
  threadTs?: string;
  broadcast?: boolean;
}

export interface SlackIdentity {
  userId: string;
  botId: string;
}

export interface SlackApi {
  /** The relay's own bot, so its mirrored posts are never sent back to Beeper. */
  identity(): Promise<SlackIdentity>;
  createPrivateChannel(name: string, topic: string, marker?: string): Promise<string>;
  findPrivateChannel(name: string): Promise<{ id: string; marker: string } | null>;
  invite(channel: string, user: string): Promise<void>;
  unarchive(channel: string): Promise<void>;
  post(post: SlackPost): Promise<string>;
  update(channel: string, ts: string, text: string): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  ephemeral(channel: string, user: string, text: string): Promise<void>;
  uploadFile(channel: string, path: string, fileName: string, threadTs?: string): Promise<void>;
  downloadFile(
    url: string,
    fileName: string,
  ): Promise<{ path: string; cleanup: () => Promise<void> }>;
}

/** The owner's Slack sidebar, which only the owner's own signed-in session can change. */
export interface SidebarApi {
  /** Adds channels the owner has joined to the configured section, creating it if it is gone. */
  place(channels: string[]): Promise<void>;
}

export type Logger = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;
