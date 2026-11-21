// worker-v2.js — source-first, AI-curated multi-clip pipeline
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const execPromise = util.promisify(execFile);

const url = process.argv[2];
const projectId = process.argv[3];
const aspectRatio = process.argv[4] || '9:16';
const durationsCsv = process.argv[5] || '30';
const enableCaption = process.argv[6] !== '0';
const customPrompt = process.env.CF_CUSTOM_PROMPT || '';
const genre = process.env.CF_GENRE || 'Auto';

const durations = durationsCsv.split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
if (durations.length === 0) durations.push(30);

function extractVideoId(u) {
  try {
    if (u.includes('youtu.be/')) return u.split('youtu.be/')[1].split('?')[0];
    if (u.includes('youtube.com/watch')) return u.split('v=')[1].split('&')[0];
    if (u.includes('youtube.com/shorts/')) return u.split('shorts/')[1].split('?')[0];
    return u.split('?')[0].split('/').pop();
  } catch { return null; }
}

const videoId = extractVideoId(url);
if (!videoId) { console.error('❌ Invalid YouTube URL'); process.exit(1); }
const finalUrl = `https://www.youtube.com/watch?v=${videoId}`;

const workDir = path.join(__dirname, 'tmp');
const clipsDir = path.join(workDir, 'clips');
const stateFile = path.join(workDir, `state_${projectId}.json`);
const videoPath = path.join(workDir, `source_${projectId}.mp4`);
const audioPath = path.join(workDir, `audio_full_${projectId}.wav`);
const whisperPath = path.join(__dirname, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const modelPath = path.join(__dirname, 'whisper.cpp', 'models', 'ggml-base.en.bin');
const execOpts = { maxBuffer: 100 * 1024 * 1024 };

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

function setStage(s) { fs.writeFileSync(stateFile, JSON.stringify({ projectId, stage: s })); console.log(`[V2] ${s}`); }

async function getDuration(p) {
  try {
    const { stdout } = await execPromise('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',p]);
    const d = parseFloat(stdout.trim()); return isNaN(d) ? 0 : d;
  } catch { return 0; }
}

async function probeAI() {
  try { const r = await axios.get('http://127.0.0.1:8001/v1/models', { timeout: 2000 }); return r.status === 200; }
  catch { return false; }
}

async function callChatGPT(prompt) {
  const r = await axios.post('http://127.0.0.1:8001/v1/chat/completions', {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: prompt }],
    stream: false
  }, { timeout: 60000 });
  return r.data.choices[0].message.content;
}

async function scrapeCommentTimestamps(videoId) {
  try {
    const { YoutubeCommentDownloader, SORT_BY_POPULAR } = require('youtube-comment-downloader');
    const d = new YoutubeCommentDownloader();
    const iter = d.getCommentsFromUrl(`https://www.youtube.com/watch?v=${videoId}`, SORT_BY_POPULAR);
    const ts = [];
    const regex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
    let n = 0;
    for await (const c of iter) {
      if (c.text) {
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(c.text)) !== null) {
          const h = m[1] ? parseInt(m[1]) : 0;
          const mi = parseInt(m[2]);
          const s = parseInt(m[3]);
          if (!isNaN(h) && !isNaN(mi) && !isNaN(s)) ts.push({ ts: h*3600+mi*60+s, text: (c.text||'').slice(0,200) });
        }
      }
      if (++n >= 100) break;
    }
    return ts;
  } catch { return []; }
}

