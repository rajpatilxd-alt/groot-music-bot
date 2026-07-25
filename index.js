const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// Store queues and connections
const queues = new Map();
const connections = new Map();
const players = new Map();

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

// Search YouTube
async function searchYouTube(query) {
    try {
        const result = await ytSearch(query);
        if (result && result.videos.length > 0) {
            return result.videos[0];
        }
        return null;
    } catch (error) {
        console.error('Search error:', error);
        return null;
    }
}

// Play song
async function playSong(guildId, message, video) {
    try {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('🔊 You must be in a voice channel!');
        }

        // Get or create connection
        let connection = connections.get(guildId);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: message.guild.voiceAdapterCreator,
            });
            connections.set(guildId, connection);

            // Wait for connection to be ready
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 20000);
                console.log('✅ Voice connection ready');
            } catch (error) {
                console.error('Voice connection timeout:', error);
                connection.destroy();
                connections.delete(guildId);
                return message.reply('❌ Failed to connect to voice channel!');
            }
        }

        // Create audio player
        const player = createAudioPlayer();
        players.set(guildId, player);

        // Get audio stream with better options
        const stream = ytdl(video.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            requestOptions: {
                maxRedirects: 5,
            },
        });

        // Create audio resource
        const resource = createAudioResource(stream, {
            inlineVolume: true,
        });
        resource.volume.setVolume(0.8);

        // Play
        player.play(resource);
        connection.subscribe(player);

        // Send embed
        const embed = new EmbedBuilder()
            .setTitle('🎵 Now Playing')
            .setDescription(`**[${video.title}](${video.url})**`)
            .setThumbnail(video.thumbnail || '')
            .setColor('#4ec76a')
            .addFields(
                { name: '👤 Artist', value: video.author?.name || 'Unknown', inline: true },
                { name: '⏱ Duration', value: video.duration?.timestamp || 'Unknown', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: `Requested by ${message.author.tag}` });

        await message.reply({ embeds: [embed] });

        // Handle player events
        player.on(AudioPlayerStatus.Idle, () => {
            console.log('Player idle, checking queue...');
            const queue = queues.get(guildId);
            if (queue && queue.length > 0) {
                const nextVideo = queue.shift();
                playSong(guildId, message, nextVideo);
            } else {
                // Disconnect after 30 seconds
                setTimeout(() => {
                    const currentPlayer = players.get(guildId);
                    if (currentPlayer && currentPlayer.state?.status === 'idle') {
                        const conn = connections.get(guildId);
                        if (conn) {
                            conn.destroy();
                            connections.delete(guildId);
                            players.delete(guildId);
                            queues.delete(guildId);
                            console.log('Disconnected due to inactivity');
                        }
                    }
                }, 30000);
            }
        });

        player.on('error', (error) => {
            console.error('Player error:', error);
            message.channel.send('❌ Error playing song! Please try again.');
            // Try to skip to next song
            const queue = queues.get(guildId);
            if (queue && queue.length > 0) {
                const nextVideo = queue.shift();
                playSong(guildId, message, nextVideo);
            }
        });

        // Handle connection errors
        connection.on('error', (error) => {
            console.error('Connection error:', error);
        });

    } catch (error) {
        console.error('Play error:', error);
        message.reply('❌ Error playing song! Please try again.');
    }
}

