const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

const url = process.argv[2];
const projectId = process.argv[3];

const workDir = path.join(__dirname, 'tmp');
const videoPath = path.join(workDir, 'source.mp4');
const clipsDir = path.join(workDir, 'clips');
const stateFile = path.join(workDir, 'jobState.json');
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

// Helper to update progress state
function updateState(stage) {
    fs.writeFileSync(stateFile, JSON.stringify({ projectId, stage }));
}

// Helper to convert SRT to ASS (TikTok Style)
function srtToAss(srtPath, assPath) {
    const srt = fs.readFileSync(srtPath, 'utf8');
    const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,90,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    let assEvents = '';
    srt.split(/\n\s*\n/).forEach(block => {
        const lines = block.trim().split('\n');
        if (lines.length >= 3) {
            const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
            if (timeMatch) {
                const start = `${parseInt(timeMatch[1])}:${timeMatch[2]}:${timeMatch[3]}.${timeMatch[4].substring(0, 2)}`;
                const end = `${parseInt(timeMatch[5])}:${timeMatch[6]}:${timeMatch[7]}.${timeMatch[8].substring(0, 2)}`;
                const text = lines.slice(2).join(' ').toUpperCase();
                const animatedText = `{\\fad(50,50)\\t(0,100,\\fscx110\\fscy110)}${text}`;
                assEvents += `Dialogue: 0,${start},${end},Default,,0,0,0,,${animatedText}\n`;
            }
        }
    });
    fs.writeFileSync(assPath, assHeader + assEvents);
}

async function run() {
    try {
        // --- STAGE 1: DOWNLOAD ---
        updateState('downloading');
        console.log(`[Worker ${projectId}] Downloading source video...`);
        await execPromise(`yt-dlp --js-runtimes node -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 --remux-video mp4 -o "${videoPath}" "${url}"`);

        // --- STAGE 2: TRANSCRIBE ---
        updateState('transcribing');
        console.log(`[Worker ${projectId}] Transcribing audio...`);
        const audioPath = path.join(workDir, 'audio.wav');
        const srtPath = `${audioPath}.srt`;
        const assPath = path.join(workDir, 'captions.ass');
        
        await execPromise(`ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`);
        await execPromise(`${whisperPath} -m "${modelPath}" -f "${audioPath}" -osrt -nt -ml 15`);
        srtToAss(srtPath, assPath);

        // --- STAGE 3: RENDER ---
        updateState('rendering');
        console.log(`[Worker ${projectId}] Rendering vertical TikTok clips...`);
        
        const finalClip = path.join(clipsDir, `final_project_${projectId}_clip1.mp4`);
        
        // This filter_complex creates the blurred background + vertical crop + burns captions
        const filter = `[0:v]split=2[fg][bg];` +
                       `[fg]crop=ih*9/16:ih,scale=1080:1920[fgcrop];` +
                       `[bg]scale=1080:1920,boxblur=20:20[bgblur];` +
                       `[bgblur][fgcrop]overlay=(W-w)/2:(H-h)/2,subtitles=${assPath}[v]`;

        // Render a 30-second clip from the start
        await execPromise(`ffmpeg -y -ss 0 -i "${videoPath}" -t 30 -filter_complex "${filter}" -map "[v]" -map 0:a -c:v libx264 -pix_fmt yuv420p -crf 23 -preset fast -c:a aac "${finalClip}"`);

        // Cleanup temp files
        fs.unlinkSync(audioPath);
        fs.unlinkSync(srtPath);
        fs.unlinkSync(assPath);

        // --- STAGE 4: COMPLETE ---
        updateState('completed');
        console.log(`[Worker ${projectId}] Success!`);

    } catch (error) {
        updateState('failed');
        console.error(`[Worker ${projectId}] Error:`, error.message);
        process.exit(1);
    }
}

run();
