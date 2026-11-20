const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { Innertube } = require('youtubei.js');
const { callChatGPT } = require('./chatgpt-bridge'); // Import your ChatGPT bridge
const execPromise = util.promisify(execFile);

const url = process.argv[2];
const projectId = process.argv[3];

function cleanYouTubeUrl(rawUrl) {
    try {
        if (rawUrl.includes('youtu.be/')) return `https://www.youtube.com/watch?v=${rawUrl.split('youtu.be/')[1].split('?')[0]}`;
        if (rawUrl.includes('youtube.com/watch')) return `https://www.youtube.com/watch?v=${rawUrl.split('v=')[1].split('&')[0]}`;
        return rawUrl;
    } catch (e) { return rawUrl; }
}

const finalUrl = cleanYouTubeUrl(url);
const videoId = finalUrl.split('v=')[1];
const workDir = path.join(__dirname, 'tmp');
const videoPath = path.join(workDir, 'source.mp4');
const clipsDir = path.join(workDir, 'clips');
const stateFile = path.join(workDir, 'jobState.json');
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

function updateState(stage) { 
    fs.writeFileSync(stateFile, JSON.stringify({ projectId, stage })); 
    console.log(`[Worker] Stage: ${stage}`);
}
const execOptions = { maxBuffer: 1024 * 1024 * 20 };

async function run() {
    try {
        // --- STAGE 1: DOWNLOAD ---
        updateState('downloading');
        await execPromise('yt-dlp', ['--js-runtimes', 'node', '-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', videoPath, finalUrl], execOptions);

        // --- STAGE 2: AI ANALYSIS (COMMENTS) ---
        updateState('analyzing');
        console.log(`[Worker] Scraping comments for viral moments...`);
        let viralTimestamp = 60; 
        try {
            const yt = await Innertube.create();
            let comments = await yt.getComments(videoId);
            let timestamps = [];
            const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;

            for (let page = 0; page < 3; page++) {
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
                comments = await comments.getContinuation();
            }
            if (timestamps.length > 0) {
                viralTimestamp = timestamps[0];
                console.log(`[Worker] Viral moment found: ${viralTimestamp}s`);
            }
        } catch (e) {
            console.log(`[Worker] Comment scraping failed, using default time.`);
        }

        const startTime = Math.max(0, viralTimestamp - 20);
        const rawClip = path.join(workDir, `raw_${projectId}.mp4`);
        const audioPath = path.join(workDir, `audio_${projectId}.wav`);
        const srtPath = `${audioPath}.srt`;
        const assPath = path.join(workDir, `captions_${projectId}.ass`);
        const finalClip = path.join(clipsDir, `final_${projectId}.mp4`);
        const metaPath = path.join(clipsDir, `meta_${projectId}.json`);

        await execPromise('ffmpeg', ['-y', '-ss', startTime.toString(), '-i', videoPath, '-t', '40', '-c', 'copy', rawClip], execOptions);

        // --- STAGE 3: TRANSCRIBE ---
        updateState('transcribing');
        await execPromise('ffmpeg', ['-y', '-i', rawClip, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', audioPath], execOptions);
        await execPromise(whisperPath, ['-m', modelPath, '-f', audioPath, '-osrt', '-nt', '-ml', '15'], execOptions);
        
        // Read transcript for ChatGPT
        const srtText = fs.readFileSync(srtPath, 'utf8');
        const plainText = srtText.replace(/\d+\n.*-->\s.*\n/g, '').trim();
        
        // --- CHATGPT TITLE & BIO ---
        console.log(`[Worker] Asking ChatGPT for Title and Caption...`);
        let clipTitle = "Viral Moment";
        let clipBio = "Check out this insane moment!";
        try {
            const prompt = `Based on this transcript, generate a viral TikTok/Shorts Title (max 50 chars) and a Caption (max 100 chars). Format as JSON: {"title": "...", "caption": "..."}\n\nTranscript: ${plainText}`;
            const aiResponse = await callChatGPT(prompt);
            const parsed = JSON.parse(aiResponse.match(/\{.*\}/s)[0]);
            clipTitle = parsed.title || clipTitle;
            clipBio = parsed.caption || clipBio;
        } catch (e) {
            console.log(`[Worker] ChatGPT generation failed, using defaults.`);
        }

        // Save Metadata
        fs.writeFileSync(metaPath, JSON.stringify({ title: clipTitle, bio: clipBio }));

        // Convert SRT to ASS
        const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Impact,90,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
        let assEvents = '';
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

        // --- STAGE 4: RENDER ---
        updateState('rendering');
        const filter = `[0:v]split=2[fg][bg];[fg]crop=ih*9/16:ih,scale=1080:1920[fgcrop];[bg]scale=540:960,boxblur=10:5,scale=1080:1920[bgblur];[bgblur][fgcrop]overlay=(W-w)/2:(H-h)/2,subtitles=${assPath}[v]`;
        await execPromise('ffmpeg', ['-y', '-i', rawClip, '-filter_complex', filter, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', finalClip], execOptions);

        // Cleanup temp files but KEEP meta.json and final.mp4
        fs.unlinkSync(audioPath);
        fs.unlinkSync(srtPath);
        fs.unlinkSync(assPath);
        fs.unlinkSync(rawClip);

        // Wait 1 second to ensure file write is flushed to disk
        await new Promise(r => setTimeout(r, 1000));

        updateState('completed');
        process.exit(0);

    } catch (error) {
        updateState('failed');
        console.error(`[Worker] FATAL ERROR:`, error.message);
        process.exit(1);
    }
}
run();
