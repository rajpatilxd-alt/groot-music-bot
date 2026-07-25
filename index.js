const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const { YoutubeiExtractor } = require('discord-player-youtubei');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// Create client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// Create player
const player = new Player(client, {
    ytdlOptions: {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        filter: 'audioonly',
    }
});

// Register YouTube extractor
async function registerExtractors() {
    try {
        await player.extractors.register(YoutubeiExtractor, {});
        console.log('✅ YouTube extractor registered');
        return true;
    } catch (error) {
        console.error('❌ Failed to register YouTube extractor:', error);
        return false;
    }
}

// Store prefixes
let prefixes = {};
try {
    if (fs.existsSync('./prefixes.json')) {
        prefixes = JSON.parse(fs.readFileSync('./prefixes.json'));
    }
} catch (e) {
    console.log('No saved prefixes found');
}

function savePrefixes() {
    fs.writeFileSync('./prefixes.json', JSON.stringify(prefixes, null, 2));
}

function getPrefix(guildId) {
    return prefixes[guildId] || process.env.DEFAULT_PREFIX || '!';
}

function setPrefix(guildId, newPrefix) {
    if (newPrefix.length > 3) return false;
    prefixes[guildId] = newPrefix;
    savePrefixes();
    return true;
}

function resetPrefix(guildId) {
    delete prefixes[guildId];
    savePrefixes();
    return true;
}

