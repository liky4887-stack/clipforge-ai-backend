const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { YoutubeCommentDownloader, SORT_BY_POPULAR } = require('youtube-comment-downloader');
const execPromise = util.promisify(execFile);
const { probeAI, pickTimestampWithAI } = require('./ai-curation');

const url = process.argv[2];
const projectId = process.argv[3];
const aspectRatio = process.argv[4] || '9:16';
const clipLengthSec = parseInt(process.argv[5]) || 30;
const enableCaption = process.argv[6] !== '0';
const workerIndex = parseInt(process.argv[7]) || 0;
const totalWorkers = parseInt(process.argv[8]) || 1;
const customPrompt = process.env.CF_CUSTOM_PROMPT || '';
const genre = process.env.CF_GENRE || 'Auto';
const enableAutoHook = process.env.CF_ENABLE_AUTO_HOOK === '1';

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
const stateFile = path.join(workDir, `state_${projectId}.json`);
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

if (enableCaption) {
    if (!fs.existsSync(whisperPath)) {
        console.error(`❌ FATAL: whisper-cli missing at ${whisperPath}`);
        process.exit(1);
    }
    if (!fs.existsSync(modelPath)) {
        console.error(`❌ FATAL: whisper model missing at ${modelPath}`);
        process.exit(1);
    }
}

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

