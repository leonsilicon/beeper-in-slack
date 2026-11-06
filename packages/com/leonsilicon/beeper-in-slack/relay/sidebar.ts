import type { SidebarApi } from "#types";

export interface SidebarSection {
  channel_section_id: string;
  name: string;
  type: string;
  channel_ids_page?: { channel_ids?: string[] };
}

export interface SidebarOptions {
  /** The `xoxc-` token of a signed-in Slack web session. */
  token: string;
  /** That session's `d` cookie, exactly as Slack stored it. */
  cookie: string;
  sectionName: string;
  fetch?: typeof fetch;
}

/**
 * Sidebar sections have no public API, and bot or OAuth user tokens cannot change them. These are the
 * methods Slack's own web client uses, so they need the owner's signed-in session.
 */
export class SlackSidebar implements SidebarApi {
  #options: SidebarOptions;
  #fetch: typeof fetch;
  #sectionId: string | null = null;

  constructor(options: SidebarOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async #call<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    const response = await this.#fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Cookie: `d=${this.#options.cookie}` },
      body: new URLSearchParams({ token: this.#options.token, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!result.ok) {
      const code = result.error ?? `http_${response.status}`;
      throw Object.assign(new Error(`Slack ${method} failed: ${code}`), { data: { error: code } });
    }
    return result;
  }

  async sections(): Promise<SidebarSection[]> {
    const { channel_sections } = await this.#call<{ channel_sections: SidebarSection[] }>(
      "users.channelSections.list",
    );
    return channel_sections;
  }

  /** Follows a renamed section by its ID, and recreates it under the configured name if it was deleted. */
  async #section(): Promise<string> {
    const sections = await this.sections();
    const existing =
      sections.find((section) => section.channel_section_id === this.#sectionId) ??
      sections.find(
        (section) => section.type === "standard" && section.name === this.#options.sectionName,
      );
    if (existing) return (this.#sectionId = existing.channel_section_id);
    const created = await this.#call<{ channel_section_id: string }>(
      "users.channelSections.create",
      { name: this.#options.sectionName },
    );
    return (this.#sectionId = created.channel_section_id);
  }

  async place(channels: string[]): Promise<void> {
    if (channels.length === 0) return;
    const section = await this.#section();
    await this.#call("users.channelSections.channels.bulkUpdate", {
      insert: JSON.stringify([{ channel_section_id: section, channel_ids: channels }]),
    });
  }
}