async function aiSelectMoments(transcript, srcDur) {
  const lines = transcript.slice(0, 300).map(s => `[${s.start.toFixed(1)}] ${s.text.trim().slice(0,180)}`).join('\n');
  const prompt = `You select the top ${durations.length} viral moments from a YouTube video.

User intent: ${customPrompt || 'most viral, quotable, attention-grabbing moments'}
Genre: ${genre}
Number of moments: ${durations.length}
Duration targets: ${durations.join('s, ')}s
Source duration: ${srcDur.toFixed(1)}s

Return ONLY valid JSON (no markdown, no explanation):
[{"start":<sec>,"end":<sec>,"reason":"<80 chars>","hook":"<3-5 words>"}]

Rules: ${durations.length} moments, non-overlapping, each duration ≈ one of [${durations.join(',')}], pick by viral potential.

Transcript:
${lines}`;

  const resp = await callChatGPT(prompt);
  const m = resp.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('No JSON array in response');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Empty array');

  const out = [];
  for (let i = 0; i < durations.length; i++) {
    const item = arr[i] || {};
    let start = Number(item.start);
    if (!isFinite(start) || start < 0) start = (i * srcDur) / durations.length;
    start = Math.min(start, Math.max(0, srcDur - durations[i]));
    const end = Math.min(srcDur, start + durations[i]);
    out.push({
      start, end,
      reason: String(item.reason || '').slice(0, 120),
      hook: String(item.hook || '').slice(0, 60)
    });
  }
  return out;
}

function evenDistribution(srcDur) {
  const out = [];
  const usable = Math.max(0, srcDur - Math.max(...durations));
  for (let i = 0; i < durations.length; i++) {
    const start = durations.length === 1 ? usable / 2 : (i / Math.max(1, durations.length - 1)) * usable;
    out.push({ start, end: Math.min(srcDur, start + durations[i]), reason: 'Evenly distributed', hook: '' });
  }
  return out;
}

function commentMoments(comments, srcDur) {
  const uniq = [...new Set(comments.map(c => c.ts))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < durations.length; i++) {
    let t = uniq[i] !== undefined ? uniq[i] : 45 + i * 60;
    t = Math.min(t, Math.max(0, srcDur - durations[i]));
    out.push({ start: Math.max(0, t - 2), end: Math.min(srcDur, t - 2 + durations[i]), reason: 'Comment timestamp', hook: '' });
  }
  return out;
}

// PeakCut-style caption styles
const CAPTION_STYLES = {
  bounce: { font: 'Impact',   size: 132, base: 'FFFFFF', active: '00F0FF', outline: 7, pop: 112, per: 3, upper: true  },
  hype:   { font: 'Impact',   size: 152, base: 'FFFFFF', active: '3C3CFF', outline: 7, pop: 114, per: 2, upper: true  },
  clean:  { font: 'Poppins',  size: 100, base: 'FFFFFF', active: '6BD7FF', outline: 5, pop: 106, per: 4, upper: false }
};

function assHeader() {
  let w = 1080, h = 1920;
  if (aspectRatio === '1:1') { w = 1080; h = 1080; }
  else if (aspectRatio === '16:9') { w = 1920; h = 1080; }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Impact,80,&H0000FFFF,&H00CCCCCC,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1\nStyle: Active,Impact,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,300,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
}

