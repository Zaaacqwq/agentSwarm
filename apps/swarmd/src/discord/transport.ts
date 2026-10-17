/**
 * The little of Discord agentSwarm uses, behind an interface: the bridge holds the logic, and tests
 * replace Discord with a fake that records what was sent and injects messages and clicks.
 */
export interface Button {
  readonly id: string;
  readonly label: string;
  readonly style: "primary" | "secondary" | "success" | "danger";
}

export interface OutMessage {
  readonly content: string;
  readonly buttons?: readonly Button[];
}

export interface Responder {
  readonly userId: string;
  readonly channelId: string;
  /** Answers the interaction (only the person sees it unless `visible`). */
  reply(text: string, opts?: { visible?: boolean; buttons?: readonly Button[] }): Promise<void>;
}

export interface CommandEvent extends Responder {
  readonly name: string;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface ButtonEvent extends Responder {
  readonly customId: string;
  readonly messageId: string;
  /** Replaces the clicked message's buttons with a line saying what happened. */
  settle(note: string): Promise<void>;
  /** Opens a one-field form; its submission arrives as a ModalEvent with the same id. */
  showModal(modal: { id: string; title: string; label: string; placeholder?: string }): Promise<void>;
}

export interface ModalEvent extends Responder {
  readonly customId: string;
  readonly text: string;
}

export interface AutocompleteEvent {
  readonly userId: string;
  readonly name: string;
  readonly value: string;
  respond(choices: { name: string; value: string }[]): Promise<void>;
}

export interface IncomingMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly text: string;
}

export interface TransportHandlers {
  message(m: IncomingMessage): void;
  command(e: CommandEvent): void;
  button(e: ButtonEvent): void;
  modal(e: ModalEvent): void;
  autocomplete(e: AutocompleteEvent): void;
  /** The connection dropped for good (bad token, missing intents). */
  failed(error: Error): void;
}

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly {
    readonly name: string;
    readonly description: string;
    readonly type: "string" | "number" | "boolean";
    readonly required?: boolean;
    readonly autocomplete?: boolean;
    readonly maxLength?: number;
    readonly min?: number;
    readonly max?: number;
  }[];
}

export interface ChatTransport {
  connect(token: string, handlers: TransportHandlers): Promise<{ botTag: string }>;
  disconnect(): Promise<void>;
  /** The channel's name; throws if the bot cannot post and create threads there. */
  checkChannel(channelId: string): Promise<string>;
  /** Slash commands, registered in the channel's server. */
  registerCommands(channelId: string, commands: readonly CommandSpec[]): Promise<void>;
  createThread(channelId: string, name: string): Promise<string>;
  send(channelId: string, message: OutMessage): Promise<string>;
}

/** Discord allows 2000 characters per message; split on line breaks where possible. */
export function splitMessage(text: string, max = 1900): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : ["(empty)"];
}