client.once('ready', () => {
    console.log(`🌳 Groot is online as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    client.user.setActivity('🎵 !play', { type: 2 });
});

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
            const searchingMsg = await message.reply(`🔍 Searching for: **${query}**...`);

            // Check if it's a YouTube URL
            let video = null;
            if (ytdl.validateURL(query)) {
                const info = await ytdl.getInfo(query);
                video = {
                    url: query,
                    title: info.videoDetails.title,
                    thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || '',
                    author: { name: info.videoDetails.author.name },
                    duration: { timestamp: info.videoDetails.lengthSeconds }
                };
            } else {
                // Search YouTube
                const result = await ytSearch(query);
                if (result && result.videos.length > 0) {
                    video = result.videos[0];
                }
            }

            if (!video) {
                await searchingMsg.delete();
                return message.reply('❌ No songs found! Try a different search term.');
            }

            await searchingMsg.delete();

            // Check if already playing
            const currentPlayer = players.get(message.guild.id);
            if (currentPlayer && currentPlayer.state?.status !== 'idle') {
                // Add to queue
                if (!queues.has(message.guild.id)) {
                    queues.set(message.guild.id, []);
                }
                queues.get(message.guild.id).push(video);
                return message.reply(`📋 Added to queue: **${video.title}**`);
            }

            // Play the song
            await playSong(message.guild.id, message, video);

        } catch (error) {
            console.error('Play error:', error);
            message.reply('❌ Error playing song! Please try again.');
        }
    }

    // ─── PAUSE ───────────────────────────────────────
    else if (command === 'pause') {
        const player = players.get(message.guild.id);
        if (!player) return message.reply('⏸ Nothing is playing!');
        if (player.state?.status === 'paused') return message.reply('⏸ Already paused!');
        player.pause();
        message.reply('⏸ Paused');
    }

    // ─── RESUME ──────────────────────────────────────
    else if (command === 'resume') {
        const player = players.get(message.guild.id);
        if (!player) return message.reply('▶ Nothing is playing!');
        if (player.state?.status !== 'paused') return message.reply('▶ Not paused!');
        player.unpause();
        message.reply('▶ Resumed');
    }

    // ─── SKIP ────────────────────────────────────────
    else if (command === 'skip') {
        const player = players.get(message.guild.id);
        if (!player) return message.reply('⏭ Nothing is playing!');
        player.stop();
        message.reply('⏭ Skipped');
    }

    // ─── STOP ────────────────────────────────────────
    else if (command === 'stop') {
        const player = players.get(message.guild.id);
        if (player) {
            player.stop();
            players.delete(message.guild.id);
        }
        const conn = connections.get(message.guild.id);
        if (conn) {
            conn.destroy();
            connections.delete(message.guild.id);
        }
        queues.delete(message.guild.id);
        message.reply('⏹ Stopped and cleared queue');
    }

    // ─── QUEUE ───────────────────────────────────────
    else if (command === 'queue' || command === 'q') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.length === 0) {
            return message.reply('📭 Queue is empty!');
        }
        
        const tracks = queue.map((t, i) => `${i+1}. ${t.title}`).slice(0, 10);
        const embed = new EmbedBuilder()
            .setTitle('📋 Queue')
            .setColor('#4ec76a')
            .setDescription(tracks.join('\n') || 'Empty')
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }

    // ─── SHUFFLE ─────────────────────────────────────
    else if (command === 'shuffle') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.length === 0) return message.reply('🔀 Queue is empty!');
        for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        message.reply('🔀 Shuffled queue');
    }

    // ─── NOW PLAYING ─────────────────────────────────
    else if (command === 'np' || command === 'nowplaying') {
        message.reply('🎵 Check the embed from the last !play command!');
    }

    // ─── LEAVE ──────────────────────────────────────
    else if (command === 'leave') {
        const player = players.get(message.guild.id);
        if (player) {
            player.stop();
            players.delete(message.guild.id);
        }
        const conn = connections.get(message.guild.id);
        if (conn) {
            conn.destroy();
            connections.delete(message.guild.id);
        }
        queues.delete(message.guild.id);
        message.reply('👋 Left voice channel');
    }

    // ─── SETPREFIX ──────────────────────────────────
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

    // ─── RESETPREFIX ────────────────────────────────
    else if (command === 'resetprefix') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ You need **Administrator** permissions!');
        }
        resetPrefix(message.guild.id);
        message.reply(`✅ Prefix reset to \`${process.env.DEFAULT_PREFIX || '!'}\``);
    }

    // ─── HELP ────────────────────────────────────────
    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🌳 Groot Commands')
            .setColor('#4ec76a')
            .addFields(
                { name: '🎵 Playback', value: '`play` `pause` `resume` `skip` `stop`', inline: true },
                { name: '📋 Queue', value: '`queue` `shuffle` `np`', inline: true },
                { name: '🔊 Control', value: '`leave`', inline: true },
                { name: '⚙️ Admin', value: '`setprefix` `resetprefix`', inline: true }
            )
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
