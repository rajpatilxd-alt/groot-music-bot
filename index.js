require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const ffmpegPath = require('ffmpeg-static');

if (!process.env.DISCORD_TOKEN || !process.env.OWNER_ID) {
  throw new Error('DISCORD_TOKEN and OWNER_ID must be set. Copy .env.example to .env for local development.');
}

process.env.FFMPEG_PATH = ffmpegPath;

const DEFAULT_PREFIX = '!';
const DATA_FILE = path.join(__dirname, '..', 'data', 'guilds.json');
const queues = new Map();

function readSettings() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
const settings = readSettings();
function saveSettings() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(settings, null, 2));
}
function prefixFor(guildId) { return settings[guildId]?.prefix || DEFAULT_PREFIX; }
function setPrefix(guildId, prefix) { settings[guildId] = { ...(settings[guildId] || {}), prefix }; saveSettings(); }
function isOwner(userId) { return userId === process.env.OWNER_ID; }
function isAdmin(member) { return member?.permissions?.has(PermissionsBitField.Flags.Administrator); }
function canManage(member) { return isOwner(member?.id) || isAdmin(member); }

function makeQueue(guildId) {
  const player = createAudioPlayer();
  const queue = { guildId, player, connection: null, songs: [], current: null, loop: false, controller: null, textChannel: null, playing: false };
  player.on(AudioPlayerStatus.Idle, () => advance(queue));
  player.on('error', error => {
    console.error(`[${guildId}] audio player error:`, error.message);
    advance(queue);
  });
  queues.set(guildId, queue);
  return queue;
}
function getQueue(guildId) { return queues.get(guildId) || makeQueue(guildId); }

