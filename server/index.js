'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { GameState, MAX_PLAYERS } = require('./state');
const { lanAddresses, primaryLanAddress } = require('./network');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // must not be localhost-only
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Websocket-first for the lowest possible buzz latency on a local hotspot.
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 8000,
  cors: { origin: '*' },
});

const game = new GameState();

/* ---------------------------------- HTTP --------------------------------- */

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));
app.get('/player', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));
app.get('/master', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'master.html')));

app.get('/api/info', async (_req, res) => {
  const addresses = lanAddresses();
  const ip = primaryLanAddress();
  const joinUrl = `http://${ip}:${PORT}/`;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, {
      margin: 1,
      width: 320,
      color: { dark: '#0b1020', light: '#ffffff' },
    });
  } catch {
    qrDataUrl = null;
  }
  res.json({
    ip,
    port: PORT,
    joinUrl,
    qrDataUrl,
    maxPlayers: MAX_PLAYERS,
    interfaces: addresses.map((a) => ({ iface: a.iface, address: a.address })),
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ...game.snapshot() }));

/* -------------------------------- Realtime -------------------------------- */

function broadcastPlayers() {
  io.emit('players', game.playerList());
}

function broadcastState() {
  io.emit('state', game.snapshot());
}

function isMaster(socket) {
  return socket.data.role === 'master';
}

io.on('connection', (socket) => {
  socket.data.role = 'player';
  socket.data.deviceId = null;

  // Every client gets the current truth immediately (covers reconnects).
  socket.emit('state', game.snapshot());

  socket.on('master_hello', () => {
    socket.data.role = 'master';
    socket.join('master');
    socket.emit('state', game.snapshot());
  });

  socket.on('join', (payload = {}) => {
    const { deviceId, name } = payload;
    const result = game.join(deviceId, name, socket.id);
    if (!result.ok) {
      socket.emit('error', { message: result.message });
      return;
    }

    // Drop any other socket that was holding this same device slot.
    for (const [id, s] of io.sockets.sockets) {
      if (id !== socket.id && s.data.deviceId === deviceId) s.data.deviceId = null;
    }

    socket.data.deviceId = deviceId;
    socket.data.role = 'player';
    socket.emit('joined', { deviceId, name: result.player.name, rejoined: result.rejoined });
    socket.emit('state', game.snapshot());
    broadcastPlayers();
  });

  socket.on('buzz', (payload = {}) => {
    const deviceId = payload.deviceId || socket.data.deviceId;
    const result = game.buzz(deviceId, socket.id);
    if (!result.ok) {
      if (!result.silent) socket.emit('error', { message: result.message });
      socket.emit('buzz_ignored', { reason: result.message, roundState: game.roundState });
      return;
    }
    io.emit('locked', {
      winnerDeviceId: result.winner.deviceId,
      winnerName: result.winner.name,
      reactionMs: result.winner.reactionMs,
    });
    broadcastPlayers();
  });

  /* ------------------------------ Master controls ----------------------- */

  socket.on('open_buzzers', () => {
    if (!isMaster(socket)) return socket.emit('error', { message: 'Not authorized.' });
    game.openRound();
    io.emit('round_open', { at: game.openedAt });
    broadcastState();
  });

  socket.on('reset_round', () => {
    if (!isMaster(socket)) return socket.emit('error', { message: 'Not authorized.' });
    game.resetRound();
    io.emit('round_reset');
    broadcastState();
  });

  socket.on('kick_player', (payload = {}) => {
    if (!isMaster(socket)) return socket.emit('error', { message: 'Not authorized.' });
    const removed = game.kick(payload.deviceId);
    if (!removed) return;
    if (game.winner && game.winner.deviceId === removed.deviceId) {
      // Winner is gone but the round stays locked until Master resets.
      game.winner = { ...game.winner, name: `${removed.name} (removed)` };
    }
    for (const [, s] of io.sockets.sockets) {
      if (s.data.deviceId === removed.deviceId) {
        s.data.deviceId = null;
        s.emit('kicked', { message: 'You were removed by the host.' });
      }
    }
    broadcastPlayers();
    broadcastState();
  });

  socket.on('clear_players', () => {
    if (!isMaster(socket)) return socket.emit('error', { message: 'Not authorized.' });
    game.clearPlayers();
    for (const [, s] of io.sockets.sockets) {
      if (s.data.role === 'player' && s.data.deviceId) {
        s.data.deviceId = null;
        s.emit('kicked', { message: 'Host cleared all players.' });
      }
    }
    io.emit('round_reset');
    broadcastPlayers();
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (socket.data.deviceId) {
      const player = game.markDisconnected(socket.id);
      if (player) broadcastPlayers();
    }
  });
});

/* --------------------------------- Start --------------------------------- */

server.listen(PORT, HOST, () => {
  const ip = primaryLanAddress();
  const others = lanAddresses()
    .filter((a) => a.address !== ip)
    .map((a) => `           http://${a.address}:${PORT}`);

  console.log('');
  console.log('  OffBuzz is running (offline / LAN only)');
  console.log('  ---------------------------------------');
  console.log(`  Master:  http://${ip}:${PORT}/master`);
  console.log(`  Players: http://${ip}:${PORT}/`);
  if (others.length) {
    console.log('  Other interfaces:');
    others.forEach((line) => console.log(line));
  }
  console.log(`  Listening on ${HOST}:${PORT}  |  max ${MAX_PLAYERS} players`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});
