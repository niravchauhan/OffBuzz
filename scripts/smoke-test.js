'use strict';

/**
 * End-to-end check against a running server: `npm start` in one shell,
 * `npm run smoke` in another. Simulates a Master plus 7 phones.
 */

const { io } = require('socket.io-client');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const results = [];

function check(label, passed, detail = '') {
  results.push({ label, passed, detail });
  console.log(`${passed ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  return io(URL, { transports: ['websocket'], forceNew: true });
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

(async () => {
  console.log(`\nOffBuzz smoke test against ${URL}\n`);

  const master = client();
  await connected(master);
  master.emit('master_hello');
  master.emit('clear_players');
  await wait(150);

  const lockedOnMaster = [];
  master.on('locked', (p) => lockedOnMaster.push(p));

  // 7 phones try to join; the 7th must be refused.
  const phones = [];
  const errors = new Map();
  const lockedSeen = new Map();
  const joinedOk = new Set();

  for (let i = 1; i <= 7; i += 1) {
    const socket = client();
    await connected(socket);
    const deviceId = `device-smoke-${i}`;
    socket.on('joined', () => joinedOk.add(i));
    socket.on('error', (p) => errors.set(i, p.message));
    socket.on('locked', (p) => lockedSeen.set(i, p));
    socket.emit('join', { deviceId, name: `Player ${i}` });
    phones.push({ i, socket, deviceId });
  }
  await wait(400);

  check('6 players joined', joinedOk.size === 6, `joined=${joinedOk.size}`);
  check(
    '7th join rejected as room full',
    !joinedOk.has(7) && /full/i.test(errors.get(7) || ''),
    errors.get(7) || 'no error received'
  );

  // Buzzing before the round opens must be ignored.
  phones[0].socket.emit('buzz', { deviceId: phones[0].deviceId });
  await wait(200);
  check('buzz before open is ignored', lockedOnMaster.length === 0);

  // Open the round, then all 6 buzz at once.
  master.emit('open_buzzers');
  await wait(200);

  phones.slice(0, 6).forEach(({ socket, deviceId }) => socket.emit('buzz', { deviceId }));
  await wait(500);

  check('exactly one lock broadcast', lockedOnMaster.length === 1, `got ${lockedOnMaster.length}`);
  const winner = lockedOnMaster[0];
  check('winner name present', Boolean(winner && winner.winnerName), winner && winner.winnerName);
  // The 7th socket is still connected as a spectator, so it sees the broadcast
  // too; what matters is that all six seated players got it.
  const seatedSawLock = [...joinedOk].every((i) => lockedSeen.has(i));
  check('all 6 seated phones saw the lock', seatedSawLock, `sockets notified=${lockedSeen.size}`);
  check(
    'every phone agrees on the winner',
    [...lockedSeen.values()].every((p) => p.winnerDeviceId === winner.winnerDeviceId)
  );

  // Losers buzzing after the lock must change nothing.
  const before = lockedOnMaster.length;
  phones
    .slice(0, 6)
    .filter((p) => p.deviceId !== winner.winnerDeviceId)
    .forEach(({ socket, deviceId }) => socket.emit('buzz', { deviceId }));
  await wait(400);
  check('post-lock buzzes ignored', lockedOnMaster.length === before);

  // Reset, then a different phone should be able to win.
  let resetSeen = 0;
  phones.slice(0, 6).forEach(({ socket }) => socket.on('round_reset', () => (resetSeen += 1)));
  master.emit('reset_round');
  await wait(300);
  check('reset reached all phones', resetSeen === 6, `saw=${resetSeen}`);

  master.emit('open_buzzers');
  await wait(200);
  const second = phones.find((p) => p.deviceId !== winner.winnerDeviceId);
  second.socket.emit('buzz', { deviceId: second.deviceId });
  await wait(300);
  check(
    'second round locks for a new winner',
    lockedOnMaster.length === 2 && lockedOnMaster[1].winnerDeviceId === second.deviceId,
    lockedOnMaster[1] && lockedOnMaster[1].winnerName
  );

  // Debounce: a rapid repeat from the same device must not re-lock.
  master.emit('reset_round');
  await wait(150);
  master.emit('open_buzzers');
  await wait(150);
  second.socket.emit('buzz', { deviceId: second.deviceId });
  second.socket.emit('buzz', { deviceId: second.deviceId });
  await wait(300);
  check('duplicate rapid buzz does not double-lock', lockedOnMaster.length === 3);

  // Non-master sockets must not be able to drive the round.
  const spoof = phones[0];
  let unauthorized = null;
  spoof.socket.on('error', (p) => (unauthorized = p.message));
  master.emit('reset_round');
  await wait(150);
  spoof.socket.emit('open_buzzers');
  await wait(250);
  check('player cannot open buzzers', /not authorized/i.test(unauthorized || ''), unauthorized);

  // Auto-seat: a refresh mid-round must keep the seat, the roster and the winner.
  master.emit('reset_round');
  await wait(150);
  master.emit('open_buzzers');
  await wait(150);
  const refresher = phones[2];
  refresher.socket.emit('buzz', { deviceId: refresher.deviceId });
  await wait(300);

  refresher.socket.close(); // the tab going away
  await wait(300);

  const reborn = client();
  await connected(reborn);
  let rejoined = null;
  let snapshot = null;
  reborn.on('joined', (p) => (rejoined = p));
  reborn.on('state', (s) => (snapshot = s));
  reborn.emit('join', { deviceId: refresher.deviceId, name: `Player ${refresher.i}` });
  await wait(400);

  check('refreshed phone is re-seated', Boolean(rejoined && rejoined.rejoined === true));
  check('roster still holds 6 players', snapshot && snapshot.players.length === 6,
    snapshot ? `players=${snapshot.players.length}` : 'no snapshot');
  check(
    'refreshed winner keeps the locked round',
    snapshot &&
      snapshot.roundState === 'locked' &&
      snapshot.winner &&
      snapshot.winner.deviceId === refresher.deviceId,
    snapshot ? snapshot.roundState : 'no snapshot'
  );

  // A seated player may rename, but not onto someone else's name.
  let renameError = null;
  reborn.on('error', (p) => (renameError = p.message));
  reborn.emit('join', { deviceId: refresher.deviceId, name: 'Player 1' });
  await wait(300);
  check('rename onto a taken name is rejected', /already taken/i.test(renameError || ''), renameError);

  renameError = null;
  reborn.emit('join', { deviceId: refresher.deviceId, name: 'Renamed' });
  await wait(300);
  check(
    'rename to a free name works and keeps the seat',
    snapshot && snapshot.players.length === 6 && snapshot.players.some((p) => p.name === 'Renamed'),
    renameError || ''
  );

  reborn.close();
  master.emit('clear_players');
  await wait(150);

  phones.forEach(({ socket }) => socket.close());
  master.close();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
