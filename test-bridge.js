const fs = require('fs');

// 1. Read the JSON array
const cookiesData = JSON.parse(fs.readFileSync('cookie.json', 'utf8'));

// 2. Format into a single Cookie header string
const cookieString = cookiesData.map(c => `${c.name}=${c.value}`).join('; ');

// 3. Set the env var BEFORE requiring the bridge
process.env.CHATGPT_COOKIE = cookieString;

// 4. Now require the bridge (it will see the cookie)
const { callChatGPT } = require('./chatgpt-bridge');

console.log("Testing ChatGPT Bridge with provided cookies...");

callChatGPT('Say exactly: The AI brain is online.')
    .then(response => {
        console.log("\n✅ RESPONSE:");
        console.log(response);
    })
    .catch(err => {
        console.error("\n❌ ERROR:", err.message);
    });
