const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { YoutubeCommentDownloader, SORT_BY_POPULAR } = require('youtube-comment-downloader');
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

function updateState(stage) { 
    fs.writeFileSync(stateFile, JSON.stringify({ projectId, stage })); 
    console.log(`[Worker] Stage: ${stage}`);
}
const execOptions = { maxBuffer: 1024 * 1024 * 20 };

async function hasVideoStream(filePath) {
    try {
        const { stdout } = await execPromise('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', 
            '-show_entries', 'stream=codec_type', 
            '-of', 'default=noprint_wrappers=1:nokey=1', 
            filePath
        ]);
        return stdout.trim().toLowerCase().includes('video');
    } catch (e) {
        return false;
    }
}

async function getVideoDuration(filePath) {
    try {
        const { stdout } = await execPromise('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        const dur = parseFloat(stdout.trim());
        return isNaN(dur) ? 0 : dur;
    } catch (e) {
        return 0;
    }
}

async function run() {
    let rawClip = path.join(workDir, `raw_${projectId}.mp4`);
    let audioPath = path.join(workDir, `audio_${projectId}.wav`);
    let srtPath = `${audioPath}.srt`;
    let assPath = path.join(workDir, `captions_${projectId}.ass`);
    let finalClip = path.join(clipsDir, `final_${projectId}.mp4`);
    let metaPath = path.join(clipsDir, `meta_${projectId}.json`);

    try {
        // --- STAGE 1: DOWNLOAD (FORCE VIDEO + RETRY) ---
        updateState('downloading');
        console.log(`[Worker] Downloading video (forcing video stream, retrying): ${finalUrl}`);
        
        // Use bv*[height<=720]+ba/b[height<=720] to guarantee a video stream.
        // Add --retries and --fragment-retries to handle network truncation.
        await execPromise('yt-dlp', [
            '--js-runtimes', 'node',
            '--ffmpeg-location', '/data/data/com.termux/files/usr/bin/ffmpeg',
            '-f', 'bv*[height<=720]+ba/b[height<=720]',
            '--merge-output-format', 'mp4',
            '--force-overwrites',
            '--retries', '10',
            '--fragment-retries', '10',
            '-o', videoPath,
            finalUrl
        ], execOptions);

        // Verify download has a video stream
        if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 10000) {
            throw new Error("Downloaded file is missing or too small.");
        }
        const videoOk = await hasVideoStream(videoPath);
        if (!videoOk) {
            throw new Error("Downloaded file does not contain a video stream (possibly audio-only).");
        }
        console.log(`[Worker] Download verified. Size: ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB`);

        // --- STAGE 2: ANALYZING (COMMENTS) ---
        updateState('analyzing');
        let viralTimestamp = 45; 
        try {
            const downloader = new YoutubeCommentDownloader();
            const commentsIterator = downloader.getCommentsFromUrl(finalUrl, SORT_BY_POPULAR);
            
            let timestamps = [];
            const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
            let count = 0;
            for await (const comment of commentsIterator) {
                if (comment.text) {
                    let match;
                    while ((match = timeRegex.exec(comment.text)) !== null) {
                        let h = 0, m = 0, s = 0;
                        if (match[1]) { h = parseInt(match[1]); m = parseInt(match[2]); s = parseInt(match[3]); }
                        else { m = parseInt(match[2]); s = parseInt(match[3]); }
                        if (!isNaN(h) && !isNaN(m) && !isNaN(s)) timestamps.push((h * 3600) + (m * 60) + s);
                    }
                }
                if (++count >= 100) break;
            }
            if (timestamps.length > 0) viralTimestamp = timestamps[0];
            console.log(`[Worker] Found ${timestamps.length} timestamps in comments.`);
        } catch (e) {
            console.log(`[Worker] Comment scraping skipped: ${e.message}`);
        }
        
        const CLIP_LEN = 30;
        const sourceDuration = await getVideoDuration(videoPath);
        console.log(`[Worker] Source duration: ${sourceDuration.toFixed(1)}s`);

        let startTime = Math.max(0, viralTimestamp - 20);
        let cutLength = CLIP_LEN;

        if (sourceDuration > 0) {
            if (sourceDuration <= CLIP_LEN) {
                startTime = 0;
                cutLength = sourceDuration;
            } else if (startTime + CLIP_LEN > sourceDuration) {
                startTime = Math.max(0, sourceDuration - CLIP_LEN);
            }
        } else {
            console.log(`[Worker] WARNING: Could not determine duration; using default cut`);
        }

        // --- CUT RAW CLIP ---
        console.log(`[Worker] Cutting raw clip: start=${startTime.toFixed(1)}s, length=${cutLength.toFixed(1)}s (source=${sourceDuration.toFixed(1)}s)`);
        await execPromise('ffmpeg', [
            '-y',
            '-analyzeduration', '100M', '-probesize', '100M',
            '-i', videoPath,
            '-ss', startTime.toFixed(3),
            '-t', cutLength.toFixed(3),
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'ultrafast',
            '-c:a', 'aac',
            rawClip
        ], execOptions);

        // --- VERIFY RAW CLIP HAS VIDEO ---
        const rawVideoOk = await hasVideoStream(rawClip);
        if (!rawVideoOk) {
            const sz = fs.existsSync(rawClip) ? fs.statSync(rawClip).size : 0;
            throw new Error(`Raw clip has no video stream after cutting (size=${sz}B, start=${startTime.toFixed(1)}s, len=${cutLength.toFixed(1)}s, source=${sourceDuration.toFixed(1)}s)`);
        }

        // --- STAGE 3: TRANSCRIBING ---
        updateState('transcribing');
        
        const hasAudio = await execPromise('ffprobe', [
            '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', rawClip
        ]).then(r => r.stdout.trim().toLowerCase().includes('audio')).catch(() => false);

        let srtText = "";
        
        if (hasAudio) {
            console.log(`[Worker] Audio stream found. Extracting for Whisper...`);
            await execPromise('ffmpeg', [
                '-y',
                '-analyzeduration', '100M', '-probesize', '100M',
                '-i', rawClip,
                '-map', '0:a:0',
                '-vn',
                '-acodec', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',
                audioPath
            ], execOptions);

            if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
                await execPromise(whisperPath, ['-m', modelPath, '-f', audioPath, '-osrt', '-nt', '-ml', '15'], execOptions);
                if (fs.existsSync(srtPath)) srtText = fs.readFileSync(srtPath, 'utf8');
            }
        } else {
            console.log(`[Worker] WARNING: No audio stream found. Skipping transcription.`);
        }

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
        const renderArgs = [
            '-y',
            '-analyzeduration', '100M', '-probesize', '100M',
            '-i', rawClip,
            '-vf', filter,
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23',
            '-c:a', 'aac',
            finalClip
        ];
        await execPromise('ffmpeg', renderArgs, execOptions);

        // Generate thumbnail
        const thumbPath = path.join(clipsDir, `thumb_${projectId}.jpg`);
        try {
            console.log(`[Worker] Generating thumbnail...`);
            await execPromise('ffmpeg', [
                '-y', '-i', finalClip, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', thumbPath
            ], execOptions);
        } catch (e) {
            console.log(`[Worker] Thumbnail generation skipped: ${e.message}`);
        }

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
