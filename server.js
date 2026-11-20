const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite');
const { callChatGPT } = require('./chatgpt-bridge');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);
const app = express();
app.use(cors());
app.use(express.json());

// Serve generated clips as static files
const clipsDir = path.join(__dirname, 'clips');
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir);
app.use('/clips', express.static(clipsDir));

// Initialize Database
const db = new DatabaseSync('./clipforge.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    deviceId TEXT,
    status TEXT,
    videoUrl TEXT,
    curationPref TEXT,
    clips TEXT
  )
`);

// 1. Create Project Endpoint (Triggers the FULL Pipeline)
app.post('/api/clip-projects', async (req, res) => {
  const { videoUrl, curationPref } = req.body;
  const projectId = 'proj_' + Math.random().toString(36).substr(2, 9);
  const deviceId = req.headers['x-device-id'] || 'anonymous';

  const stmt = db.prepare('INSERT INTO projects (id, deviceId, status, videoUrl, curationPref, clips) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(projectId, deviceId, 'processing', videoUrl, JSON.stringify(curationPref), '[]');
  
  console.log(`\n[NEW PROJECT] Created ${projectId}`);
  res.json({ id: projectId, status: 'processing' });

  // Run the pipeline in the background
  runPipeline(projectId, videoUrl, curationPref);
});

async function runPipeline(projectId, videoUrl, curationPref) {
  const workDir = path.join(__dirname, 'tmp', projectId);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  
  const videoPath = path.join(workDir, 'source.mp4');
  const audioPath = path.join(workDir, 'audio.wav');
  const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
  const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');

  try {
    // 1. Download Video & Audio
    console.log(`[Pipeline] Downloading video...`);
    await execPromise(`yt-dlp --js-runtimes node -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" -o "${videoPath}" "${videoUrl}"`);
    await execPromise(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}" -y`);
    
    // 2. Transcribe
    console.log(`[Pipeline] Transcribing audio...`);
    await execPromise(`${whisperPath} -m "${modelPath}" -f "${audioPath}" -otxt -nt -osrt`);
    const transcript = fs.readFileSync(`${audioPath}.txt`, 'utf8').trim();
    const srtPath = `${audioPath}.srt`;
    console.log(`[Pipeline] Transcript ready: "${transcript.substring(0, 50)}..."`);

    // 3. Ask ChatGPT for the best clip
    console.log(`[Pipeline] Asking ChatGPT for the best moments...`);
    const prompt = `
      You are an expert video editor. Here is a transcript of a video:
      "${transcript}"
      
      The user wants clips based on this instruction: "${curationPref?.customPrompt || 'Find the most engaging moment'}"
      
      Return ONLY a valid JSON array (no markdown, no extra text) with exactly 1 clip object matching this exact structure:
      [{"title": "Catchy Title", "viralityScore": 90, "start_time": 0, "end_time": 10}]
      The start_time and end_time must be in seconds (integers).
    `;
    const aiResponse = await callChatGPT(prompt);
    const cleanJson = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const clipsData = JSON.parse(cleanJson);

    // 4. Render the clip with FFmpeg
    const generatedClips = [];
    for (let i = 0; i < clipsData.length; i++) {
        const clip = clipsData[i];
        const outFileName = `${projectId}_clip${i}.mp4`;
        const outFilePath = path.join(clipsDir, outFileName);
        
        console.log(`[Pipeline] Rendering clip: ${clip.title} (${clip.start_time}s - ${clip.end_time}s)`);
        
        // This FFmpeg command cuts, crops to 9:16 (TikTok), scales, and burns in subtitles (optional)
        const ffmpegCmd = `ffmpeg -ss ${clip.start_time} -to ${clip.end_time} -i "${videoPath}" -vf "crop=ih*9/16:ih,scale=1080:1920" -c:v libx264 -crf 23 -c:a aac -movflags +faststart "${outFilePath}" -y`;
        await execPromise(ffmpegCmd);

        // Add the local URL to the clip object
        clip.id = `clip_${i}`;
        clip.duration = clip.end_time - clip.start_time;
        clip.url = `http://192.168.43.101:3000/clips/${outFileName}`; // Change to your phone's IP
        clip.thumbnail = `https://picsum.photos/400/700?random=${i}`; // Placeholder
        generatedClips.push(clip);
    }

    // 5. Update Database
    const updateStmt = db.prepare('UPDATE projects SET status = ?, clips = ? WHERE id = ?');
    updateStmt.run('completed', JSON.stringify(generatedClips), projectId);
    console.log(`[Pipeline] PROJECT ${projectId} COMPLETED SUCCESSFULLY!`);

    // Cleanup temp files (keep video for a bit, remove audio)
    fs.unlinkSync(audioPath);
    fs.unlinkSync(`${audioPath}.txt`);
    fs.unlinkSync(srtPath);

  } catch (error) {
    console.error(`[Pipeline ERROR] for ${projectId}:`, error.message);
    const failStmt = db.prepare('UPDATE projects SET status = ? WHERE id = ?');
    failStmt.run('failed', projectId);
  }
}

// 2. Poll Progress Endpoint
app.get('/api/cluster-jobs/:projectId/progress', (req, res) => {
  const stmt = db.prepare('SELECT status FROM projects WHERE id = ?');
  const project = stmt.get(req.params.projectId);
  
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.status === 'completed') {
    return res.json({ projectId: req.params.projectId, status: 'completed', stage: 'Finished', progress: 100 });
  }
  if (project.status === 'failed') {
    return res.json({ projectId: req.params.projectId, status: 'failed', stage: 'AI Error', progress: 0 });
  }

  res.json({ projectId: req.params.projectId, status: 'processing', stage: 'AI is working its magic...', progress: 50 });
});

// 3. Fetch Clips Endpoint
app.get('/api/exportable-clips', (req, res) => {
  const { projectId } = req.query;
  const stmt = db.prepare('SELECT clips FROM projects WHERE id = ?');
  const project = stmt.get(projectId);
  
  if (!project || project.status !== 'completed') {
    return res.json({ clips: [] });
  }
  res.json({ clips: JSON.parse(project.clips) });
});

// 4. Get Projects List
app.get('/api/clip-projects', (req, res) => {
  const deviceId = req.headers['x-device-id'] || 'anonymous';
  const stmt = db.prepare('SELECT * FROM projects WHERE deviceId = ? ORDER BY rowid DESC');
  const projects = stmt.all(deviceId);
  res.json(projects.map(p => ({ ...p, curationPref: JSON.parse(p.curationPref || '{}'), clips: JSON.parse(p.clips || '[]') })));
});

// Start Server
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ClipForge Backend running on http://localhost:${PORT}`);
  console.log(`🧠 AI Brain connected to Freebie on port 8001`);
});
