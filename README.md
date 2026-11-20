# ClipForge AI Backend

Node.js backend for ClipForge AI: yt-dlp download, whisper.cpp transcription, ChatGPT analysis, FFmpeg rendering.

## Prerequisites (Termux)
nodejs, python, ffmpeg, yt-dlp, cmake, clang

## Install
npm install

## Build whisper.cpp
cd whisper.cpp
bash ./models/download-ggml-model.sh base.en
cmake -S . -B build -DGGML_NO_OPENMP=ON
cmake --build build -j"$(nproc)"
cd ..

## Run
Terminal 1: freebie --port 8001 --access-token "$(cat token.txt)"
Terminal 2: node server.js

## Endpoints
POST /api/clip-projects
GET  /api/cluster-jobs/:projectId/progress
GET  /api/exportable-clips?projectId={id}
GET  /api/clip-projects
