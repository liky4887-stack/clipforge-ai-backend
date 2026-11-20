const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory database for tracking jobs
const jobs = {};

// 1. Start a new clip project
app.post('/api/clip-projects', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "YouTube URL is required" });

    const projectId = Date.now().toString();
    jobs[projectId] = {
        id: projectId,
        url: url,
        status: 'processing',
        progress: 10,
        clips: []
    };

    // Trigger the background processing script
    console.log(`🚀 Starting job ${projectId} for URL: ${url}`);
    
    // We pass the URL and Project ID to our worker script
    // NOTE: We will need to update our worker script to accept these arguments
    exec(`node worker.js "${url}" "${projectId}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Job ${projectId} failed:`, error);
            jobs[projectId].status = 'failed';
            return;
        }
        console.log(`✅ Job ${projectId} finished`);
        jobs[projectId].status = 'completed';
        jobs[projectId].progress = 100;
    });

    res.json({ projectId, message: "Job started successfully" });
});

// 2. Poll job progress
app.get('/api/cluster-jobs/:projectId/progress', (req, res) => {
    const job = jobs[req.params.projectId];
    if (!job) return res.status(404).json({ error: "Job not found" });

    res.json({ 
        projectId: job.id, 
        status: job.status, 
        progress: job.progress 
    });
});

// 3. Get exportable clips
app.get('/api/exportable-clips', (req, res) => {
    const { projectId } = req.query;
    const job = jobs[projectId];
    
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== 'completed') return res.status(400).json({ error: "Job not finished yet" });

    // Read the clips directory to find the generated files
    const clipsDir = path.join(__dirname, 'tmp', 'clips');
    let files = [];
    if (fs.existsSync(clipsDir)) {
        files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4'));
    }

    // Map them to local HTTP URLs so the mobile app can stream them
    const clipUrls = files.map(file => ({
        filename: file,
        url: `http://localhost:3000/clips/${file}`
    }));

    res.json({ clips: clipUrls });
});

// Serve the actual video files statically
app.use('/clips', express.static(path.join(__dirname, 'tmp', 'clips')));

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🎬 ClipForge API running on http://localhost:${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- POST http://localhost:${PORT}/api/clip-projects`);
    console.log(`- GET  http://localhost:${PORT}/api/cluster-jobs/:projectId/progress`);
    console.log(`- GET  http://localhost:${PORT}/api/exportable-clips?projectId={id}\n`);
});
