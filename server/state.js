'use strict';

const MAX_PLAYERS = 6;
const NAME_MIN = 1;
const NAME_MAX = 20;
const BUZZ_DEBOUNCE_MS = 250;

/**
 * Authoritative game state. The clients mirror this, but every rule is
 * enforced here so a tampered browser cannot steal a round.
 */
class GameState {
  constructor() {
    /** @type {Map<string, {deviceId:string,name:string,connected:boolean,socketId:string|null,joinedAt:number,lastSeen:number,lastBuzzAt:number,wins:number}>} */
    this.players = new Map();
    this.roundState = 'lobby'; // lobby | open | locked
    this.winner = null; // { deviceId, name, at, reactionMs }
    this.openedAt = null;
  }

  static sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    // Collapse whitespace, strip control chars, clamp length.
    return raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_MAX);
  }

  static isValidDeviceId(raw) {
    return typeof raw === 'string' && raw.length >= 8 && raw.length <= 64 && /^[A-Za-z0-9._-]+$/.test(raw);
  }

  /**
   * @returns {{ok:true, player:object, rejoined:boolean} | {ok:false, message:string}}
   */
  join(deviceId, rawName, socketId) {
    if (!GameState.isValidDeviceId(deviceId)) {
      return { ok: false, message: 'Invalid device id. Clear site data and retry.' };
    }
    const name = GameState.sanitizeName(rawName);
    if (name.length < NAME_MIN) {
      return { ok: false, message: 'Name is required.' };
    }

    const nameTakenBy = (excludeDeviceId) =>
      [...this.players.values()].some(
        (p) => p.deviceId !== excludeDeviceId && p.name.toLowerCase() === name.toLowerCase()
      );

    const existing = this.players.get(deviceId);
    if (existing) {
      // Reclaiming a seat, either after a refresh or when changing name.
      if (nameTakenBy(deviceId)) {
        return { ok: false, message: 'That name is already taken. Pick another.' };
      }
      existing.name = name;
      existing.connected = true;
      existing.socketId = socketId;
      existing.lastSeen = Date.now();
      return { ok: true, player: existing, rejoined: true };
    }

    if (nameTakenBy(null)) {
      return { ok: false, message: 'That name is already taken. Pick another.' };
    }

    if (this.players.size >= MAX_PLAYERS) {
      // Reclaim the slot of the player who has been offline the longest.
      const stale = [...this.players.values()]
        .filter((p) => !p.connected)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!stale) {
        return { ok: false, message: `Room is full (${MAX_PLAYERS} players).` };
      }
      this.players.delete(stale.deviceId);
    }

    const player = {
      deviceId,
      name,
      connected: true,
      socketId,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      lastBuzzAt: 0,
      wins: 0,
    };
    this.players.set(deviceId, player);
    return { ok: true, player, rejoined: false };
  }

  /**
   * @returns {{ok:true, winner:object} | {ok:false, message:string, silent?:boolean}}
   */
  buzz(deviceId, socketId) {
    const player = this.players.get(deviceId);
    if (!player) return { ok: false, message: 'You are not in this game. Rejoin.' };
    if (player.socketId && socketId && player.socketId !== socketId) {
      return { ok: false, message: 'Session mismatch. Rejoin.' };
    }

    const now = Date.now();
    if (now - player.lastBuzzAt < BUZZ_DEBOUNCE_MS) {
      return { ok: false, message: 'Buzz ignored (too fast).', silent: true };
    }
    player.lastBuzzAt = now;

    if (this.roundState !== 'open') {
      return {
        ok: false,
        message: this.roundState === 'locked' ? 'Round is locked.' : 'Buzzers are not open yet.',
        silent: true,
      };
    }

    this.roundState = 'locked';
    player.wins += 1;
    this.winner = {
      deviceId: player.deviceId,
      name: player.name,
      at: now,
      reactionMs: this.openedAt ? now - this.openedAt : null,
    };
    return { ok: true, winner: this.winner };
  }

  openRound() {
    this.roundState = 'open';
    this.winner = null;
    this.openedAt = Date.now();
    for (const p of this.players.values()) p.lastBuzzAt = 0;
  }

  resetRound() {
    this.roundState = 'lobby';
    this.winner = null;
    this.openedAt = null;
    for (const p of this.players.values()) p.lastBuzzAt = 0;
  }

  kick(deviceId) {
    const player = this.players.get(deviceId);
    if (!player) return null;
    this.players.delete(deviceId);
    return player;
  }

  clearPlayers() {
    const removed = [...this.players.values()];
    this.players.clear();
    this.resetRound();
    return removed;
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        p.socketId = null;
        p.lastSeen = Date.now();
        return p;
      }
    }
    return null;
  }

  playerList() {
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        connected: p.connected,
        wins: p.wins,
      }));
  }

  snapshot() {
    return {
      roundState: this.roundState,
      winner: this.winner,
      players: this.playerList(),
      maxPlayers: MAX_PLAYERS,
    };
  }
}

module.exports = { GameState, MAX_PLAYERS, NAME_MAX, BUZZ_DEBOUNCE_MS };
