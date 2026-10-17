// R0 probe: can a Discord bot do what agentSwarm needs? Send, thread, buttons, slash command, and read replies.
//
//   node probe.mjs [minutes]
//
// Reads the bot token from ~/.config/agentswarm-r0/claude-token (the "discord:" part; never printed).
// Waits for a person to reply, click a button and run /agentswarm, then exits.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from "discord.js";

const minutes = Number(process.argv[2] ?? 10);
const raw = readFileSync(join(homedir(), ".config/agentswarm-r0/claude-token"), "utf8");
const token = raw.match(/discord:([\s\S]*)$/)?.[1].replace(/\s+/g, "");
if (!token) throw new Error("No discord: token in the file");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const seen = { reply: null, button: null, slash: null };
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let channel;
let thread;

client.once(Events.ClientReady, async (c) => {
  log(`logged in as ${c.user.tag}`);
  const guilds = [...c.guilds.cache.values()];
  log(`guilds: ${guilds.map((g) => `${g.name} (${g.id})`).join(", ") || "none"}`);
  const guild = guilds[0];
  if (!guild) return finish("the bot is in no server");
  await guild.channels.fetch();
  const me = guild.members.me;
  channel = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildText
    && ch.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel]));
  if (!channel) return finish("no text channel the bot can post in");
  log(`channel: #${channel.name} · can create threads: ${channel.permissionsFor(me).has(PermissionFlagsBits.CreatePublicThreads)} · manage channels: ${me.permissions.has(PermissionFlagsBits.ManageChannels)}`);

  const cmd = new SlashCommandBuilder().setName("agentswarm").setDescription("agentSwarm R0 probe: show status");
  await guild.commands.set([cmd.toJSON()]);
  log("registered /agentswarm in this server");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("approve").setLabel("批准").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("revise").setLabel("要修改").setStyle(ButtonStyle.Secondary),
  );
  const t0 = Date.now();
  const msg = await channel.send({ content: "**agentSwarm R0 实测**：请在下面的线程里回复任意一句话，点一个按钮，再输入 `/agentswarm`。", components: [row] });
  log(`posted a message with buttons (${Date.now() - t0} ms)`);
  thread = await msg.startThread({ name: "agentSwarm R0 实测线程", autoArchiveDuration: 60 });
  await thread.send("这是线程里的第一条消息。在这里回复我。");
  log(`started thread ${thread.name}`);
});

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || seen.reply) return;
  if (m.channelId !== thread?.id && m.channelId !== channel?.id) return;
  seen.reply = { user: m.author.tag, id: m.author.id, inThread: m.channelId === thread?.id, text: m.content.slice(0, 80) };
  log(`reply from ${m.author.tag} (${m.author.id}) in ${seen.reply.inThread ? "thread" : "channel"}: ${JSON.stringify(seen.reply.text)}`);
  await m.reply(`收到：${m.content.slice(0, 100)}`);
  check();
});

client.on(Events.InteractionCreate, async (i) => {
  if (i.isButton()) {
    seen.button = { user: i.user.tag, id: i.user.id, choice: i.customId };
    log(`button ${i.customId} by ${i.user.tag} (${i.user.id})`);
    await i.update({ content: `**agentSwarm R0 实测**：${i.user.username} 选择了「${i.customId === "approve" ? "批准" : "要修改"}」。`, components: [] });
  } else if (i.isChatInputCommand() && i.commandName === "agentswarm") {
    seen.slash = { user: i.user.tag, id: i.user.id };
    log(`/agentswarm by ${i.user.tag} (${i.user.id})`);
    await i.reply({ content: "agentSwarm R0：机器人在线，斜杠命令可用。", flags: MessageFlags.Ephemeral });
  } else return;
  check();
});

function check() {
  if (seen.reply && seen.button && seen.slash) finish("all three received");
}

async function finish(why) {
  log(`done: ${why}`);
  log(`result ${JSON.stringify(seen)}`);
  await client.destroy();
  process.exit(0);
}

setTimeout(() => finish(`timed out after ${minutes} min`), minutes * 60_000).unref();
await client.login(token);
