# OffBuzz

An offline, LAN-only buzz-in quiz buzzer. One device — a MacBook or an Android
tablet — runs the server and the host screen; up to 6 phones join over a Wi-Fi
hotspot and act as buzzers. First press wins, a buzzer sounds, the winner's name
blinks on the host screen, and everyone else is locked out until the host resets.

No internet, no cloud, no accounts, no database. Once `npm install` has run once,
the whole thing works with the Wi-Fi radio pointed at a phone hotspot and nothing
else.

---

## 1. Install and run on the MacBook

```bash
npm install
npm start
```

The server prints the addresses to use:

```
  OffBuzz is running (offline / LAN only)
  ---------------------------------------
  Master:  http://192.168.1.23:3000/master
  Players: http://192.168.1.23:3000/
  Listening on 0.0.0.0:3000  |  max 6 players
```

Open the Master URL on the MacBook. It listens on `0.0.0.0`, so phones on the same
network can reach it — `localhost` alone would not be enough.

To use a different port: `PORT=4000 npm start`.

## 1b. Running it on an Android tablet instead (no laptop)

The tablet can run the server *and* show the Master screen, with the phones
joining it exactly as before. Nothing about the game changes — it is the same
project, just hosted on Android via [Termux](https://termux.dev).

All three dependencies are pure JavaScript with no native code, so **you can copy
the project folder including `node_modules` straight onto the tablet and never run
`npm install` there.** That also means the tablet needs no internet, ever.

**One-time setup**

1. Install **Termux** on the tablet from F-Droid or GitHub releases. (The old
   Play Store build is abandoned and will fail.)
2. In Termux: `pkg update && pkg install nodejs`
3. Give Termux access to shared storage: `termux-setup-storage`
4. Copy the whole `OffBuzz` folder (with `node_modules`) to the tablet over USB,
   then move it into Termux's home:
   ```bash
   cp -r /sdcard/Download/OffBuzz ~/OffBuzz
   ```

**Every session**

```bash
termux-wake-lock          # stops Android from killing the server
cd ~/OffBuzz && npm start
```

Then, on the tablet itself, open Chrome at **http://localhost:3000/master**. Leave
Termux running in the background — the notification shade will show it is alive.
`termux-wake-unlock` releases it afterwards.

The phones join using the IP shown on the Master screen, the same as before. If
the **tablet** is the hotspot, that is usually `192.168.43.1`; if the tablet joins
the phone's hotspot, it gets an ordinary address. Both work.

**If the QR code shows the wrong address**, Android may be reporting its
interfaces in a way the auto-detection does not expect. Force it:

```bash
HOST_IP=192.168.43.1 npm start
```

Android has no incoming-connection firewall prompt, so the macOS firewall step
below does not apply. Two Android-specific things do matter, though: keep the
tablet's screen on (the Master screen requests a wake lock automatically when
opened at `localhost`, but battery savers can still override it), and exclude
Termux from battery optimisation so Android does not suspend it mid-quiz.

## 2. Phone hotspot setup (Samsung Galaxy)

1. On the Galaxy: **Settings → Connections → Mobile Hotspot and Tethering → Mobile Hotspot** → turn it on.
2. Note the network name and password. Mobile data does **not** need to be on — the
   hotspot still creates a local network, which is all OffBuzz uses.
3. On the MacBook, join that hotspot from the Wi-Fi menu.
4. Join every player phone to the same hotspot.

Everything must be on that one hotspot. A phone left on mobile data or a different
Wi-Fi network cannot reach the MacBook.

## 3. Find the host device's IP

The Master screen shows it in large type next to a QR code, which is the easiest
path. If you need it from a terminal:

```bash
ipconfig getifaddr en0   # macOS Wi-Fi
ip addr show wlan0       # Android / Termux
```

If that prints nothing, try `en1`, or run `ifconfig | grep "inet "` and pick the
`192.168.x.x` / `10.x.x.x` address. The Master screen also lists any other
candidate addresses under the QR code if the machine has more than one.

Whichever address you settle on, `HOST_IP=<address> npm start` forces the Master
screen and QR code to advertise exactly that one.

## 4. How players join

1. Player opens the phone camera and scans the QR code on the Master screen, or
   types `http://<MACBOOK_IP>:3000` into a mobile browser.
2. They type a name (1–20 characters) and tap **Join game**. They only ever do
   this once — after that the phone re-seats itself automatically, even across a
   refresh.
3. The name appears in the Master's player list. The buzzer is shown but stays
   dark until the host opens the round.
