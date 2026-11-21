const axios = require('axios');

let aiAvailable = null;
async function probeAI() {
    if (aiAvailable !== null) return aiAvailable;
    try {
        const resp = await axios.get('http://127.0.0.1:8001/v1/models', { timeout: 2000 });
        aiAvailable = resp.status === 200;
    } catch (e) {
        aiAvailable = false;
    }
    console.log('[AI] Proxy available: ' + aiAvailable);
    return aiAvailable;
}

async function pickTimestampWithAI(candidates, customPrompt, genre, fallbackTs) {
    if (!candidates || candidates.length === 0) return fallbackTs;
    const seen = new Set();
    const deduped = [];
    for (const c of candidates) {
        if (seen.has(c.ts)) continue;
        seen.add(c.ts);
        deduped.push(c);
    }
    deduped.sort((a, b) => a.ts - b.ts);
    const top = deduped.slice(0, 15);
    const lines = top.map((c, i) => {
        const preview = (c.text || '').slice(0, 120);
        return String(i + 1) + '. ' + String(c.ts) + 's - ' + JSON.stringify(preview);
    });
    const prompt = [
        'You are picking the most viral moment from a YouTube video.',
        '',
        'User intent: ' + (customPrompt || 'find the most viral/engaging moment'),
        'Genre: ' + (genre || 'general'),
        '',
        'Candidate moments from popular comments:',
        lines.join('\n'),
        '',
        'Pick ONE candidate that best matches the intent above. Respond ONLY with valid JSON:',
        '{"pick": <number 1-based>, "reason": "<max 80 chars>"}'
    ].join('\n');
    try {
        const { callChatGPT } = require('./chatgpt-bridge');
        const response = await callChatGPT(prompt);
        const m = response.match(/\{[\s\S]*\}/);
        if (!m) return fallbackTs;
        const parsed = JSON.parse(m[0]);
        const idx = Number(parsed.pick) - 1;
        if (idx >= 0 && idx < top.length) {
            console.log('[AI] Pick #' + (idx + 1) + ': ' + (parsed.reason || 'no reason'));
            return top[idx].ts;
        }
        console.log('[AI] Invalid pick, using fallback');
    } catch (e) {
        console.log('[AI] Failed: ' + String(e.message).slice(0, 80));
    }
    return fallbackTs;
}

module.exports = { probeAI, pickTimestampWithAI };
