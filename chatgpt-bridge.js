const axios = require('axios');

async function callChatGPT(prompt) {
    const payload = {
        model: 'gemini-3.5-flash', // Freebie handles model routing
        messages: [{ role: 'user', content: prompt }],
        stream: false
    };

    try {
        console.log("[ChatGPT Bridge] Sending prompt via Freebie proxy...");
        const response = await axios.post('http://127.0.0.1:8001/v1/chat/completions', payload);
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("[ChatGPT Bridge] Error:", error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Body:", error.response.data);
        }
        throw error;
    }
}

module.exports = { callChatGPT };
