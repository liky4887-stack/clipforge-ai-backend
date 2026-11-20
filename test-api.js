const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function testAPI() {
    console.log("1️⃣ Starting job...");
    const res = await fetch('http://localhost:3000/api/clip-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    
    const data = await res.json();
    const projectId = data.projectId;
    console.log(`✅ Job started! Project ID: ${projectId}`);

    console.log("\n2️⃣ Checking progress (waiting 10 seconds)...");
    await new Promise(r => setTimeout(r, 10000)); // wait 10s
    
    const progressRes = await fetch(`http://localhost:3000/api/cluster-jobs/${projectId}/progress`);
    const progressData = await progressRes.json();
    console.log(`⏳ Status: ${progressData.status}`);

    if (progressData.status === 'completed') {
        console.log("\n3️⃣ Fetching exportable clips...");
        const clipsRes = await fetch(`http://localhost:3000/api/exportable-clips?projectId=${projectId}`);
        const clipsData = await clipsRes.json();
        console.log("🎉 SUCCESS! Here are your clips:\n", clipsData);
    } else {
        console.log("\n⚠️ The video is still processing. Check the server terminal for progress!");
    }
}

testAPI();
