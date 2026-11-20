const tmi = require('tmi.js');
const { exec } = require('child_process');

// CONFIGURATION
const TWITCH_CHANNEL = 'xqc'; // Change this to whoever you are monitoring
const SPIKE_THRESHOLD = 15;   // Number of messages in X seconds to trigger a clip
const TIME_WINDOW_MS = 5000;  // 5 seconds
const COOLDOWN_MS = 30000;    // Don't clip again for 30 seconds after a clip

let messageTimestamps = [];
let lastClipTime = 0;

// Connect to Twitch anonymously
const client = new tmi.Client({
    connection: { secure: true, reconnect: true },
    channels: [ TWITCH_CHANNEL ]
});

client.connect();

client.on('message', (channel, tags, message, self) => {
    if (self) return;

    const now = Date.now();
    messageTimestamps.push(now);

    // Filter out messages older than our time window
    messageTimestamps = messageTimestamps.filter(ts => now - ts <= TIME_WINDOW_MS);

    // Check if we hit a spike
    if (messageTimestamps.length >= SPIKE_THRESHOLD) {
        if (now - lastClipTime > COOLDOWN_MS) {
            lastClipTime = now;
            console.log(`\n🚨 CHAT SPIKE DETECTED in #${TWITCH_CHANNEL}! ${messageTimestamps.length} msgs in 5s.`);
            
            // Trigger a clip (This would normally call your download pipeline)
            triggerClip(TWITCH_CHANNEL);
            
            // Reset the array so it doesn't keep triggering
            messageTimestamps = [];
        }
    }
});

function triggerClip(channel) {
    console.log(`🎬 Triggering yt-dlp to download the last 60 seconds of https://twitch.tv/${channel}...`);
    
    // In a real pipeline, you'd grab the live stream m3u8 and clip the last 60 seconds.
    // For testing, we will just run a fake command or download the live stream.
    const dummyCommand = `echo "Command executed: yt-dlp --live-from-start https://twitch.tv/${channel}"`;
    
    exec(dummyCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Error: ${error.message}`);
            return;
        }
        console.log(stdout);
    });
}

console.log(`📡 Monitoring #${TWITCH_CHANNEL} chat for spikes... (Threshold: ${SPIKE_THRESHOLD} msgs / 5s)`);
