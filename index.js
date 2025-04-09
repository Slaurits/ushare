const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const browser = 'firefox'; // ADD .ENV FILE FOR USER BROWSER, OR AUTODETECT

// Create a Timer worker for precise timing
const timerWorker = new Worker(`
    const { parentPort } = require('worker_threads');
    
    function preciseTick() {
        parentPort.postMessage({ type: 'tick', time: process.hrtime.bigint() });
        setTimeout(preciseTick, 50); // 20 ticks per second
    }
    
    preciseTick();
`, { eval: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store client connections and their states
const clients = new Map();
let globalStartTime = process.hrtime.bigint();
let isPlaying = false;
let currentTrackTime = 0;
let currentSong = null;

// Song library management
const SONGS_DIR = path.join(__dirname, 'songs');
const songLibrary = new Map();

// Create songs directory if it doesn't exist
if (!fs.existsSync(SONGS_DIR)) {
  fs.mkdirSync(SONGS_DIR);
}

// Load song library
function loadSongLibrary() {
  const files = fs.readdirSync(SONGS_DIR);
  songLibrary.clear();

  files.forEach(file => {
    if (file.endsWith('.mp3')) {
      const filePath = path.join(SONGS_DIR, file);
      const stats = fs.statSync(filePath);
      const id = file.replace('.mp3', '');

      try {
        // Try to load metadata from companion JSON file
        const metadataPath = path.join(SONGS_DIR, `${id}.json`);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }

        songLibrary.set(id, {
          id,
          title: metadata.title || file.replace('.mp3', ''),
          artist: metadata.artist || 'Unknown',
          duration: metadata.duration || 0,
          filename: file,
          size: stats.size
        });
      } catch (err) {
        console.error(`Error loading metadata for ${file}:`, err);
      }
    }
  });
}

// Initial library load
loadSongLibrary();

app.use(express.static('public'));
app.use(express.json());

// API endpoints for song management
app.get('/api/songs', (res) => {
  const songs = Array.from(songLibrary.values());
  res.json(songs);
});

// Stream audio file
app.get('/api/songs/:id/stream', (req, res) => {
  const song = songLibrary.get(req.params.id);
  if (!song) {
    return res.status(404).json({ error: 'Song not found' });
  }

  const audioPath = path.join(SONGS_DIR, song.filename);
  const stat = fs.statSync(audioPath);

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': stat.size
  });

  const stream = fs.createReadStream(audioPath);
  stream.pipe(res);
});

app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  const audioPath = path.join(SONGS_DIR);

// Check if url is a spotify link
if (url.includes('spotify.com')) {
  console.log('Using spotDL for Spotify download');
  const spotDL = path.join(__dirname, 'spotdl-4.2.11-win32.exe');
  const spotDLProcess = require('child_process').spawn(spotDL, [url, '--bitrate', '192k', '--output', audioPath]);

  spotDLProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });

  spotDLProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  spotDLProcess.on('close', (code) => {
    console.log(`spotDL process exited with code ${code}`);
  });

  res.json({ message: 'Spotify Download started' });
} else {
  // Use yt-dlp for other links
  console.log('Using yt-dlp for download');
  const ytDlp = path.join(__dirname, 'yt-dlp_x86.exe');
  const ytDlpProcess = require('child_process').spawn(ytDlp, ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--cookies-from-browser', browser, '--output', path.join(audioPath, '%(title)s.%(ext)s'), url]);

  ytDlpProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });

  ytDlpProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  ytDlpProcess.on('close', (code) => {
    console.log(`yt-dlp process exited with code ${code}`);
  });

  res.json({ message: 'yt-dlp Download started' });
}
});

// Handle precise timing updates from worker
timerWorker.on('message', ({ type, time }) => {
  if (type === 'tick' && isPlaying) {
    const elapsed = Number(time - globalStartTime) / 1e9; // Convert to seconds
    currentTrackTime = elapsed;

    for (const [client, { latency }] of clients.entries()) {
      if (client.readyState === WebSocket.OPEN) {
        const clientMessage = JSON.stringify({
          type: 'sync',
          serverTime: Date.now(),
          trackTime: currentTrackTime,
          isPlaying,
          currentSong,
          latency
        });

        setImmediate(() => {
          try {
            client.send(clientMessage);
          } catch (err) {
            console.error('Failed to send to client:', err);
          }
        });
      }
    }
  }
});

wss.on('connection', (ws) => {
  clients.set(ws, {
    latency: 0,
    lastPing: Date.now()
  });

  ws.send(JSON.stringify({
    type: 'init',
    serverTime: Date.now(),
    trackTime: currentTrackTime,
    isPlaying,
    currentSong,
    songs: Array.from(songLibrary.values())
  }));

  measureLatency(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'play':
          if (!isPlaying) {
            isPlaying = true;
            globalStartTime = process.hrtime.bigint() - BigInt(Math.floor(data.time * 1e9));
            broadcastState();
          }
          break;

        case 'pause':
          if (isPlaying) {
            isPlaying = false;
            currentTrackTime = data.time;
            broadcastState();
          }
          break;

        case 'seek':
          currentTrackTime = data.time;
          if (isPlaying) {
            globalStartTime = process.hrtime.bigint() - BigInt(Math.floor(data.time * 1e9));
          }
          broadcastState();
          break;

        case 'select_song':
          const song = songLibrary.get(data.songId);
          if (song) {
            currentSong = song;
            currentTrackTime = 0;
            isPlaying = false;
            broadcastState();
          }
          break;

        case 'pong':
          const clientState = clients.get(ws);
          if (clientState) {
            clientState.latency = (Date.now() - clientState.lastPing) / 2;
          }
          break;
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcastState() {
  const message = JSON.stringify({
    type: 'state',
    serverTime: Date.now(),
    trackTime: currentTrackTime,
    isPlaying,
    currentSong
  });

  for (const [client, { latency }] of clients.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      setImmediate(() => {
        try {
          client.send(message);
        } catch (err) {
          console.error('Failed to broadcast to client:', err);
        }
      });
    }
  }
}

function measureLatency(ws) {
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const clientState = clients.get(ws);
      if (clientState) {
        clientState.lastPing = Date.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 5000);
}

// Watch for changes in the songs directory
fs.watch(SONGS_DIR, (eventType, filename) => {
  if (filename && (filename.endsWith('.mp3') || filename.endsWith('.json'))) {
    console.log('Song library change detected, reloading...');
    loadSongLibrary();
    // Notify all clients of the updated song list
    const songs = Array.from(songLibrary.values());
    const message = JSON.stringify({ type: 'library_update', songs });
    for (const [client] of clients.entries()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});