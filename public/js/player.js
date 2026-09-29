/* Player view: name gate, then a full-screen buzzer driven by server state. */

(function () {
  const socket = connectSocket();
  const deviceId = getDeviceId();
  const nameStore = storage('offbuzz.name');
  const seatStore = storage('offbuzz.seated');

  let myName = '';
  let joined = false;
  let restoring = false;
  let restoreTimer = null;
  let state = { roundState: 'lobby', winner: null };
  let lastBuzzSent = 0;

  const gate = $('gate');
  const stage = $('stage');
  const buzz = $('buzz');
  const nameInput = $('name-input');

  /* ------------------------------- Name gate ------------------------------ */

  const saved = nameStore.get();
  if (saved) nameInput.value = saved;

  // A refresh should not cost you your seat: if this device was seated before,
  // claim it back automatically instead of showing the name gate again. The
  // flag is cleared only when the host kicks or clears players.
  if (saved && seatStore.get() === '1') {
    myName = saved;
    restoring = true;
  }

  function giveUpRestore(message) {
    clearTimeout(restoreTimer);
    if (!restoring) return;
    restoring = false;
    myName = '';
    seatStore.set('0');
    if (message) showToast(message);
    render();
    nameInput.focus();
  }

  function armRestoreTimeout() {
    clearTimeout(restoreTimer);
    if (!restoring) return;
    restoreTimer = setTimeout(
      () => giveUpRestore('Could not restore your seat. Enter your name again.'),
      5000
    );
  }

  function submitName() {
    const name = nameInput.value.trim().slice(0, 20);
    if (!name) {
      showToast('Please enter your name first.');
      nameInput.focus();
      return;
    }
    myName = name;
    nameStore.set(name);
    $('btn-join').disabled = true;
    socket.emit('join', { deviceId, name });
    setTimeout(() => {
      $('btn-join').disabled = false;
    }, 1200);
  }

  $('btn-join').addEventListener('click', submitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });

  // Auto-seating means the gate is normally skipped, so leave a way back to it.
  $('btn-change-name').addEventListener('click', () => {
    clearTimeout(restoreTimer);
    joined = false;
    restoring = false;
    seatStore.set('0');
    nameInput.value = myName;
    render();
    nameInput.focus();
    nameInput.select();
  });

  /* -------------------------------- Buzzing ------------------------------- */

  function sendBuzz() {
    if (!joined) return;
    if (state.roundState !== 'open') return; // UI lock (server locks too)
    const now = Date.now();
    if (now - lastBuzzSent < 250) return; // kill accidental double taps
    lastBuzzSent = now;

    socket.emit('buzz', { deviceId });
    if (navigator.vibrate) navigator.vibrate(35);

    // Optimistic local lock so the button cannot be hammered while we wait.
    buzz.disabled = true;
    buzz.textContent = '…';
  }

  // pointerdown beats click by ~100ms on touch devices.
  buzz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sendBuzz();
  });
  buzz.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && joined) {
      e.preventDefault();
      sendBuzz();
    }
  });

  /* ------------------------------- Rendering ------------------------------ */

  function render() {
    // While restoring we show the buzzer shell rather than flashing the gate.
    const onStage = joined || restoring;
    gate.classList.toggle('hidden', onStage);
    stage.classList.toggle('hidden', !onStage);
    $('who').textContent = onStage && myName ? myName : 'OffBuzz';
    if (!onStage) return;

    const line = $('state-line');
    const note = $('footer-note');
    buzz.className = '';

    if (restoring) {
      buzz.disabled = true;
      buzz.textContent = '…';
      line.textContent = 'Restoring your seat…';
      note.textContent = '';
      return;
    }

    if (state.roundState === 'open') {
      buzz.disabled = false;
      buzz.classList.add('ready');
      buzz.textContent = 'BUZZ';
      line.textContent = 'Buzzers are OPEN';
      note.textContent = 'Hit it first!';
      return;
    }

    if (state.roundState === 'locked' && state.winner) {
      const iWon = state.winner.deviceId === deviceId;
      buzz.disabled = true;
      buzz.classList.add(iWon ? 'won' : 'locked');
      if (iWon) {
        buzz.textContent = 'YOU GOT IT!';
      } else {
        // Built as nodes rather than innerHTML so a name can never inject markup.
        buzz.textContent = '';
        const wrap = document.createElement('span');
        wrap.className = 'locked-msg';
        const who = document.createElement('span');
        who.className = 'winner-name';
        who.textContent = state.winner.name;
        const tail = document.createElement('span');
        tail.className = 'locked-tail';
        tail.textContent = 'buzzed first';
        wrap.append(who, tail);
        buzz.append(wrap);
      }
      line.textContent = iWon ? 'You buzzed first' : 'Round locked';
      note.textContent = 'Waiting for the host to reset…';
      return;
    }

    buzz.disabled = true;
    buzz.textContent = 'WAIT';
    line.textContent = 'Waiting for the host…';
    note.textContent = 'The button lights up when buzzers open.';
  }

  /* -------------------------------- Socket -------------------------------- */

  socket.on('connect', () => {
    setConnected(true);
    // Re-claim the seat automatically after a reconnect or refresh.
    if (myName) {
      socket.emit('join', { deviceId, name: myName });
      armRestoreTimeout();
    }
  });

  socket.on('disconnect', () => {
    setConnected(false);
    $('state-line').textContent = 'Reconnecting…';
    buzz.disabled = true;
  });

  socket.on('joined', (payload) => {
    clearTimeout(restoreTimer);
    joined = true;
    restoring = false;
    myName = payload.name;
    nameStore.set(myName);
    seatStore.set('1');
    render();
  });

  socket.on('state', (snapshot) => {
    state = { ...state, ...snapshot };
    render();
  });

  socket.on('round_open', () => {
    state.roundState = 'open';
    state.winner = null;
    lastBuzzSent = 0;
    render();
  });

  socket.on('locked', (payload) => {
    state.roundState = 'locked';
    state.winner = { deviceId: payload.winnerDeviceId, name: payload.winnerName };
    render();
  });

  socket.on('round_reset', () => {
    state.roundState = 'lobby';
    state.winner = null;
    render();
  });

  socket.on('buzz_ignored', () => render());

  socket.on('kicked', (payload) => {
    // Losing the seat on purpose must survive a refresh, so drop the flag.
    clearTimeout(restoreTimer);
    joined = false;
    restoring = false;
    myName = '';
    seatStore.set('0');
    state = { roundState: 'lobby', winner: null };
    showToast((payload && payload.message) || 'Removed by host.');
    render();
  });

  socket.on('error', (payload) => {
    const message = (payload && payload.message) || 'Something went wrong.';
    if (restoring) {
      giveUpRestore(message); // Room filled up or the name was taken meanwhile.
      return;
    }
    showToast(message);
    if (!joined) $('btn-join').disabled = false;
  });

  render();
})();
