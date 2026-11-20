const { Innertube } = require('youtubei.js');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

const workDir = path.join(__dirname, 'tmp');
const videoId = '1La4QzGeaaQ'; 
const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
const videoPath = path.join(workDir, 'source.mp4');
const clipsDir = path.join(workDir, 'clips');
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir);

// Helper to convert SRT to ASS
function srtToAss(srtPath, assPath) {
    const srt = fs.readFileSync(srtPath, 'utf8');
    const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

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
                const start = `${parseInt(timeMatch[1])}:${timeMatch[2]}:${timeMatch[3]}.${timeMatch[4].substring(0, 2)}`;
                const end = `${parseInt(timeMatch[5])}:${timeMatch[6]}:${timeMatch[7]}.${timeMatch[8].substring(0, 2)}`;
                const text = lines.slice(2).join(' ').toUpperCase();
                const animatedText = `{\\fad(100,100)\\t(0,100,\\fscx120\\fscy120)}${text}`;
                assEvents += `Dialogue: 0,${start},${end},Default,,0,0,0,,${animatedText}\n`;
            }
        }
    });
    fs.writeFileSync(assPath, assHeader + assEvents);
}

// 1. Fetch comments
async function fetchComments(id) {
    console.log("💬 Fetching comments...");
    const yt = await Innertube.create();
    let comments = await yt.getComments(id);
    let parsedComments = [];
    let page = 1;
    while (page <= 5) {
        for (const thread of comments.contents) {
            if (thread.comment) parsedComments.push({ text: thread.comment.content.toString() });
        }
        if (!comments.has_continuation) break;
        comments = await comments.getContinuation();
        page++;
    }
    console.log(`✅ Total comments fetched: ${parsedComments.length}`);
    return parsedComments;
}

// 2. Parse timestamps
function parseTimestamps(comments) {
    const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
    const timestamps = [];
    comments.forEach(c => {
        let match;
        while ((match = timeRegex.exec(c.text)) !== null) {
            let h = 0, m = 0, s = 0;
            if (match[1]) { h = parseInt(match[1]); m = parseInt(match[2]); s = parseInt(match[3]); }
            else { m = parseInt(match[2]); s = parseInt(match[3]); }
            timestamps.push({ raw: match[0], seconds: (h * 3600) + (m * 60) + s, text: c.text });
        }
    });
    console.log(`✅ Found ${timestamps.length} timestamps in comments.`);
    return timestamps;
}

// 3. Cut and Caption
async function createClips(timestamps) {
    if (!fs.existsSync(videoPath)) {
        console.log("📥 Downloading source video...");
        await execPromise(`yt-dlp --js-runtimes node -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 --remux-video mp4 -o "${videoPath}" "${videoUrl}"`);
    }

    const clipsToMake = timestamps.slice(0, 3);
    for (let i = 0; i < clipsToMake.length; i++) {
        const ts = clipsToMake[i];
        const start = Math.max(0, ts.seconds - 20);
        const safeText = ts.text.substring(0, 15).replace(/[^a-z0-9]/gi, '_');
        const rawClip = path.join(clipsDir, `raw_${i}_${safeText}.mp4`);
        const finalClip = path.join(clipsDir, `final_${i}_${safeText}.mp4`);
        const audioPath = path.join(workDir, `audio_${i}.wav`);
        const srtPath = `${audioPath}.srt`;
        const assPath = path.join(workDir, `captions_${i}.ass`);

        console.log(`✂️ Cutting raw clip ${i + 1}/${clipsToMake.length} (from ${start}s)...`);
        // FIXED: Added -pix_fmt yuv420p for Android compatibility
        await execPromise(`ffmpeg -y -ss ${start} -i "${videoPath}" -t 40 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 23 -preset fast -c:a aac "${rawClip}"`);

        console.log(`🎙️ Transcribing and adding captions to clip ${i + 1}...`);
        await execPromise(`ffmpeg -y -i "${rawClip}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`);
        
        await execPromise(`${whisperPath} -m "${modelPath}" -f "${audioPath}" -osrt -nt -ml 15`);
        
        srtToAss(srtPath, assPath);

        console.log(`🎬 Rendering final captioned clip ${i + 1}...`);
        // FIXED: Added -pix_fmt yuv420p for Android compatibility
        await execPromise(`ffmpeg -y -i "${rawClip}" -vf "subtitles=${assPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 23 -preset fast -c:a aac "${finalClip}"`);

        fs.unlinkSync(rawClip);
        fs.unlinkSync(audioPath);
        fs.unlinkSync(srtPath);
        fs.unlinkSync(assPath);
    }
    console.log(`✅ All captioned clips created in: ${clipsDir}`);
}

async function main() {
    try {
        const comments = await fetchComments(videoId);
        const timestamps = parseTimestamps(comments);
        if (timestamps.length > 0) {
            await createClips(timestamps);
        } else {
            console.log("⚠️ No timestamps found.");
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}
main();
