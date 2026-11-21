const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const jobsFile = path.join(__dirname, 'jobs.json');
let jobs = {};

if (fs.existsSync(jobsFile)) {
    try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch (e) {}
}

function saveJobs() {
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
}

app.post('/api/clip-projects', (req, res) => {
    const finalUrl = req.body.videoUrl || req.body.url || req.body.sourceUrl;
    if (!finalUrl) return res.status(400).json({ error: "YouTube URL is required" });

    const projectId = crypto.randomUUID();
    const deviceId = req.headers['x-device-id'] || 'unknown-device';
    const projectTitle = String(req.body.uploadedVideoAttr?.title || '').trim() || 'New Clip';
    jobs[projectId] = { id: projectId, title: projectTitle, status: 'processing', createdAt: new Date().toISOString(), deviceId };
    saveJobs();

    const stateFile = path.join(__dirname, 'tmp', `state_${projectId}.json`);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

    // Extract curation prefs (fallbacks to defaults if missing)
    const aspect = req.body.renderPref?.layoutAspectRatio || '9:16';
    const durationArr = req.body.curationPref?.clipDurations?.[0] || [30];
    const durationSec = Array.isArray(durationArr) && durationArr.length > 0 ? Number(durationArr[0]) : 30;

    const enableCaption = req.body.renderPref?.enableCaption !== false;
    const enableEmoji = req.body.renderPref?.enableEmoji === true;      // reserved (PR #5)
    const enableWatermark = req.body.renderPref?.enableWatermark === true;  // reserved
    void enableEmoji; void enableWatermark;

    const worker = execFile(process.execPath, [path.join(__dirname, 'worker.js'), finalUrl, projectId, aspect, durationSec.toString(), enableCaption ? '1' : '0'], { maxBuffer: 1024 * 1024 * 20 });
    worker.stdout.pipe(process.stdout);
    worker.stderr.pipe(process.stderr);

    worker.on('exit', (code) => {
        jobs[projectId].status = (code === 0) ? 'completed' : 'failed';
        saveJobs();
    });

    res.json(jobs[projectId]);
});

app.get('/api/clip-projects', (req, res) => {
    const deviceId = req.headers['x-device-id'] || 'unknown-device';
    const userProjects = Object.values(jobs).filter(j => j.deviceId === deviceId);
    res.json({ projects: userProjects });
});

app.get('/api/cluster-jobs/:projectId/progress', (req, res) => {
    const job = jobs[req.params.projectId];
    if (!job) return res.status(404).json({ error: "Job not found" });

    const stateFile = path.join(__dirname, 'tmp', `state_${job.id}.json`);
    let currentStage = 'downloading';

    if (fs.existsSync(stateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (state.projectId === job.id) currentStage = state.stage;
        } catch (e) {}
    }

    // Stage order MUST match worker.js: downloading -> analyzing -> transcribing -> rendering
    const stages = [
        { key: 'downloading',  label: 'Downloading', status: 'pending' },
        { key: 'analyzing',    label: 'AI Analysis', status: 'pending' },
        { key: 'transcribing', label: 'Transcribing', status: 'pending' },
        { key: 'rendering',    label: 'Rendering',   status: 'pending' }
    ];

    let progress = 5;
    if (currentStage === 'downloading') {
        stages[0].status = 'active';
        progress = 25;
    } else if (currentStage === 'analyzing') {
        stages[0].status = 'completed';
        stages[1].status = 'active';
        progress = 50;
    } else if (currentStage === 'transcribing') {
        stages[0].status = 'completed';
        stages[1].status = 'completed';
        stages[2].status = 'active';
        progress = 75;
    } else if (currentStage === 'rendering') {
        stages[0].status = 'completed';
        stages[1].status = 'completed';
        stages[2].status = 'completed';
        stages[3].status = 'active';
        progress = 90;
    } else if (currentStage === 'completed' || job.status === 'completed') {
        stages.forEach(s => s.status = 'completed');
        progress = 100;
        currentStage = 'completed';
    }

    res.json({
        projectId: job.id,
        status: currentStage === 'completed' ? 'completed' : job.status,
        progress,
        currentStage,
        stages
    });
});

app.get('/api/exportable-clips', (req, res) => {
    let { projectId } = req.query;

    if (projectId === 'undefined' || projectId === 'null' || !projectId) {
        return res.json({ clips: [] });
    }

    const deviceId = req.headers['x-device-id'] || 'unknown-device';
    const job = jobs[projectId];
    if (!job || (job.deviceId && job.deviceId !== deviceId)) {
        return res.status(404).json({ clips: [], error: 'Project not found' });
    }

    const clipsDir = path.join(__dirname, 'tmp', 'clips');
    let files = [];
    if (fs.existsSync(clipsDir)) {
        files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4') && f.includes(projectId));
    }

    const clipUrls = files.map((file, index) => {
        const metaPath = path.join(clipsDir, `meta_${projectId}.json`);
        let title = "Viral Clip";
            let durationMs = 0;
        let bio = "Check out this clip!";

        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                title = meta.title || title; bio = meta.bio || bio; durationMs = Number(meta.durationMs) || 0;
            } catch(e) {}
        }

        const thumbName = `thumb_${projectId}.jpg`;
        const hasThumb = fs.existsSync(path.join(clipsDir, thumbName));
        const baseUrl = `${req.protocol}://${req.get('host')}/clips`;
        
        return {
            id: `clip-${index}`, projectId: projectId || 'unknown', title, bio, viralityScore: 95, durationMs,
            thumbnailUrl: hasThumb ? `${baseUrl}/${thumbName}` : null,
            videoUrl: `${baseUrl}/${file}`
        };
    });
    res.json({ clips: clipUrls });
});

app.post('/api/source-videos', (req, res) => res.json({ videoId: "mock", status: "valid" }));
app.post('/api/upload-links-v2', (req, res) => res.json({ uploadUrl: "dummy" }));
app.use('/clips', express.static(path.join(__dirname, 'tmp', 'clips')));

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(3000, '0.0.0.0', () => console.log(`\n🎬 API running on port 3000`));