const formatDuration = seconds => {
  if (!seconds || seconds === Infinity) return 'Live';
  const s = Math.floor(seconds); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function playerEmbed(queue) {
  const song = queue.current;
  const accent = queue.playing ? 0x8b5cf6 : 0x64748b;
  const embed = new EmbedBuilder().setColor(accent).setTitle(queue.playing ? '♫ Now Playing' : '♫ Music Controller').setTimestamp();
  if (!song) return embed.setDescription('Nothing is playing. Join a voice channel and use `play <song>` to begin.');
  embed.setDescription(`**[${song.title}](${song.url})**\nRequested by ${song.requestedBy}\n\`${formatDuration(song.duration)}\` • ${queue.loop ? '🔁 Loop enabled' : `${queue.songs.length} song(s) queued`}`);
  if (song.thumbnail) embed.setThumbnail(song.thumbnail);
  return embed;
}
function controls(queue) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:pause').setLabel(queue.playing ? 'Pause' : 'Resume').setEmoji(queue.playing ? '⏸️' : '▶️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Next').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:loop').setLabel('Loop').setEmoji('🔁').setStyle(queue.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
  );
}
async function refreshController(queue) {
  if (!queue.controller) return;
  try { await queue.controller.edit({ embeds: [playerEmbed(queue)], components: [controls(queue)] }); } catch { queue.controller = null; }
}
async function showController(queue) {
  if (!queue.textChannel) return;
  if (queue.controller) return refreshController(queue);
  queue.controller = await queue.textChannel.send({ embeds: [playerEmbed(queue)], components: [controls(queue)] });
}
async function connect(member, queue) {
  const voice = member.voice.channel;
  if (!voice) throw new Error('Join a voice channel first.');
  if (queue.connection && queue.connection.joinConfig.channelId !== voice.id) throw new Error('I am already playing in another voice channel.');
  if (!queue.connection) {
    queue.connection = joinVoiceChannel({ channelId: voice.id, guildId: voice.guild.id, adapterCreator: voice.guild.voiceAdapterCreator, selfDeaf: true });
    queue.connection.on(VoiceConnectionStatus.Disconnected, () => { queue.connection = null; });
    await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
    queue.connection.subscribe(queue.player);
  }
}
async function advance(queue) {
  if (queue.current && queue.loop) queue.songs.push(queue.current);
  queue.current = queue.songs.shift() || null;
  if (!queue.current) {
    queue.playing = false;
    await refreshController(queue);
    return;
  }
  try {
    const stream = await play.stream(queue.current.url, { quality: 2 });
    queue.player.play(createAudioResource(stream.stream, { inputType: stream.type }));
    queue.playing = true;
    await showController(queue);
  } catch (error) {
    console.error('Could not stream track:', error.message);
    queue.textChannel?.send(`Could not play **${queue.current.title}**; skipping it.`).catch(() => {});
    advance(queue);
  }
}
async function resolveSong(query, requestedBy) {
  let info;
  if (play.yt_validate(query) === 'video') info = await play.video_info(query);
  else {
    const found = await play.search(query, { limit: 1, source: { youtube: 'video' } });
    if (!found[0]) throw new Error('No results found for that search.');
    info = await play.video_info(found[0].url);
  }
  const details = info.video_details;
  return { title: details.title, url: details.url, duration: details.durationInSec, thumbnail: details.thumbnails?.[0]?.url, requestedBy };
}
function sameVoice(member, queue) { return !queue.connection || member.voice.channelId === queue.connection.joinConfig.channelId; }
function canControl(member, queue) { return canManage(member) || queue.current?.requesterId === member.id; }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
client.once('ready', () => console.log(`Ready as ${client.user.tag}`));

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const [raw, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = raw?.toLowerCase();
  if (!command) return;
  const queue = getQueue(message.guild.id);
  const reply = text => message.reply({ content: text, allowedMentions: { repliedUser: false } });
  try {
    if (command === 'help') return reply(`**Music:** \`${prefix}play\`, \`${prefix}pause\`, \`${prefix}resume\`, \`${prefix}skip\`, \`${prefix}stop\`, \`${prefix}loop\`, \`${prefix}queue\`, \`${prefix}nowplaying\`\n**Queue tools:** \`${prefix}remove <number>\`, \`${prefix}clear\`\n**Admin:** \`${prefix}prefix <new prefix>\``);
    if (command === 'prefix') {
      if (!canManage(message.member)) return reply('Only a server administrator can change this server’s prefix.');
      const next = args[0];
      if (!next || next.length > 5 || /\s/.test(next)) return reply('Use a non-space prefix up to 5 characters, e.g. `!prefix ?`.');
      setPrefix(message.guild.id, next);
      return reply(`This server’s prefix is now \`${next}\`.`);
    }
    if (command === 'ownerstatus' && isOwner(message.author.id)) return reply('Owner override is active. Your account bypasses all bot permission checks.');
    if (command === 'play' || command === 'p') {
      const query = args.join(' '); if (!query) return reply(`Usage: \`${prefix}play <song or YouTube URL>\``);
      await connect(message.member, queue); queue.textChannel = message.channel;
      const song = await resolveSong(query, message.author.toString()); song.requesterId = message.author.id;
      queue.songs.push(song); await reply(queue.current ? `Added **${song.title}** to the queue.` : `Loading **${song.title}**…`);
      if (!queue.current) await advance(queue);
      return;
    }
    if (command === 'queue' || command === 'q') {
      const lines = [queue.current ? `**Now:** [${queue.current.title}](${queue.current.url})` : '**Nothing playing**', ...queue.songs.slice(0, 10).map((s, i) => `\`${i + 1}.\` ${s.title}`)];
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle(`Queue • ${message.guild.name}`).setDescription(lines.join('\n'))] });
    }
    if (command === 'nowplaying' || command === 'np') return showController(queue);
    if (!sameVoice(message.member, queue)) return reply('Join my current voice channel to control music.');
    if (command === 'pause') { if (!canControl(message.member, queue)) return reply('Only the requester or a server administrator can do that.'); queue.player.pause(); queue.playing = false; await refreshController(queue); return reply('Paused.'); }
    if (command === 'resume') { if (!canControl(message.member, queue)) return reply('Only the requester or a server administrator can do that.'); queue.player.unpause(); queue.playing = true; await refreshController(queue); return reply('Resumed.'); }
    if (command === 'skip') { if (!canControl(message.member, queue)) return reply('Only the requester or a server administrator can do that.'); queue.loop = false; queue.player.stop(); return reply('Skipped.'); }
    if (command === 'loop') { if (!canControl(message.member, queue)) return reply('Only the requester or a server administrator can do that.'); queue.loop = !queue.loop; await refreshController(queue); return reply(`Loop is now ${queue.loop ? 'enabled' : 'disabled'}.`); }
    if (command === 'stop') { if (!canManage(message.member)) return reply('Only a server administrator can stop and clear the queue.'); queue.loop = false; queue.songs = []; queue.current = null; queue.player.stop(true); queue.connection?.destroy(); queue.connection = null; queue.playing = false; await refreshController(queue); return reply('Stopped playback and cleared the queue.'); }
    if (command === 'clear') { if (!canManage(message.member)) return reply('Only a server administrator can clear the queue.'); queue.songs = []; return reply('Queue cleared.'); }
    if (command === 'remove') { if (!canManage(message.member)) return reply('Only a server administrator can remove queued songs.'); const index = Number(args[0]) - 1; if (!Number.isInteger(index) || !queue.songs[index]) return reply('Provide a valid queued song number.'); const [removed] = queue.songs.splice(index, 1); return reply(`Removed **${removed.title}**.`); }
  } catch (error) { console.error(error); return reply(error.message || 'Something went wrong while handling that command.'); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || !interaction.customId.startsWith('music:') || !interaction.guild) return;
  const queue = getQueue(interaction.guild.id);
  if (!sameVoice(interaction.member, queue)) return interaction.reply({ content: 'Join my voice channel to use the controller.', ephemeral: true });
  if (!canControl(interaction.member, queue)) return interaction.reply({ content: 'Only the requester, a server administrator, or the owner can use these controls.', ephemeral: true });
  const action = interaction.customId.slice(6);
  if (action === 'pause') { if (queue.playing) { queue.player.pause(); queue.playing = false; } else { queue.player.unpause(); queue.playing = true; } }
  if (action === 'skip') { queue.loop = false; queue.player.stop(); }
  if (action === 'loop') queue.loop = !queue.loop;
  if (action === 'stop') { if (!canManage(interaction.member)) return interaction.reply({ content: 'Only a server administrator or the owner can stop playback.', ephemeral: true }); queue.loop = false; queue.songs = []; queue.current = null; queue.player.stop(true); queue.connection?.destroy(); queue.connection = null; queue.playing = false; }
  await interaction.deferUpdate(); await refreshController(queue);
});

http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', bot: client.user?.tag || 'starting' })); }).listen(process.env.PORT || 3000, () => console.log('Health server listening.'));
client.login(process.env.DISCORD_TOKEN);
