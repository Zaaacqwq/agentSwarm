import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle, ThreadAutoArchiveDuration,
  type ButtonInteraction, type ChatInputCommandInteraction, type GuildTextBasedChannel, type Interaction, type TextChannel,
} from "discord.js";
import type { Button, ChatTransport, CommandSpec, OutMessage, TransportHandlers } from "./transport.ts";

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;
const NEEDED = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory,
];

function rows(buttons: readonly Button[] | undefined) {
  if (!buttons?.length) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(STYLE[b.style])))];
}

/** The real Discord, through discord.js (tested in R0 with 14.27.0). */
export class DiscordJsTransport implements ChatTransport {
  private client: Client | null = null;

  async connect(token: string, h: TransportHandlers): Promise<{ botTag: string }> {
    await this.disconnect();
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    // Held from the start, so a failed or slow login is still destroyed by disconnect().
    this.client = client;
    client.on(Events.MessageCreate, (m) => h.message({ id: m.id, channelId: m.channelId, authorId: m.author.id, authorIsBot: m.author.bot, text: m.content }));
    client.on(Events.InteractionCreate, (i) => void this.interaction(i, h).catch(() => undefined));
    client.on(Events.ShardDisconnect, (event) => {
      // 4004 bad token, 4014 privileged intent (Message Content) not enabled: reconnecting will not help.
      if (event.code === 4004 || event.code === 4014) h.failed(new Error(event.code === 4004 ? "Discord rejected the bot token" : "Turn on the Message Content intent for the bot in the Discord developer portal"));
    });
    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    try {
      await client.login(token);
      await Promise.race([ready, new Promise((_r, reject) => (timer = setTimeout(() => reject(new Error("Discord did not get ready within 30 s")), 30_000)))]);
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return { botTag: client.user?.tag ?? "?" };
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.destroy();
  }

  async checkChannel(channelId: string): Promise<string> {
    const channel = await this.channel(channelId);
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    const missing = NEEDED.filter((p) => !perms?.has(p));
    if (missing.length) throw new Error("The bot needs View Channel, Send Messages, Create Public Threads, Send Messages in Threads and Read Message History in that channel");
    return channel.name;
  }

  async registerCommands(channelId: string, commands: readonly CommandSpec[]): Promise<void> {
    const channel = await this.channel(channelId);
    await channel.guild.commands.set(commands.map((c) => {
      const b = new SlashCommandBuilder().setName(c.name).setDescription(c.description);
      for (const o of c.options ?? []) {
        if (o.type === "string") b.addStringOption((x) => {
          x.setName(o.name).setDescription(o.description).setRequired(o.required ?? false).setAutocomplete(o.autocomplete ?? false);
          return o.maxLength ? x.setMaxLength(o.maxLength) : x;
        });
        else if (o.type === "number") b.addNumberOption((x) => {
          x.setName(o.name).setDescription(o.description).setRequired(o.required ?? false);
          if (o.min !== undefined) x.setMinValue(o.min);
          return o.max !== undefined ? x.setMaxValue(o.max) : x;
        });
        else b.addBooleanOption((x) => x.setName(o.name).setDescription(o.description).setRequired(o.required ?? false));
      }
      return b.toJSON();
    }));
  }

  async createThread(channelId: string, name: string): Promise<string> {
    const channel = (await this.channel(channelId)) as TextChannel;
    const thread = await channel.threads.create({ name: name.slice(0, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, type: ChannelType.PublicThread });
    return thread.id;
  }

  async send(channelId: string, message: OutMessage): Promise<string> {
    const channel = await this.client!.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Cannot post in ${channelId}`);
    const sent = await channel.send({ content: message.content, components: rows(message.buttons), allowedMentions: { parse: [] } });
    return sent.id;
  }

  private async channel(channelId: string): Promise<GuildTextBasedChannel & { name: string }> {
    if (!this.client) throw new Error("Discord is not connected");
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error("That channel is not a text channel the bot can see");
    return channel as GuildTextBasedChannel & { name: string };
  }

  private async interaction(i: Interaction, h: TransportHandlers): Promise<void> {
    if (i.isAutocomplete()) {
      const focused = i.options.getFocused(true);
      h.autocomplete({ userId: i.user.id, name: focused.name, value: String(focused.value), respond: async (choices) => void (await i.respond(choices.slice(0, 25))) });
      return;
    }
    if (i.isChatInputCommand()) {
      // Commands may take longer than Discord's 3 seconds: acknowledge first, answer by editing.
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const options = Object.fromEntries(i.options.data.map((o) => [o.name, o.value as string | number | boolean]));
      h.command({ name: i.commandName, options, userId: i.user.id, channelId: i.channelId, reply: (text, opts) => this.answerCommand(i, text, opts?.buttons) });
      return;
    }
    if (i.isButton()) {
      h.button({
        customId: i.customId, messageId: i.message.id, userId: i.user.id, channelId: i.channelId,
        reply: (text, opts) => this.answer(i, text, opts?.visible ?? false, opts?.buttons),
        settle: async (note) => void (await i.update({ content: `${i.message.content}\n\n${note}`, components: [] })),
        showModal: async (m) => {
          const input = new TextInputBuilder().setCustomId("text").setLabel(m.label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
          if (m.placeholder) input.setPlaceholder(m.placeholder);
          await i.showModal(new ModalBuilder().setCustomId(m.id).setTitle(m.title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
        },
      });
      return;
    }
    if (i.isModalSubmit()) {
      h.modal({
        customId: i.customId, text: i.fields.getTextInputValue("text"), userId: i.user.id, channelId: i.channelId ?? "",
        reply: async (text, opts) => void (await i.reply({ content: text, ...(opts?.visible ? {} : { flags: MessageFlags.Ephemeral }), allowedMentions: { parse: [] } })),
      });
    }
  }

  private async answerCommand(i: ChatInputCommandInteraction, text: string, buttons?: readonly Button[]): Promise<void> {
    await i.editReply({ content: text.slice(0, 1900), components: rows(buttons), allowedMentions: { parse: [] } });
  }

  private async answer(i: ButtonInteraction, text: string, visible: boolean, buttons?: readonly Button[]): Promise<void> {
    const payload = { content: text.slice(0, 1900), components: rows(buttons), allowedMentions: { parse: [] } };
    if (i.replied || i.deferred) await i.followUp({ ...payload, ...(visible ? {} : { flags: MessageFlags.Ephemeral }) });
    else await i.reply({ ...payload, ...(visible ? {} : { flags: MessageFlags.Ephemeral }) });
  }
}
