import type { Button, ChatTransport, CommandSpec, OutMessage, TransportHandlers } from "../src/discord/transport.ts";

export interface Sent {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
  readonly buttons: readonly Button[];
}

/** Discord without Discord: records what the bridge sends and plays the person's side. */
export class FakeDiscord implements ChatTransport {
  readonly sent: Sent[] = [];
  readonly threads: { id: string; channelId: string; name: string }[] = [];
  readonly replies: { text: string; visible: boolean; buttons: readonly Button[] }[] = [];
  readonly settled: { messageId: string; note: string }[] = [];
  readonly modals: string[] = [];
  commands: readonly CommandSpec[] = [];
  connected = false;
  /** The next N sends fail (a Discord outage). */
  failSends = 0;
  private handlers: TransportHandlers | null = null;
  private next = 1000;

  async connect(token: string, handlers: TransportHandlers): Promise<{ botTag: string }> {
    if (!token.startsWith("fake-")) throw new Error("Discord rejected the bot token");
    this.handlers = handlers;
    this.connected = true;
    return { botTag: "agentSwarm#0001" };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async checkChannel(channelId: string): Promise<string> {
    if (channelId !== CHANNEL) throw new Error("That channel is not a text channel the bot can see");
    return "agentswarm";
  }

  async registerCommands(_channelId: string, commands: readonly CommandSpec[]): Promise<void> {
    this.commands = commands;
  }

  async createThread(channelId: string, name: string): Promise<string> {
    const id = this.id();
    this.threads.push({ id, channelId, name });
    return id;
  }

  async send(channelId: string, message: OutMessage): Promise<string> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error("Discord is unavailable");
    }
    const id = this.id();
    this.sent.push({ id, channelId, content: message.content, buttons: message.buttons ?? [] });
    return id;
  }

  // ---- the person's side ------------------------------------------------------------------

  say(channelId: string, text: string, authorId = OWNER): void {
    this.handlers!.message({ id: this.id(), channelId, authorId, authorIsBot: false, text });
  }

  async command(name: string, options: Record<string, string | number | boolean>, channelId: string = CHANNEL, userId = OWNER): Promise<string> {
    const before = this.replies.length;
    this.handlers!.command({ name, options, userId, channelId, reply: async (text, opts) => void this.replies.push({ text, visible: opts?.visible ?? false, buttons: opts?.buttons ?? [] }) });
    await until(() => this.replies.length > before);
    return this.replies.at(-1)!.text;
  }

  async click(customId: string, channelId: string, userId = OWNER): Promise<void> {
    const marks = this.replies.length + this.settled.length + this.modals.length;
    this.handlers!.button({
      customId, messageId: "m", userId, channelId,
      reply: async (text, opts) => void this.replies.push({ text, visible: opts?.visible ?? false, buttons: opts?.buttons ?? [] }),
      settle: async (note) => void this.settled.push({ messageId: "m", note }),
      showModal: async (m) => void this.modals.push(m.id),
    });
    await until(() => this.replies.length + this.settled.length + this.modals.length > marks);
  }

  async submitModal(customId: string, text: string, channelId: string, userId = OWNER): Promise<void> {
    const before = this.replies.length;
    this.handlers!.modal({ customId, text, userId, channelId, reply: async (t, opts) => void this.replies.push({ text: t, visible: opts?.visible ?? false, buttons: [] }) });
    await until(() => this.replies.length > before);
  }

  inThread(threadId: string): Sent[] {
    return this.sent.filter((s) => s.channelId === threadId);
  }

  private id(): string {
    return String(this.next++).padStart(18, "1");
  }
}

export const CHANNEL = "123456789012345678";
export const OWNER = "769549199007416320";
export const STRANGER = "111111111111111111";

export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
