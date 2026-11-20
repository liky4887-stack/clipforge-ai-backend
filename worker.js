const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(execFile);

const url = process.argv[2];
const projectId = process.argv[3];

function extractVideoId(rawUrl) {
    try {
        if (rawUrl.includes('youtu.be/')) return rawUrl.split('youtu.be/')[1].split('?')[0];
        if (rawUrl.includes('youtube.com/watch')) return rawUrl.split('v=')[1].split('&')[0];
        if (rawUrl.includes('youtube.com/shorts/')) return rawUrl.split('shorts/')[1].split('?')[0];
        return rawUrl.split('?')[0].split('/').pop();
    } catch (e) { return null; }
}

const videoId = extractVideoId(url);
if (!videoId) {
    console.error("❌ FATAL: Invalid YouTube URL");
    process.exit(1);
}

const finalUrl = `https://www.youtube.com/watch?v=${videoId}`;
const workDir = path.join(__dirname, 'tmp');
const videoPath = path.join(workDir, `source_${projectId}.mp4`);
const clipsDir = path.join(workDir, 'clips');
const stateFile = path.join(workDir, 'jobState.json');
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

function updateState(stage, extra = {}) { 
    fs.writeFileSync(stateFile, JSON.stringify({ projectId, stage, ...extra })); 
    console.log(`[Worker] Stage: ${stage}`);
}
const execOptions = { maxBuffer: 1024 * 1024 * 20 };

async function run() {
    let rawClip = path.join(workDir, `raw_${projectId}.mp4`);
    let audioPath = path.join(workDir, `audio_${projectId}.wav`);
    let srtPath = `${audioPath}.srt`;
    let assPath = path.join(workDir, `captions_${projectId}.ass`);
    let finalClip = path.join(clipsDir, `final_${projectId}.mp4`);
    let metaPath = path.join(clipsDir, `meta_${projectId}.json`);

    try {
        // --- STAGE 1: DOWNLOAD ---
        updateState('downloading');
        console.log(`[Worker] Downloading: ${finalUrl}`);
        await execPromise('yt-dlp', [
            '--js-runtimes', 'node',
            '-f', 'bv*[height<=720]+ba/b[height<=720]',
            '--merge-output-format', 'mp4',
            '--force-overwrites',
            '-o', videoPath,
            finalUrl
        ], execOptions);

        // --- STAGE 2: ANALYZING (COMMENTS) ---
        updateState('analyzing');
        let viralTimestamp = 45; 
        try {
            const { Innertube } = require('youtubei.js');
            const yt = await Innertube.create({ generate_session_locally: true, cache: null });
            let comments = await yt.getComments(videoId);
            let timestamps = [];
            const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
            
            for (let page = 0; page < 2; page++) {
                for (const thread of comments.contents) {
                    if (thread.comment) {
                        const text = thread.comment.content.toString();
                        let match;
                        while ((match = timeRegex.exec(text)) !== null) {
                            let h = 0, m = 0, s = 0;
                            if (match[1]) { h = parseInt(match[1]); m = parseInt(match[2]); s = parseInt(match[3]); }
                            else { m = parseInt(match[2]); s = parseInt(match[3]); }
                            if (!isNaN(h) && !isNaN(m) && !isNaN(s)) timestamps.push((h * 3600) + (m * 60) + s);
                        }
                    }
                }
                if (!comments.has_continuation) break;
                try {
                    comments = await comments.getContinuation();
                } catch (e) {
                    console.log(`[Worker] Stopped fetching comments: ${e.message}`);
                    break;
                }
            }
            if (timestamps.length > 0) viralTimestamp = timestamps[0];
        } catch (e) {
            console.log(`[Worker] Comment scraping skipped: ${e.message}`);
        }
        
        const startTime = Math.max(0, viralTimestamp - 20);

        // Cut raw clip + ensure audio stream exists
        await execPromise('ffmpeg', ['-y', '-ss', startTime.toString(), '-i', videoPath, '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', rawClip], execOptions);

        // --- STAGE 3: TRANSCRIBING ---
        updateState('transcribing');
        // Extract 16kHz mono PCM WAV required by whisper.cpp
        await execPromise('ffmpeg', ['-y', '-i', rawClip, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', audioPath], execOptions);
        
        // Check audio size (must be > 1KB)
        if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
            throw new Error("Extracted audio is empty or too short.");
        }

        await execPromise(whisperPath, ['-m', modelPath, '-f', audioPath, '-osrt', '-nt', '-ml', '15'], execOptions);
        
        let srtText = "";
        if (fs.existsSync(srtPath)) srtText = fs.readFileSync(srtPath, 'utf8');
        
        // --- CHATGPT TITLE & BIO ---
        let clipTitle = "Viral Moment";
        let clipBio = "Check out this insane clip!";
        try {
            const plainText = srtText.replace(/\d+\n.*-->\s.*\n/g, '').trim();
            if (plainText.length > 10) {
                const { callChatGPT } = require('./chatgpt-bridge');
                const prompt = `Based on this transcript, generate a viral TikTok/Shorts Title (max 50 chars) and a Caption (max 100 chars). Format as JSON: {"title": "...", "caption": "..."}\n\nTranscript: ${plainText}`;
                const aiResponse = await callChatGPT(prompt);
                const parsed = JSON.parse(aiResponse.match(/\{.*\}/s)[0]);
                clipTitle = parsed.title || clipTitle;
                clipBio = parsed.caption || clipBio;
            }
        } catch (e) {
            console.log(`[Worker] ChatGPT fallback used.`);
        }
        fs.writeFileSync(metaPath, JSON.stringify({ title: clipTitle, bio: clipBio }));

        // --- STAGE 4: RENDERING ---
        updateState('rendering');
        let assEvents = '';
        if (srtText) {
            const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Impact,90,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
            srtText.split(/\n\s*\n/).forEach(block => {
                const lines = block.trim().split('\n');
                if (lines.length >= 3) {
                    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
                    if (timeMatch) {
                        const start = `${parseInt(timeMatch[1])}:${timeMatch[2]}:${timeMatch[3]}.${timeMatch[4].substring(0, 2)}`;
                        const end = `${parseInt(timeMatch[5])}:${timeMatch[6]}:${timeMatch[7]}.${timeMatch[8].substring(0, 2)}`;
                        assEvents += `Dialogue: 0,${start},${end},Default,,0,0,0,,${lines.slice(2).join(' ').toUpperCase()}\n`;
                    }
                }
            });
            fs.writeFileSync(assPath, assHeader + assEvents);
        }

        const filter = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=${assPath}`;
        const renderArgs = ['-y', '-i', rawClip, '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', finalClip];
        await execPromise('ffmpeg', renderArgs, execOptions);

        await new Promise(r => setTimeout(r, 1500));
        updateState('completed');
        process.exit(0);
    } catch (error) {
        console.error(`[Worker] FATAL ERROR:`, error.message);
        updateState('failed');
        process.exit(1);
    } finally {
        [audioPath, srtPath, assPath, rawClip, videoPath].forEach(f => {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
        });
    }
}
run();