4. Host taps **Open Buzzers** — every phone's button lights up red.
5. First tap wins. The buzzer sounds on the MacBook, the winner's name blinks on
   the Master screen, and all other phones lock.
6. Host taps **Reset Round** to go again.

Host keyboard shortcuts: `Space` toggles open/reset, `R` resets.

## 5. Firewall note (macOS only)

macOS may ask whether to allow incoming connections for Node the first time you
run it. **Allow it** — otherwise the phones will not be able to connect.

To check or fix it later: **System Settings → Network → Firewall → Options**, and
make sure `node` is allowed to receive incoming connections (or turn the firewall
off for the duration of the quiz). If phones can see the Wi-Fi but the page never
loads, this is almost always the cause.

---

## How it works

The server is the only source of truth for who buzzed first. Phones lock their own
buttons immediately for responsiveness, but that is just cosmetic — the server
accepts a buzz only while the round is `open`, and the first one it receives ends
the round. Every later buzz is ignored regardless of what the phone's UI shows.

**Round states:** `lobby` → `open` (host tapped Open Buzzers) → `locked` (someone
buzzed) → back to `lobby` on reset.

### Socket.IO protocol

Player → server:

| Event | Payload |
| --- | --- |
| `join` | `{ deviceId, name }` |
| `buzz` | `{ deviceId }` |

Master → server: `master_hello`, `open_buzzers`, `reset_round`, `kick_player { deviceId }`, `clear_players`.
Only a socket that has sent `master_hello` may use the control events.

Server → clients:

| Event | Payload |
| --- | --- |
| `state` | full snapshot: `{ roundState, winner, players, maxPlayers }` |
| `players` | current player list |
| `round_open` | — |
| `locked` | `{ winnerDeviceId, winnerName, reactionMs }` |
| `round_reset` | — |
| `joined` | `{ deviceId, name, rejoined }` |
| `kicked` | `{ message }` |
| `error` | `{ message }` |

Rules enforced server-side: max 6 players, names sanitised to 1–20 characters and
required to be unique, buzzes accepted only in the `open` state, a 250 ms
per-device debounce, and control events restricted to the Master socket.

### Auto-seating, reconnects and disconnects

Each browser generates a UUID once and keeps it in `localStorage`, along with the
last name used and a seated flag. A refresh, an accidental back-navigation, a
screen lock, or a brief Wi-Fi drop therefore reclaims the same seat automatically
— the phone goes straight back to the buzzer without retyping a name, and it
comes back into whatever the round is currently doing (still armed, still holding
a win, still locked out by someone else).

The seat is given up only when the host kicks that player or clears everyone.
**Reset Round does not unseat anyone.** Because the gate is normally skipped after
the first join, the buzzer screen carries a small **Not you? Change name** link
that returns to it; rejoining keeps the same seat under the new name.

A player who drops is marked offline (red dot on the Master) rather than deleted,
so the roster stays stable mid-game. If the winner disconnects, the round stays
locked until the host resets — their name remains on screen.

If the room is full and someone new joins, the seat of the player who has been
offline longest is recycled.

## Project layout

```
server/
  index.js     Express routes, Socket.IO wiring, startup banner
  state.js     Game state machine and all the rules
  network.js   LAN IP detection
public/
  master.html  Host screen
  player.html  Phone buzzer
  css/         base.css, master.css, player.css
  js/          common.js, master.js, player.js
  sounds/      buzzer.wav (generated locally)
scripts/
  make-buzzer.js   Regenerates the buzzer sound: npm run make-sound
  smoke-test.js    End-to-end check: npm run smoke
  test-network.js  Join-address selection: npm run test:network
```

## Testing without phones

With the server running in one terminal:

```bash
npm run smoke
```

This simulates a host plus 7 phones and asserts the whole flow: six join and the
seventh is refused, buzzes before the round opens are ignored, six simultaneous
buzzes produce exactly one winner that every client agrees on, post-lock buzzes do
nothing, reset works, and a player socket cannot open the buzzers. It also covers
auto-seating: a phone that drops and comes back mid-round keeps its seat, the
roster size, and its win, and a seated player can rename but not onto a name
someone else already has.

The buzzer sound is generated by `scripts/make-buzzer.js` rather than downloaded,
so there is no audio asset to fetch. Edit that file and run `npm run make-sound`
to change it. If the WAV cannot play for any reason, the Master falls back to a
synthesised Web Audio buzz.

Browsers block audio until the page has been interacted with. The host clicking
anywhere on the Master screen (including **Open Buzzers**) primes it, so in normal
use the first buzz is audible.