async function getSpeechSegments(audioPath) {
    try {
        const { stdout: durStr } = await execPromise('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], execOptions);
        const duration = parseFloat(durStr.trim());

        let stderrOutput = '';
        try {
            const result = await execPromise('ffmpeg', ['-i', audioPath, '-af', 'silencedetect=noise=-42dB:d=0.3', '-f', 'null', '-'], execOptions);
            stderrOutput = result.stderr || '';
        } catch (e) {
            if (e.stderr) stderrOutput = e.stderr;
        }

        const silences = [];
        let currentSilenceStart = null;
        const lines = stderrOutput.split('\n');
        for (const line of lines) {
            const startM = line.match(/silence_start: ([0-9.]+)/);
            if (startM) currentSilenceStart = parseFloat(startM[1]);
            const endM = line.match(/silence_end: ([0-9.]+)/);
            if (endM && currentSilenceStart !== null) {
                silences.push({ start: currentSilenceStart, end: parseFloat(endM[1]) });
                currentSilenceStart = null;
            }
        }
        if (currentSilenceStart !== null) {
            silences.push({ start: currentSilenceStart, end: duration });
        }

        const speechSegments = [];
        let lastEnd = 0;
        for (const s of silences) {
            if (s.start > lastEnd) {
                speechSegments.push({ start: lastEnd, end: s.start });
            }
            lastEnd = s.end;
        }
        if (lastEnd < duration) {
            speechSegments.push({ start: lastEnd, end: duration });
        }
        return speechSegments;
    } catch (err) {
        console.log(`[Worker] FFmpeg VAD error: ${err.message}`);
        return [{ start: 0, end: 9999999 }];
    }
}

async function run() {
    let rawClip = path.join(workDir, `raw_${projectId}.mp4`);
    let audioPath = path.join(workDir, `audio_${projectId}.wav`);
    let assPath = path.join(workDir, `captions_${projectId}.ass`);
    let finalClip = path.join(clipsDir, `final_${projectId}.mp4`);
    let metaPath = path.join(clipsDir, `meta_${projectId}.json`);

    function cleanup() {
        [audioPath, path.join(workDir, `audio_${projectId}_trimmed.wav`), assPath, rawClip, videoPath].forEach(f => {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
        });
    }

    try {
        updateState('downloading');
        console.log(`[Worker] Downloading video: ${finalUrl}`);

        await execPromise('yt-dlp', [
            '--js-runtimes', 'node',
            '--ffmpeg-location', process.env.FFMPEG_PATH || '/data/data/com.termux/files/usr/bin/ffmpeg',
            '-f', 'bv*[height<=720]+ba/b[height<=720]',
            '--merge-output-format', 'mp4',
            '--force-overwrites',
            '--retries', '10',
            '--fragment-retries', '10',
            '-o', videoPath,
            finalUrl
        ], execOptions);

        if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 10000) {
            throw new Error("Downloaded file is missing or too small.");
        }
        const videoOk = await hasVideoStream(videoPath);
        if (!videoOk) throw new Error("Downloaded file does not contain a video stream.");
        console.log(`[Worker] Download verified. Size: ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB`);

        updateState('analyzing');
        let viralTimestamp = 45 + workerIndex * 60;
        try {
            const downloader = new YoutubeCommentDownloader();
            const commentsIterator = downloader.getCommentsFromUrl(finalUrl, SORT_BY_POPULAR);
            let timestamps = [];
            const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
            let count = 0;
            for await (const comment of commentsIterator) {
                if (comment.text) {
                    timeRegex.lastIndex = 0;
                    let match;
                    while ((match = timeRegex.exec(comment.text)) !== null) {
                        let h = 0, m = 0, s = 0;
                        if (match[1]) { h = parseInt(match[1]); m = parseInt(match[2]); s = parseInt(match[3]); }
                        else { m = parseInt(match[2]); s = parseInt(match[3]); }
                        if (!isNaN(h) && !isNaN(m) && !isNaN(s)) timestamps.push({ ts: (h * 3600) + (m * 60) + s, text: (comment.text || '').slice(0, 200) });
                    }
                }
                if (++count >= 100) break;
            }
            if (timestamps.length > 0) {
                const unique = [...new Set(timestamps.map(t => t.ts))].sort((a, b) => a - b);
                viralTimestamp = unique[workerIndex] !== undefined
                    ? unique[workerIndex]
                    : 45 + workerIndex * 60;
                console.log(`[Worker #${workerIndex}/${totalWorkers}] ts=${viralTimestamp}s (${timestamps.length} hits, ${unique.length} unique)`);
            } else {
                viralTimestamp = 45 + workerIndex * 60;
                console.log(`[Worker #${workerIndex}/${totalWorkers}] no comments — fallback ${viralTimestamp}s`);
            }
        } catch (e) {
            console.log(`[Worker] Comment scraping skipped: ${e.message}`);
        }

        if (await probeAI()) {
            viralTimestamp = await pickTimestampWithAI(timestamps, customPrompt, genre, viralTimestamp);
        }
        console.log(`[Worker #${workerIndex}/${totalWorkers}] FINAL ts=${viralTimestamp}s`);
        const CLIP_LEN = clipLengthSec;
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
        }

        console.log(`[Worker] Cutting raw clip: start=${startTime.toFixed(1)}s, length=${cutLength.toFixed(1)}s`);
        await execPromise('ffmpeg', [
            '-y',
            '-analyzeduration', '100M', '-probesize', '100M',
            '-i', videoPath,
            '-ss', startTime.toFixed(3),
            '-t', cutLength.toFixed(3),
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-r', '30',
            '-c:a', 'aac', '-ar', '44100',
            rawClip
        ], execOptions);

        const rawVideoOk = await hasVideoStream(rawClip);
        if (!rawVideoOk) throw new Error("Raw clip has no video stream after cutting.");

        updateState('transcribing');

        const hasAudio = await execPromise('ffprobe', [
            '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', rawClip
        ]).then(r => r.stdout.trim().toLowerCase().includes('audio')).catch(() => false);

        let plainText = "";

        if (hasAudio && enableCaption) {
            console.log(`[Worker] Audio stream found. Extracting for Whisper...`);
            await execPromise('ffmpeg', [
                '-y', '-analyzeduration', '100M', '-probesize', '100M',
                '-i', rawClip, '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', audioPath
            ], execOptions);

            if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
                console.log("[Worker] 🎤 Running FFmpeg silencedetect to find speech boundaries...");
                const speechSegments = await getSpeechSegments(audioPath);
                console.log(`[Worker] VAD detected ${speechSegments.length} speech segments.`);

                const { stdout: durStr } = await execPromise('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], execOptions);
                const audioDuration = parseFloat(durStr.trim());

                let trimStart = 0;
                let trimEnd = audioDuration;
                if (speechSegments.length > 0) {
                    trimStart = Math.max(0, speechSegments[0].start - 0.1);
                    trimEnd = Math.min(audioDuration, speechSegments[speechSegments.length - 1].end + 0.05);
                }

                let trimmedAudioPath = audioPath;
                let timeOffsetMs = 0;

                if (trimStart > 0.05 || trimEnd < audioDuration - 0.05) {
                    trimmedAudioPath = path.join(workDir, `audio_${projectId}_trimmed.wav`);
                    await execPromise('ffmpeg', [
                        '-y', '-i', audioPath,
                        '-ss', trimStart.toFixed(3), '-to', trimEnd.toFixed(3),
                        '-acodec', 'pcm_s16le', trimmedAudioPath
                    ], execOptions);
                    timeOffsetMs = trimStart * 1000;
                    console.log(`[Worker] ✂️ Trimmed audio to ${trimStart.toFixed(2)}s - ${trimEnd.toFixed(2)}s.`);
                }

                await execPromise(whisperPath, ['-m', modelPath, '-f', trimmedAudioPath, '-ojf', '-nt', '-ml', '15', '-mc', '0'], execOptions);

                const whisperJsonPath = `${trimmedAudioPath}.json`;
                if (fs.existsSync(whisperJsonPath)) {
                    const whisperData = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf8'));
                    plainText = (whisperData.transcription || []).map(s => s.text).join(" ").trim();

                    const allTokens = [];

                    for (const wseg of whisperData.transcription || []) {
                        for (const t of wseg.tokens || []) {
                            const text = t.text;
                            if (text.startsWith('[') && text.endsWith(']')) continue;
                            if (text.startsWith('<|') && text.endsWith('|>')) continue;
                            if (!text.trim()) continue;
                            if (!t.offsets) continue;

                            let wStart = t.offsets.from + timeOffsetMs;
                            let wEnd = t.offsets.to + timeOffsetMs;
                            const wCenter = (wStart + wEnd) / 2;

                            // Find the speech segment that contains the CENTER of this word
                            let bestSeg = null;
                            for (const seg of speechSegments) {
                                const sStart = seg.start * 1000;
                                const sEnd = seg.end * 1000;
                                // Allow 150ms padding at edges to keep boundary words
                                if (wCenter >= sStart - 150 && wCenter <= sEnd + 150) {
                                    bestSeg = seg;
                                    break;
                                }
                            }

                            if (!bestSeg) continue; // Drop if fully outside speech

                            const sStart = bestSeg.start * 1000;
                            const sEnd = bestSeg.end * 1000;

                            // Hard clamp to the actual FFmpeg segment
                            if (wStart < sStart) wStart = sStart; // only clamp start
                            // (removed) do not clamp wEnd to segment end — Fix C caps to clip length
                            if (wEnd <= wStart) {
                                const wordLen = Math.max(1, text.trim().length);
                                wEnd = wStart + Math.min(120, wordLen * 40);
                            }

                            allTokens.push({ text: text.trim(), start: wStart, end: wEnd });
                        }
                    }

                    // Prevent overlaps
                    for (let i = 0; i < allTokens.length - 1; i++) {
                        if (allTokens[i].end > allTokens[i + 1].start) {
                            allTokens[i].end = Math.max(allTokens[i].start + 30, allTokens[i + 1].start);
                        }
                    }

                    // ── SAFETY: no caption can outlive the video ──
                    const rawClipDurationMs = Math.round(cutLength * 1000);
                    for (let i = allTokens.length - 1; i >= 0; i--) {
                        const tok = allTokens[i];
                        if (tok.start >= rawClipDurationMs - 10) { allTokens.splice(i, 1); continue; }
                        if (tok.end > rawClipDurationMs - 10) tok.end = rawClipDurationMs - 10;
                    }

                    let assEvents = '';
                    const BS = String.fromCharCode(92);

                    function formatTime(ms) {
                        const h = Math.floor(ms / 3600000);
                        const m = Math.floor((ms % 3600000) / 60000);
                        const s = Math.floor((ms % 60000) / 1000);
                        const cs = Math.floor((ms % 1000) / 10);
                        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
                    }

                    let currentPhrase = [];
                    let phraseStart = 0;

                    function emitPhrase() {
                        if (currentPhrase.length === 0) return;
                        const phraseEnd = currentPhrase[currentPhrase.length - 1].end;
                        // 1. Base event: whole phrase in base colour
                        const baseText = currentPhrase.map(w => w.text).join(' ');
                        assEvents += `Dialogue: 0,${formatTime(phraseStart)},${formatTime(phraseEnd)},Default,,0,0,0,,${baseText}\n`;
                        // 2. Active events: one per word, highlighted colour (PeakCut approach)
                        for (const w of currentPhrase) {
                            assEvents += `Dialogue: 1,${formatTime(w.start)},${formatTime(w.end)},Default,,0,0,0,,{\\c&HCCCCCC&}${w.text}\n`;
                        }
                        currentPhrase = [];
                    }

                    for (let i = 0; i < allTokens.length; i++) {
                        const w = allTokens[i];
                        const prevWord = currentPhrase[currentPhrase.length - 1];

                        if (prevWord) {
                            const gap = w.start - prevWord.end;
                            const endsPunct = /[.,!?]$/.test(prevWord.text);
                            const duration = w.end - currentPhrase[0].start;

                            // Break on sentence ends or long pauses (8 words / 800 ms)
                            if (currentPhrase.length >= 8 || gap > 800 || (endsPunct && currentPhrase.length >= 3) || duration > 5000) {
                                emitPhrase();
                            }
                        }
                        if (currentPhrase.length === 0) phraseStart = w.start;
                        currentPhrase.push(w);
                    }
                    emitPhrase();

                    let outW = 1080, outH = 1920;
                    if (aspectRatio === '1:1') { outW = 1080; outH = 1080; }
                    else if (aspectRatio === '16:9') { outW = 1920; outH = 1080; }

                    const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${outW}\nPlayResY: ${outH}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Impact,80,&H0000FFFF,&H00CCCCCC,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

                    fs.writeFileSync(assPath, assHeader + assEvents);
                    if (process.env.DEBUG_KEEP_ASS === '1') { try { fs.writeFileSync(path.join(clipsDir, 'captions_' + projectId + '.ass'), assHeader + assEvents); console.log('[Worker] ASS debug copy saved'); } catch(e) {} }
                    console.log(`[Worker] ✅ Generated ${assEvents.split('\n').filter(x => x.trim()).length} caption groups.`);
                }
            }
        }

        let clipTitle = "Viral Moment";
        let clipBio = "Check out this insane clip!";
        try {
            if (plainText.length > 10) {
                const { callChatGPT } = require('./chatgpt-bridge');
                const prompt = `Based on this transcript, generate a viral TikTok/Shorts title (max 50 chars) and a caption (max 100 chars). Return ONLY valid JSON with keys "title" and "caption". Both values must be real, specific content drawn from the transcript — never "..." or placeholder text, never repeating this instruction.\n\nTranscript: ${plainText}`;
                const aiResponse = await callChatGPT(prompt);
                const parsed = JSON.parse(aiResponse.match(/\{.*\}/s)[0]);
                const cleanTitle = String(parsed.title || '').trim();
                const cleanBio = String(parsed.caption || parsed.bio || '').trim();
                const isPlaceholder = (s) => !s || /^\.+$/.test(s) || s.toLowerCase().includes('placeholder') || s.toLowerCase().includes('your title') || s.toLowerCase().includes('caption here');
                if (!isPlaceholder(cleanTitle)) clipTitle = cleanTitle.slice(0, 80);
                if (!isPlaceholder(cleanBio)) clipBio = cleanBio.slice(0, 150);
            }
        } catch (e) {
            console.log(`[Worker] ChatGPT fallback used.`);
        }
        fs.writeFileSync(metaPath, JSON.stringify({ title: clipTitle, bio: clipBio }));

        updateState('rendering');

        let outW = 1080, outH = 1920;
        if (aspectRatio === '1:1') { outW = 1080; outH = 1080; }
        else if (aspectRatio === '16:9') { outW = 1920; outH = 1080; }

        const useSubtitles = enableCaption && fs.existsSync(assPath) && fs.statSync(assPath).size > 100;
        const filter = useSubtitles
            ? `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},subtitles=${assPath}`
            : `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;

        console.log(`[Worker] Rendering with subtitles: ${useSubtitles}`);
        await execPromise('ffmpeg', [
            '-y',
            '-analyzeduration', '100M', '-probesize', '100M',
            '-i', rawClip,
            '-vf', filter,
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '23', '-r', '30',
            '-c:a', 'aac',
            finalClip
        ], execOptions);

        try { const _d = await getVideoDuration(finalClip); const _m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); _m.durationMs = Math.round(_d * 1000); fs.writeFileSync(metaPath, JSON.stringify(_m)); } catch (e) {}
          const thumbPath = path.join(clipsDir, `thumb_${projectId}.jpg`);
        try {
            console.log(`[Worker] Generating thumbnail...`);
            await execPromise('ffmpeg', [
                '-y', '-i', finalClip, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', thumbPath
            ], execOptions);
        } catch (e) {
            console.log(`[Worker] Thumbnail generation skipped: ${e.message}`);
        }

                updateState('completed');
        cleanup(); process.exit(0);
    } catch (error) {
        console.error(`[Worker] FATAL ERROR:`, error.message);
        updateState('failed'); cleanup();
        process.exit(1);
    } finally {
        [audioPath, path.join(workDir, `audio_${projectId}_trimmed.wav`), assPath, rawClip, videoPath, stateFile].forEach(f => {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
        });
    }
}
run();
