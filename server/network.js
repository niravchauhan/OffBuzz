'use strict';

const os = require('os');

/**
 * Interfaces that are never the right join address. `rmnet*`/`ccmni*` are
 * Android mobile-data interfaces: they have a real IP from the carrier, but
 * phones on the local hotspot cannot reach it, so advertising one would hand
 * out a QR code that goes nowhere.
 */
const IGNORED = /^(lo|utun|awdl|llw|bridge|gif|stf|anpi|rmnet|ccmni|dummy|p2p|tun|tap)/i;

/** Wi-Fi client interfaces: macOS `en0`, Android `wlan0`. */
const WIFI_CLIENT = /^(en0|wlan0)$/i;

/**
 * Hotspot / SoftAP interfaces, used when this device is itself the hotspot.
 * Samsung uses `swlan0`, stock Android `ap0`; `rndis0` is USB tethering.
 */
const HOTSPOT = /^(ap\d|swlan\d|wlan[1-9]|rndis\d|usb\d)/i;

function isPrivate(ip) {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Best-guess LAN IPv4 addresses for this machine, most likely first.
 * On a MacBook joined to a phone hotspot this is normally `en0`; on an Android
 * tablet it is `wlan0` when joined to a hotspot, or `ap0`/`swlan0` when the
 * tablet is itself the hotspot.
 *
 * @param {object} [nets] injectable `os.networkInterfaces()` result, for tests
 */
function lanAddresses(nets) {
  if (!nets) {
    try {
      nets = os.networkInterfaces();
    } catch {
      return []; // Sandboxed/restricted environments: fall back to loopback.
    }
  }
  const found = [];

  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      const family = typeof addr.family === 'string' ? addr.family : `IPv${addr.family}`;
      if (family !== 'IPv4') continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // link-local, not routable
      found.push({ iface: name, address: addr.address });
    }
  }

  const rank = (entry) => {
    if (IGNORED.test(entry.iface)) return 5;
    if (WIFI_CLIENT.test(entry.iface)) return 0;
    if (HOTSPOT.test(entry.iface)) return 1;
    if (/^en\d/i.test(entry.iface)) return 2; // other macOS interfaces
    return isPrivate(entry.address) ? 3 : 4;
  };

  return found
    .map((entry) => ({ ...entry, rank: rank(entry) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ iface, address }) => ({ iface, address }));
}

/**
 * The address players should point their phones at. `HOST_IP` overrides the
 * guess entirely, which is the escape hatch when a device names its interfaces
 * in some way this does not predict.
 */
function primaryLanAddress() {
  if (process.env.HOST_IP) return process.env.HOST_IP.trim();
  const [first] = lanAddresses();
  return first ? first.address : '127.0.0.1';
}

module.exports = { lanAddresses, primaryLanAddress };
