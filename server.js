const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const jobsFile = path.join(__dirname, 'jobs.json');
let jobs = {};

// Load saved jobs on startup
if (fs.existsSync(jobsFile)) {
    try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch (e) {}
}

function saveJobs() {
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
}

app.post('/api/clip-projects', (req, res) => {
    const finalUrl = req.body.videoUrl || req.body.url || req.body.sourceUrl;
    if (!finalUrl) return res.status(400).json({ error: "YouTube URL is required" });

    const projectId = Date.now().toString();
    jobs[projectId] = { id: projectId, title: "New Clip", status: 'processing', createdAt: new Date().toISOString() };
    saveJobs();

    const stateFile = path.join(__dirname, 'tmp', 'jobState.json');
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

    const worker = execFile('node', ['worker.js', finalUrl, projectId], { maxBuffer: 1024 * 1024 * 20 });
    worker.stdout.pipe(process.stdout);
    worker.stderr.pipe(process.stderr);

    worker.on('exit', (code) => {
        jobs[projectId].status = (code === 0) ? 'completed' : 'failed';
        saveJobs();
    });

    res.json(jobs[projectId]);
});

app.get('/api/clip-projects', (req, res) => res.json({ projects: Object.values(jobs) }));

app.get('/api/cluster-jobs/:projectId/progress', (req, res) => {
    const job = jobs[req.params.projectId];
    if (!job) return res.status(404).json({ error: "Job not found" });

    const stateFile = path.join(__dirname, 'tmp', 'jobState.json');
    let currentStage = 'downloading';
    
    if (fs.existsSync(stateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (state.projectId === job.id) currentStage = state.stage;
        } catch (e) {}
    }

    const stages = [
        { key: 'downloading', label: 'Downloading', status: 'pending' },
        { key: 'transcribing', label: 'Transcribing', status: 'pending' },
        { key: 'analyzing', label: 'AI Analysis', status: 'pending' },
        { key: 'rendering', label: 'Rendering', status: 'pending' }
    ];

    let progress = 5;
    if (currentStage === 'downloading') { stages[0].status = 'active'; progress = 25; }
    else if (currentStage === 'transcribing') { stages[0].status = 'completed'; stages[1].status = 'active'; progress = 50; }
    else if (currentStage === 'analyzing') { stages[0].status = 'completed'; stages[1].status = 'completed'; stages[2].status = 'active'; progress = 75; }
    else if (currentStage === 'rendering') { stages[0].status = 'completed'; stages[1].status = 'completed'; stages[2].status = 'completed'; stages[3].status = 'active'; progress = 90; }
    else if (currentStage === 'completed' || job.status === 'completed') { 
        stages.forEach(s => s.status = 'completed'); 
        progress = 100; currentStage = 'completed';
    }

    res.json({ projectId: job.id, status: currentStage === 'completed' ? 'completed' : job.status, progress, currentStage, stages });
});

app.get('/api/exportable-clips', (req, res) => {
    const { projectId } = req.query;
    
    // Even if jobs object is lost, we can find the file on disk
    const clipsDir = path.join(__dirname, 'tmp', 'clips');
    let files = [];
    if (fs.existsSync(clipsDir)) {
        files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4') && f.includes(projectId));
    }

    if (files.length === 0) return res.json({ clips: [] });

    const clipUrls = files.map((file, index) => {
        const metaPath = path.join(clipsDir, `meta_${projectId}.json`);
        let title = "Viral Clip";
        let bio = "Check out this clip!";
        
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                title = meta.title; bio = meta.bio;
            } catch(e) {}
        }

        return {
            id: `clip-${index}`, projectId, title, bio, viralityScore: 95, durationMs: 40000,
            thumbnailUrl: `http://192.168.43.101:3000/clips/${file}`,
            videoUrl: `http://192.168.43.101:3000/clips/${file}`
        };
    });
    res.json({ clips: clipUrls });
});

app.post('/api/source-videos', (req, res) => res.json({ videoId: "mock", status: "valid" }));
app.post('/api/upload-links-v2', (req, res) => res.json({ uploadUrl: "dummy" }));
app.use('/clips', express.static(path.join(__dirname, 'tmp', 'clips')));

app.listen(3000, '0.0.0.0', () => console.log(`\n🎬 API running on http://192.168.43.101:3000`));
