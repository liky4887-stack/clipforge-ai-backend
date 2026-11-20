const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

async function processVideo(url) {
    const workDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

    const audioPath = path.join(workDir, 'audio.wav');
    const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
    const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

    try {
        // 1. Download audio from YouTube (Added --js-runtimes node)
        console.log("📥 Downloading audio from YouTube...");
        await execPromise(`yt-dlp -x --audio-format wav --js-runtimes node -o "${audioPath}" "${url}"`);
        console.log("✅ Download complete.");

        // 2. Transcribe using whisper.cpp
        console.log("🎙️ Transcribing audio with whisper.cpp...");
        const cmd = `${whisperPath} -m "${modelPath}" -f "${audioPath}" -otxt -nt`;
        await execPromise(cmd);
        
        const transcriptPath = `${audioPath}.txt`;
        const transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
        
        console.log("\n✅ TRANSCRIPTION COMPLETE:\n");
        console.log(transcript);

        // Clean up
        fs.unlinkSync(audioPath);
        fs.unlinkSync(transcriptPath);

        return transcript;
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

// Testing with the first YouTube video ever ("Me at the zoo", 19 seconds long)
const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
console.log(`Starting pipeline for: ${testUrl}`);
processVideo(testUrl);
