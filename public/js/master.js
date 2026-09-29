/* Master view: session info, player roster, round controls, buzzer sound. */

(function () {
  const socket = connectSocket();
  const audio = $('buzzer');

  let state = { roundState: 'lobby', winner: null, players: [], maxPlayers: 6 };
  let audioUnlocked = false;

  /* ------------------------------- Join info ------------------------------ */

  async function loadInfo() {
    try {
      const res = await fetch('/api/info');
      const info = await res.json();
      $('join-url').textContent = info.joinUrl;
      if (info.qrDataUrl) $('qr').src = info.qrDataUrl;
      else $('qr').classList.add('hidden');

      const extras = (info.interfaces || []).filter((i) => i.address !== info.ip);
      $('ip-hint').innerHTML =
        'Phones must be on the same Wi-Fi hotspot as this device.' +
        (extras.length
          ? `<br />Other addresses: ${extras
              .map((i) => `${i.iface} ${i.address}`)
              .join(', ')}`
          : '');
    } catch {
      $('join-url').textContent = 'Could not read LAN IP';
    }
  }

  /* --------------------------------- Audio -------------------------------- */

  // Browsers block autoplay until the page gets a gesture; the Master always
  // clicks something before the first buzz, so prime the element then.
  function unlockAudio() {
    if (audioUnlocked || !audio) return;
    audio.muted = true;
    const attempt = audio.play();
    if (attempt && typeof attempt.then === 'function') {
      attempt
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          audioUnlocked = true;
        })
        .catch(() => {
          audio.muted = false;
        });
    } else {
      audio.muted = false;
      audioUnlocked = true;
    }
  }

  function playBuzzer() {
    if (!audio) return fallbackBeep();
    audio.currentTime = 0;
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => fallbackBeep());
    }
  }

  // If the WAV cannot play for any reason, synthesise a buzz instead.
  function fallbackBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = fallbackBeep._ctx || (fallbackBeep._ctx = new Ctx());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 196;
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
    } catch {
      /* silent */
    }
  }

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  /* ------------------------------- Screen wake ---------------------------- */

  // When a tablet is the host, letting the screen sleep mid-quiz is painful.
  // Only available in a secure context, so this works at localhost:3000 on the
  // machine running the server and quietly does nothing elsewhere.
  let wakeLock = null;

  async function keepScreenAwake() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      wakeLock = null; // denied, or the tab is not visible
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) keepScreenAwake();
  });
  keepScreenAwake();

  /* -------------------------------- Rendering ----------------------------- */

  function renderPlayers() {
    const list = $('player-list');
    const players = state.players || [];
    list.innerHTML = '';
    $('player-empty').classList.toggle('hidden', players.length > 0);
    $('count-pill').textContent = `${players.length} / ${state.maxPlayers || 6} players`;

    players.forEach((p) => {
      const li = document.createElement('li');
      if (state.winner && state.winner.deviceId === p.deviceId) li.classList.add('winner');

      const dot = document.createElement('i');
      dot.className = `dot ${p.connected ? 'on' : 'off'}`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      const wins = document.createElement('span');
      wins.className = 'wins';
      wins.textContent = p.wins ? `${p.wins} win${p.wins > 1 ? 's' : ''}` : '—';

      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.type = 'button';
      kick.textContent = 'Kick';
      kick.addEventListener('click', () => socket.emit('kick_player', { deviceId: p.deviceId }));

      li.append(dot, name, wins, kick);
      list.appendChild(li);
    });
  }

  function renderStatus() {
    const box = $('status');
    const label = $('status-label');
    const headline = $('status-headline');
    const sub = $('status-sub');
    const players = state.players || [];

    box.classList.remove('is-open', 'is-locked');

    if (state.roundState === 'locked' && state.winner) {
      box.classList.add('is-locked');
      label.textContent = 'Buzzed in';
      headline.textContent = state.winner.name;
      sub.textContent =
        state.winner.reactionMs != null
          ? `${(state.winner.reactionMs / 1000).toFixed(2)}s after open · Reset Round to continue`
          : 'Reset Round to continue';
    } else if (state.roundState === 'open') {
      box.classList.add('is-open');
      label.textContent = 'Live';
      headline.textContent = 'BUZZERS OPEN';
      sub.textContent = `${players.filter((p) => p.connected).length} player(s) armed`;
    } else {
      label.textContent = 'Lobby';
      headline.textContent = players.length ? 'Ready when you are' : 'Waiting for players';
      sub.textContent = players.length
        ? 'Tap Open Buzzers to start the round.'
        : 'Share the link or QR code with the phones.';
    }

    $('btn-open').disabled = state.roundState === 'open';
    $('btn-reset').disabled = state.roundState === 'lobby';
  }

  function render() {
    renderPlayers();
    renderStatus();
  }

  /* --------------------------------- Socket ------------------------------- */

  socket.on('connect', () => {
    setConnected(true);
    socket.emit('master_hello');
  });

  socket.on('disconnect', () => setConnected(false));

  socket.on('state', (snapshot) => {
    state = { ...state, ...snapshot };
    render();
  });

  socket.on('players', (players) => {
    state.players = players;
    render();
  });

  socket.on('round_open', () => {
    state.roundState = 'open';
    state.winner = null;
    render();
  });

  socket.on('locked', (payload) => {
    state.roundState = 'locked';
    state.winner = {
      deviceId: payload.winnerDeviceId,
      name: payload.winnerName,
      reactionMs: payload.reactionMs,
    };
    playBuzzer();
    render();
  });

  socket.on('round_reset', () => {
    state.roundState = 'lobby';
    state.winner = null;
    render();
  });

  socket.on('error', (payload) => showToast((payload && payload.message) || 'Error'));

  /* -------------------------------- Controls ------------------------------ */

  $('btn-open').addEventListener('click', () => socket.emit('open_buzzers'));
  $('btn-reset').addEventListener('click', () => socket.emit('reset_round'));
  $('btn-clear').addEventListener('click', () => {
    if (confirm('Remove all players and reset the round?')) socket.emit('clear_players');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      socket.emit(state.roundState === 'open' ? 'reset_round' : 'open_buzzers');
    } else if (e.key.toLowerCase() === 'r') {
      socket.emit('reset_round');
    }
  });

  loadInfo();
  render();
})();
