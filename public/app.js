const ws = new WebSocket(`ws://${window.location.host}`);
const audio = document.getElementById("audioPlayer");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const seekBar = document.getElementById("seekBar");
const timeDisplay = document.getElementById("timeDisplay");
const syncStatus = document.getElementById("syncStatus");
const songList = document.getElementById("songList");
const nowPlaying = document.getElementById("nowPlaying");

let isSync = false;
let currentSong = null;

function updateSongList(songs) {
    songList.innerHTML = songs
        .map(
            (song) => `
          <div class="song-item ${currentSong?.id === song.id ? "active" : ""
                }" 
               data-song-id="${song.id}">
              <div class="song-info">
                  <div class="song-title">${song.title}</div>
                  <div class="song-artist">${song.artist}</div>
              </div>
              <div class="song-duration">${formatTime(
                    song.duration
                )}</div>
          </div>
      `
        )
        .join("");

    // Add click listeners
    songList.querySelectorAll(".song-item").forEach((item) => {
        item.addEventListener("click", () => {
            const songId = item.dataset.songId;
            selectSong(songId);
        });
    });
}

function updateNowPlaying() {
    if (currentSong) {
        nowPlaying.innerHTML = `
              <strong>${currentSong.title}</strong>
              <div>${currentSong.artist}</div>
          `;
        playBtn.disabled = false;
        pauseBtn.disabled = false;
    } else {
        nowPlaying.innerHTML = "<div>No song selected</div>";
        playBtn.disabled = true;
        pauseBtn.disabled = true;
    }
}

function selectSong(songId) {
    ws.send(
        JSON.stringify({
            type: "select_song",
            songId,
        })
    );
}

function updateAudioSource(song) {
    if (song && (!currentSong || currentSong.id !== song.id)) {
        currentSong = song;
        audio.src = `/api/songs/${song.id}/stream`;
        audio.load();
        updateNowPlaying();
    }
}

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
        case "init":
            updateSongList(data.songs);
            updateAudioSource(data.currentSong);
        // Fall through to handle state...
        case "state":
        case "sync":
            isSync = true;
            updateAudioSource(data.currentSong);

            if (Math.abs(audio.currentTime - data.trackTime) > 0.1) {
                audio.currentTime = data.trackTime;
            }

            if (data.isPlaying && audio.paused) {
                audio.play();
            } else if (!data.isPlaying && !audio.paused) {
                audio.pause();
            }

            updateTimeDisplay(data.trackTime);
            syncStatus.textContent = `Sync diff: ${Math.abs(
                audio.currentTime - data.trackTime
            ).toFixed(3)}s`;
            isSync = false;
            break;

        case "library_update":
            updateSongList(data.songs);
            break;

        case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
    }
};

playBtn.onclick = () => {
    if (!isSync) {
        ws.send(
            JSON.stringify({
                type: "play",
                time: audio.currentTime,
            })
        );
    }
};

pauseBtn.onclick = () => {
    if (!isSync) {
        ws.send(
            JSON.stringify({
                type: "pause",
                time: audio.currentTime,
            })
        );
    }
};

seekBar.onchange = () => {
    const time = (seekBar.value / 100) * audio.duration;
    if (!isSync) {
        ws.send(
            JSON.stringify({
                type: "seek",
                time: time,
            })
        );
    }
};

audio.onloadedmetadata = () => {
    seekBar.max = audio.duration;
};

audio.ontimeupdate = () => {
    if (!isSync) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
        updateTimeDisplay(audio.currentTime);
    }
};

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(
        remainingSeconds
    ).padStart(2, "0")}`;
}

function updateTimeDisplay(time) {
    timeDisplay.textContent = formatTime(time);
}

async function downloadSong(youtubeUrl) {
    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: youtubeUrl }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log(result.message);
    } catch (error) {
        console.error('Error downloading song:', error);
    }
};

function ask_link() {
    let youtubeUrl = window.prompt('Enter the YouTube URL of the song to download:');

    if (youtubeUrl) {
        downloadSong(youtubeUrl);
    }
}