function fmt(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(2,'0')}`;
}

function charWidth(font, size) {
  const em = font === 'Impact' ? 0.55 : 0.60;
  return em * size;
}

function buildAssEvents(words, styleName) {
  if (!words.length) return '';
  const st = CAPTION_STYLES[styleName] || CAPTION_STYLES.bounce;
  const per = st.per;
  const size = st.size;
  const outline = st.outline;
  const gap = charWidth(st.font, size) * 0.9 + 2 * outline + 6; 
  let ev = '';

  for (let g = 0; g < words.length; g += per) {
    const group = words.slice(g, g + per);
    const gStart = group[0].start;
    const gEnd = group[group.length - 1].end;
    const texts = group.map(w => st.upper ? w.text.toUpperCase() : w.text);
    let sz = size;
    let total = texts.reduce((s, t) => s + t.length * charWidth(st.font, sz), 0) + gap * (texts.length - 1);
    const CAP_MAX_W = 960;
    if (total > CAP_MAX_W) {
      sz = Math.max(36, Math.round(sz * CAP_MAX_W / total));
      total = texts.reduce((s, t) => s + t.length * charWidth(st.font, sz), 0) + gap * (texts.length - 1);
    }
    let x = (1080 - total) / 2;

    for (let i = 0; i < group.length; i++) {
      const w = group[i];
      const t = texts[i];
      const wd = t.length * charWidth(st.font, sz);
      const cx = Math.round(x + wd / 2);
      const cy = 1230;
      const pop = Math.max(104, Math.min(st.pop, 100 + Math.floor(2200 / Math.max(wd, 1))));
      const pos = '\\an5\\pos(' + cx + ',' + cy + ')\\fs' + sz;
      
      const a = Math.max(gStart, w.start);
      const b = (i + 1 < group.length) ? group[i + 1].start : gEnd;
      
      if (a - gStart >= 20) {
        ev += 'Dialogue: 1,' + fmt(gStart) + ',' + fmt(a) + ',Default,,0,0,0,,{' + pos + '\\c&H' + st.base + '&}' + t + '\n';
      }
      if (b - a >= 20) {
        ev += 'Dialogue: 2,' + fmt(a) + ',' + fmt(b) + ',Default,,0,0,0,,{' + pos + '\\c&H' + st.active + '&\\fscx94\\fscy94\\t(0,90,\\fscx' + pop + '\\fscy' + pop + ')\\t(90,200,\\fscx' + (pop - 5) + '\\fscy' + (pop - 5) + ')}' + t + '\n';
      }
      if (gEnd - b >= 20) {
        ev += 'Dialogue: 1,' + fmt(b) + ',' + fmt(gEnd) + ',Default,,0,0,0,,{' + pos + '\\c&H' + st.base + '&\\fscx' + (pop - 5) + '\\fscy' + (pop - 5) + '\\t(0,90,\\fscx100\\fscy100)}' + t + '\n';
      }
      x += wd + gap;
    }
  }
  return ev;
}

async function run() {
  try {
    setStage('downloading');
    console.log(`[V2] Downloading ${finalUrl}`);
    await execPromise('yt-dlp', [
      '--js-runtimes', 'node',
      '--ffmpeg-location', process.env.FFMPEG_PATH || '/data/data/com.termux/files/usr/bin/ffmpeg',
      '-f', 'bv*[height<=720]+ba/b[height<=720]',
      '--merge-output-format', 'mp4', '--force-overwrites', '--retries', '10', '--fragment-retries', '10',
      '-o', videoPath, finalUrl
    ], execOpts);

    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 10000) throw new Error('Download too small');
    const srcDur = await getDuration(videoPath);
    console.log(`[V2] Source: ${(fs.statSync(videoPath).size/1024/1024).toFixed(1)} MB, ${srcDur.toFixed(1)}s`);

    setStage('analyzing');
    console.log('[V2] Extracting full audio...');
    await execPromise('ffmpeg', ['-y','-i',videoPath,'-vn','-acodec','pcm_s16le','-ar','16000','-ac','1',audioPath], execOpts);

    if (!fs.existsSync(whisperPath)) throw new Error(`whisper-cli missing: ${whisperPath}`);
    if (!fs.existsSync(modelPath)) throw new Error(`whisper model missing: ${modelPath}`);

    console.log('[V2] Transcribing full source...');
    await execPromise(whisperPath, ['-m', modelPath, '-f', audioPath, '-ojf', '-nt'], execOpts);
    const jsonPath = `${audioPath}.json`;
    if (!fs.existsSync(jsonPath)) throw new Error('Whisper did not produce JSON output');

    const wd = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    // ✅ FIX: Extract individual words, not full sentences
    const allWords = [];
    for (const segment of (wd.transcription || [])) {
      for (const token of (segment.tokens || [])) {
        const t = token.text;
        if (t.startsWith('[') && t.endsWith(']')) continue;
        if (t.startsWith('<|') && t.endsWith('|>')) continue;
        if (!t.trim()) continue;
        allWords.push({
          text: t.trim(),
          start: (token.offsets?.from || 0),
          end: (token.offsets?.to || 0)
        });
      }
    }
    console.log(`[V2] Transcribed ${allWords.length} word tokens`);

    let moments = [];
    const aiUp = await probeAI();
    console.log(`[V2] ChatGPT available: ${aiUp}`);
    if (aiUp && allWords.length > 0) {
      try { 
        // Feed the AI sentences for context, but it returns timestamps
        const sentences = (wd.transcription || []).map(s => ({ start: (s.offsets?.from || 0)/1000, text: s.text || '' }));
        moments = await aiSelectMoments(sentences, srcDur); 
        console.log(`[V2] AI picked ${moments.length} moments`); 
      }
      catch (e) { console.log(`[V2] AI failed: ${e.message}`); }
    }
    if (moments.length < durations.length) {
      console.log('[V2] Fallback: comment timestamps...');
      const comments = await scrapeCommentTimestamps(videoId);
      if (comments.length > 0) { moments = commentMoments(comments, srcDur); console.log(`[V2] ${moments.length} from comments`); }
    }
    if (moments.length < durations.length) {
      console.log('[V2] Fallback: even distribution');
      moments = evenDistribution(srcDur);
    }

    setStage('rendering');
    for (let i = 0; i < Math.min(moments.length, durations.length); i++) {
      const m = moments[i];
      const dur = Math.min(m.end - m.start, durations[i]);
      const start = m.start;
      const end = start + dur;
      console.log(`[V2] Clip ${i+1}/${durations.length}: [${start.toFixed(1)}, ${end.toFixed(1)}] — ${m.reason}`);

      const rawClip = path.join(workDir, `raw_${projectId}_${i}.mp4`);
      const finalClip = path.join(clipsDir, `final_${projectId}_${i}.mp4`);
      const thumbPath = path.join(clipsDir, `thumb_${projectId}_${i}.jpg`);
      const metaPath = path.join(clipsDir, `meta_${projectId}_${i}.json`);
      const assPath = path.join(workDir, `captions_${projectId}_${i}.ass`);

      await execPromise('ffmpeg', [
        '-y','-analyzeduration','100M','-probesize','100M','-i',videoPath,
        '-ss',start.toFixed(3),'-t',dur.toFixed(3),
        '-map','0:v:0','-map','0:a:0?',
        '-c:v','libx264','-preset','ultrafast','-r','30','-c:a','aac','-ar','44100',
        rawClip
      ], execOpts);

      let useCap = false;
      if (enableCaption && allWords.length > 0) {
        const wordsIn = [];
        const startMs = start * 1000;
        const endMs = end * 1000;
        for (const w of allWords) {
          if (w.end <= startMs) continue;
          if (w.start >= endMs) break;
          const ss = Math.max(0, w.start - startMs);
          const ee = Math.min(dur * 1000, w.end - startMs);
          if (ee <= ss) continue;
          wordsIn.push({ text: w.text, start: ss, end: ee });
        }
        if (wordsIn.length) {
          const captionStyle = process.env.CF_CAPTION_STYLE || 'bounce';
          fs.writeFileSync(assPath, assHeader() + buildAssEvents(wordsIn, captionStyle));
          useCap = fs.statSync(assPath).size > 100;
          console.log(`[V2] ${wordsIn.length} caption words`);
        }
      }

      let w = 1080, h = 1920;
      if (aspectRatio === '1:1') { w = 1080; h = 1080; }
      else if (aspectRatio === '16:9') { w = 1920; h = 1080; }
      const vf = useCap
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},subtitles=${assPath}`
        : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

      await execPromise('ffmpeg', [
        '-y','-analyzeduration','100M','-probesize','100M','-i',rawClip,
        '-vf',vf,'-map','0:v:0','-map','0:a:0?',
        '-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-crf','23','-r','30','-c:a','aac',
        finalClip
      ], execOpts);

      try {
        await execPromise('ffmpeg', ['-y','-i',finalClip,'-ss','00:00:01','-vframes','1','-q:v','2',thumbPath], execOpts);
      } catch {}

      const clipDur = await getDuration(finalClip);
      fs.writeFileSync(metaPath, JSON.stringify({
        title: m.hook || `Clip ${i+1}`,
        bio: m.reason || 'Check out this moment',
        durationMs: Math.round(clipDur * 1000),
        start, end
      }));

      try { fs.unlinkSync(rawClip); } catch {}
      try { fs.unlinkSync(assPath); } catch {}
    }

    setStage('completed');
    console.log(`[V2] ✅ ${durations.length} clips ready`);

    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}
    try { fs.unlinkSync(jsonPath); } catch {}
    process.exit(0);
  } catch (e) {
    console.error(`[V2] ❌ FATAL: ${e.message}`);
    setStage('failed');
    process.exit(1);
  }
}

run();
