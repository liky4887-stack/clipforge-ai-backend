const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

// Helper function to convert SRT to an animated ASS file
function srtToAss(srtPath, assPath) {
    const srt = fs.readFileSync(srtPath, 'utf8');
    
    // ASS Header for a TikTok/GhostEdit style
    const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,80,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    let assEvents = '';
    const blocks = srt.split(/\n\s*\n/);

    blocks.forEach(block => {
        const lines = block.trim().split('\n');
        if (lines.length >= 3) {
            const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
            if (timeMatch) {
                // Convert SRT time to ASS time (H:MM:SS.cc)
                const start = `${parseInt(timeMatch[1])}:${timeMatch[2]}:${timeMatch[3]}.${timeMatch[4].substring(0, 2)}`;
                const end = `${parseInt(timeMatch[5])}:${timeMatch[6]}:${timeMatch[7]}.${timeMatch[8].substring(0, 2)}`;
                const text = lines.slice(2).join(' ').toUpperCase(); // Uppercase looks better for shorts
                
                // This is the magic: \fad (fade) and \t (transform) for a bounce effect
                const animatedText = `{\\fad(100,100)\\t(0,100,\\fscx120\\fscy120)}${text}`;
                assEvents += `Dialogue: 0,${start},${end},Default,,0,0,0,,${animatedText}\n`;
            }
        }
    });

    fs.writeFileSync(assPath, assHeader + assEvents);
}

async function processVideo(url) {
    const workDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

    const videoPath = path.join(workDir, 'video.mp4');
    const audioPath = path.join(workDir, 'audio.wav');
    const srtPath = path.join(workDir, 'audio.wav.srt'); 
    const assPath = path.join(workDir, 'captions.ass'); 
    const outputPath = path.join(workDir, 'final_clip.mp4');
    
    const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
    const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

    try {
        console.log("🧹 Cleaning up old files...");
        await execPromise(`rm -f "${workDir}"/*`);

        console.log("📥 Downloading video...");
        await execPromise(`yt-dlp -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 --remux-video mp4 --js-runtimes node -o "${videoPath}" "${url}"`);

        console.log("🎵 Extracting audio...");
        await execPromise(`ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`);

        console.log("🎙️ Transcribing audio (generating SRT)...");
        const cmd = `${whisperPath} -m "${modelPath}" -f "${audioPath}" -osrt -nt -ml 15`; // -ml 15 limits text to 15 chars per line
        await execPromise(cmd);

        console.log("✨ Converting SRT to Animated ASS captions...");
        srtToAss(srtPath, assPath);

        console.log("🎬 Rendering final clip with FFmpeg (Captions + Silence Removal)...");
        // Using the new .ass file and the silence removal filter
        const ffmpegRenderCmd = `ffmpeg -y -i "${videoPath}" -vf "subtitles=${assPath}" -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-50dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-50dB" -c:v libx264 -crf 23 -preset fast -c:a aac "${outputPath}"`;
        
        await execPromise(ffmpegRenderCmd);

        console.log(`\n✅ PIPELINE COMPLETE! Open your new clip at: ${outputPath}`);
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
processVideo(testUrl);
