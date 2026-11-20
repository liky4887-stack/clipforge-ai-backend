const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

const url = process.argv[2];
const projectId = process.argv[3];

// Extract video ID from URL
const videoIdMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
const videoId = videoIdMatch ? videoIdMatch[1] : null;

if (!videoId) {
    console.error("❌ Invalid YouTube URL");
    process.exit(1);
}

const workDir = path.join(__dirname, 'tmp');
const videoPath = path.join(workDir, 'source.mp4');
const clipsDir = path.join(workDir, 'clips');

// We clear old clips for this demo so we don't mix projects
if (fs.existsSync(clipsDir)) fs.rmSync(clipsDir, { recursive: true, force: true });
fs.mkdirSync(clipsDir, { recursive: true });

async function run() {
    try {
        console.log(`[Worker ${projectId}] Downloading source video...`);
        await execPromise(`yt-dlp --js-runtimes node -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 --remux-video mp4 -o "${videoPath}" "${url}"`);

        // NOTE: For the API test, we are just doing a basic 15-second cut. 
        // We will hook up the youtubei.js comment scraper later.
        console.log(`[Worker ${projectId}] Slicing test clips...`);
        const out1 = path.join(clipsDir, `final_project_${projectId}_clip1.mp4`);
        const out2 = path.join(clipsDir, `final_project_${projectId}_clip2.mp4`);
        
        // Cut a 15 second clip from the start
        await execPromise(`ffmpeg -y -ss 0 -i "${videoPath}" -t 15 -c:v libx264 -pix_fmt yuv420p -c:a aac "${out1}"`);
        // Cut a 15 second clip from 1 minute in
        await execPromise(`ffmpeg -y -ss 60 -i "${videoPath}" -t 15 -c:v libx264 -pix_fmt yuv420p -c:a aac "${out2}"`);

        console.log(`[Worker ${projectId}] Success!`);
    } catch (error) {
        console.error(`[Worker ${projectId}] Error:`, error.message);
        process.exit(1);
    }
}

run();
