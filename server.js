const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const jobs = {};

// 1. Start a new clip project
app.post('/api/clip-projects', (req, res) => {
    console.log("📥 Received Create Project Payload:", req.body); 
    
    const finalUrl = req.body.videoUrl || req.body.url || req.body.sourceUrl;
    if (!finalUrl) return res.status(400).json({ error: "YouTube URL is required" });

    const projectId = Date.now().toString();
    jobs[projectId] = {
        id: projectId,
        title: "New Clip Project",
        status: 'processing',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    console.log(`🚀 Starting job ${projectId} for URL: ${finalUrl}`);
    
    exec(`node worker.js "${finalUrl}" "${projectId}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Job ${projectId} failed:`, error);
            jobs[projectId].status = 'failed';
            return;
        }
        console.log(`✅ Job ${projectId} finished`);
        jobs[projectId].status = 'completed';
    });

    res.json(jobs[projectId]);
});

// 2. Get all projects
app.get('/api/clip-projects', (req, res) => {
    res.json({ projects: Object.values(jobs) });
});

// 3. Poll job progress (STRICT STATE MACHINE)
app.get('/api/cluster-jobs/:projectId/progress', (req, res) => {
    const job = jobs[req.params.projectId];
    if (!job) return res.status(404).json({ error: "Job not found" });

    const stateFile = path.join(__dirname, 'tmp', 'jobState.json');
    let currentStage = 'downloading';
    let progress = 10;

    // Read actual stage from the worker
    if (fs.existsSync(stateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (state.projectId === job.id) {
                currentStage = state.stage;
                if (currentStage === 'downloading') progress = 20;
                else if (currentStage === 'transcribing') progress = 50;
                else if (currentStage === 'rendering') progress = 80;
                else if (currentStage === 'completed') progress = 100;
                else if (currentStage === 'failed') progress = 0;
            }
        } catch (e) { /* ignore read errors during write */ }
    }

    // Define the stages exactly as the App expects
    const stages = [
        { key: 'downloading', label: 'Downloading', status: 'pending' },
        { key: 'transcribing', label: 'Transcribing', status: 'pending' },
        { key: 'rendering', label: 'Rendering', status: 'pending' }
    ];

    // Update statuses based on current stage
    const stageIndex = stages.findIndex(s => s.key === currentStage);
    stages.forEach((s, i) => {
        if (i < stageIndex) s.status = 'completed';
        else if (i === stageIndex) s.status = 'active';
    });

    if (currentStage === 'completed') {
        stages.forEach(s => s.status = 'completed');
    }

    res.json({ 
        projectId: job.id, 
        status: job.status, 
        progress: progress,
        currentStage: currentStage,
        stages: stages
    });
});

// 4. Get exportable clips
app.get('/api/exportable-clips', (req, res) => {
    const { projectId } = req.query;
    const job = jobs[projectId];
    
    if (!job) return res.status(404).json({ error: "Job not found" });

    const clipsDir = path.join(__dirname, 'tmp', 'clips');
    let files = [];
    if (fs.existsSync(clipsDir)) {
        files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4'));
    }

    const clipUrls = files.map((file, index) => ({
        id: `clip-${index}`,
        projectId: projectId,
        title: `Viral Clip ${index + 1}`,
        viralityScore: 95,
        durationMs: 30000,
        thumbnailUrl: `http://192.168.43.101:3000/clips/${file}`,
        videoUrl: `http://192.168.43.101:3000/clips/${file}`,
        shareUrl: null
    }));

    res.json({ clips: clipUrls });
});

// 5. STUBS for Preflight
app.post('/api/source-videos', (req, res) => {
    res.json({ videoId: "mock-video-id-123", status: "valid" });
});
app.post('/api/upload-links-v2', (req, res) => {
    res.json({ uploadUrl: "http://dummy-upload-url.com", videoUrl: "http://dummy-video-url.com" });
});

app.use('/clips', express.static(path.join(__dirname, 'tmp', 'clips')));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎬 ClipForge API running on http://192.168.43.101:${PORT}`);
});
