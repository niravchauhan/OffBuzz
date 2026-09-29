/* Shared helpers for both views. Loaded before master.js / player.js. */

function $(id) {
  return document.getElementById(id);
}

function showToast(message, ms = 2200) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function setConnected(connected) {
  const dot = $('conn-dot');
  const text = $('conn-text');
  if (dot) dot.className = `dot ${connected ? 'on' : 'off'}`;
  if (text) text.textContent = connected ? 'Connected' : 'Offline';
}

/** Stable per-browser id, persisted so a refresh or reconnect keeps the seat. */
function getDeviceId() {
  const KEY = 'offbuzz.deviceId';
  let id = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    /* private mode */
  }
  if (!id) {
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

function storage(key) {
  return {
    get() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
  };
}

function connectSocket() {
  return io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 400,
    reconnectionDelayMax: 2000,
    timeout: 6000,
  });
}
