const fs = require('fs');
const axios = require('axios');

// Read the JSON array of cookies
const cookiesData = JSON.parse(fs.readFileSync('cookie.json', 'utf8'));

// Format into a single Cookie header string
const cookieString = cookiesData.map(c => `${c.name}=${c.value}`).join('; ');

async function fetchToken() {
    try {
        console.log("Fetching access token using cookies...");
        const response = await axios.get('https://chatgpt.com/api/auth/session', {
            headers: {
                'Cookie': cookieString,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (response.data && response.data.accessToken) {
            fs.writeFileSync('token.txt', response.data.accessToken);
            console.log("✅ Success! Token saved to token.txt.");
            console.log("Preview:", response.data.accessToken.substring(0, 30) + "...");
        } else {
            console.log("❌ No accessToken found in response. Response data:", response.data);
        }
    } catch (error) {
        console.error("❌ Error fetching token:", error.message);
    }
}

fetchToken();