// Ready event
client.once('ready', async () => {
    console.log(`🌳 Groot is online as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    client.user.setActivity('🎵 !play', { type: 2 });
    await registerExtractors();
});

// Message handler
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const prefix = getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ─── PLAY COMMAND ──────────────────────────────
    if (command === 'play' || command === 'p') {
        if (!message.member.voice.channel) {
            return message.reply('🔊 You must be in a voice channel!');
        }

        const query = args.join(' ');
        if (!query) {
            return message.reply(`❌ Usage: ${prefix}play <song name or URL>`);
        }

        try {
            await message.reply(`🔍 Searching for: **${query}**...`);

            // Search for the song
            const result = await player.search(query, {
                requestedBy: message.author,
                searchEngine: QueryType.AUTO,
            });

            if (!result || !result.tracks.length) {
                return message.reply('❌ No songs found! Try a different search term.');
            }

            const track = result.tracks[0];
            
            // Play the track
            const queue = await player.play(message.member.voice.channel, track, {
                nodeOptions: {
                    metadata: message,
                    volume: 80,
                    leaveOnEmpty: true,
                    leaveOnEnd: false,
                },
            });

            // Create embed
            const embed = new EmbedBuilder()
                .setTitle('🎵 Now Playing')
                .setDescription(`**[${track.title}](${track.url || '#'})**`)
                .setThumbnail(track.thumbnail || '')
                .setColor('#4ec76a')
                .addFields(
                    { name: '👤 Artist', value: track.author || 'Unknown', inline: true },
                    { name: '⏱ Duration', value: track.duration || 'Unknown', inline: true },
                    { name: '📡 Source', value: track.source || 'YouTube', inline: true }
                )
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.tag}` });

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Play error:', error);
            message.reply(`❌ Error playing song! Please try again.`);
        }
    }

    // ─── PAUSE COMMAND ─────────────────────────────
    else if (command === 'pause') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.isPlaying()) return message.reply('⏸ Nothing is playing!');
        if (queue.node.isPaused()) return message.reply('⏸ Already paused!');
        queue.node.pause();
        message.reply('⏸ Paused');
    }

    // ─── RESUME COMMAND ────────────────────────────
    else if (command === 'resume') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.isPlaying()) return message.reply('▶ Nothing is playing!');
        if (!queue.node.isPaused()) return message.reply('▶ Not paused!');
        queue.node.resume();
        message.reply('▶ Resumed');
    }

    // ─── SKIP COMMAND ──────────────────────────────
    else if (command === 'skip') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.isPlaying()) return message.reply('⏭ Nothing is playing!');
        queue.node.skip();
        message.reply('⏭ Skipped');
    }

    // ─── STOP COMMAND ──────────────────────────────
    else if (command === 'stop') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue) return message.reply('⏹ Nothing is playing!');
        queue.delete();
        message.reply('⏹ Stopped and cleared queue');
    }

    // ─── QUEUE COMMAND ─────────────────────────────
    else if (command === 'queue' || command === 'q') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue) return message.reply('📭 Queue is empty!');
        
        const tracks = queue.tracks.map((t, i) => `${i+1}. ${t.title}`).slice(0, 10);
        const embed = new EmbedBuilder()
            .setTitle('📋 Queue')
            .setColor('#4ec76a')
            .addFields(
                { name: 'Now Playing', value: queue.currentTrack?.title || 'None' },
                { name: 'Up Next', value: tracks.join('\n') || 'Empty' }
            )
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    // ─── VOLUME COMMAND ────────────────────────────
    else if (command === 'volume' || command === 'vol') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue) return message.reply('🔊 No music playing!');
        
        if (!args.length) return message.reply(`🔊 Current volume: ${queue.node.volume}%`);
        
        const vol = parseInt(args[0]);
        if (isNaN(vol) || vol < 0 || vol > 100) {
            return message.reply('🔊 Volume must be 0-100');
        }
        queue.node.setVolume(vol);
        message.reply(`🔊 Volume set to ${vol}%`);
    }

    // ─── LOOP COMMAND ──────────────────────────────
    else if (command === 'loop') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.isPlaying()) return message.reply('🔄 Nothing is playing!');
        
        const modes = ['off', 'track', 'queue'];
        const current = queue.repeatMode;
        const next = (current + 1) % 3;
        queue.setRepeatMode(next);
        message.reply(`🔁 Loop mode: ${modes[next]}`);
    }

    // ─── SHUFFLE COMMAND ───────────────────────────
    else if (command === 'shuffle') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.tracks.size) return message.reply('🔀 Queue is empty!');
        queue.tracks.shuffle();
        message.reply('🔀 Shuffled queue');
    }

    // ─── NOW PLAYING COMMAND ───────────────────────
    else if (command === 'np' || command === 'nowplaying') {
        const queue = player.nodes.get(message.guild.id);
        if (!queue || !queue.isPlaying()) return message.reply('🎵 Nothing is playing!');
        
        const track = queue.currentTrack;
        const embed = new EmbedBuilder()
            .setTitle('🎵 Now Playing')
            .setDescription(`**[${track.title}](${track.url || '#'})**`)
            .setThumbnail(track.thumbnail || '')
            .setColor('#4ec76a')
            .addFields(
                { name: 'Artist', value: track.author || 'Unknown', inline: true },
                { name: 'Duration', value: track.duration || 'Unknown', inline: true }
            )
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    // ─── LEAVE COMMAND ─────────────────────────────
    else if (command === 'leave') {
        const queue = player.nodes.get(message.guild.id);
        if (queue) queue.delete();
        const vc = message.guild.members.me?.voice?.channel;
        if (vc) {
            await vc.leave();
            message.reply('👋 Left voice channel');
        } else {
            message.reply('👋 Not in a voice channel');
        }
    }

    // ─── SETPREFIX COMMAND (Admin only) ────────────
    else if (command === 'setprefix') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ You need **Administrator** permissions!');
        }
        
        if (!args.length) {
            return message.reply(`📝 Current prefix: \`${getPrefix(message.guild.id)}\``);
        }
        
        const newPrefix = args[0];
        if (newPrefix.length > 3) {
            return message.reply('❌ Prefix must be 1-3 characters');
        }
        
        setPrefix(message.guild.id, newPrefix);
        message.reply(`✅ Prefix changed to \`${newPrefix}\``);
    }

    // ─── RESETPREFIX COMMAND (Admin only) ──────────
    else if (command === 'resetprefix') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ You need **Administrator** permissions!');
        }
        
        resetPrefix(message.guild.id);
        message.reply(`✅ Prefix reset to \`${process.env.DEFAULT_PREFIX || '!'}\``);
    }

    // ─── HELP COMMAND ──────────────────────────────
    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🌳 Groot Commands')
            .setColor('#4ec76a')
            .addFields(
                { name: '🎵 Playback', value: '`play` `pause` `resume` `skip` `stop`', inline: true },
                { name: '📋 Queue', value: '`queue` `shuffle` `loop` `np`', inline: true },
                { name: '🔊 Control', value: '`volume` `leave`', inline: true },
                { name: '⚙️ Admin', value: '`setprefix` `resetprefix`', inline: true },
                { name: '👑 Owner', value: '`sudo`', inline: true }
            )
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }
});

// Login
client.login(process.env.DISCORD_TOKEN);

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
