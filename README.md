# SpeakEasy

How much of the meeting are you doing the talking? Served at
**https://aditya-h.com/speakeasy/**.

Everyone in the meeting opens the page on their own laptop and joins the same
room. Each browser listens only to **its own** microphone, decides when its
person is speaking, and reports a running total. The room shows everyone's talk
time and share live, against an even-share mark. Anyone in the room can start
or end the meeting, and every client's clock follows that one switch.

**Audio never leaves the laptop.** Only the totals do.

## How it works

```
web/vad-worklet.js   voice detection on the audio thread (AudioWorklet)
web/app.js           mic graph, reporting, rendering the room
server.js            rooms, meeting toggle, totals; SSE fan-out. Zero dependencies
deploy/speakeasy.service
test/server.test.mjs
```

- **Detection.** Mic → highpass 120Hz → lowpass 3.4kHz → worklet. Every 20ms the
  worklet takes the level in dB and tracks the room's noise floor (falls fast,
  rises slowly). Speech is the level sitting `sensitivity` dB above the floor for
  60ms; it stays "speaking" for 350ms after, so gaps between words count. It is
  an AudioWorklet rather than a timer loop because during a meeting the tab is in
  the background, where browsers throttle timers to once a second or less; the
  audio thread is not throttled, and its messages also drive the reporting.
- **Headphones matter.** Echo cancellation only removes audio *this browser*
  plays. If Zoom/Meet/Teams plays through the laptop speakers, the mic hears the
  others and some of their talking counts as yours. Raising the sensitivity helps;
  headphones fix it.
- **Trust.** The client is the only thing that can hear its person, so the server
  trusts it about *whether* they are speaking, but not about how long: a total only
  goes up, by at most the wall time since the last report, and never past the
  meeting's length.
- **Rooms** are an 8-character code (about 40 bits). Joining hands out a
  per-participant secret that every write needs, so knowing the code gets you in
  but does not let you report for somebody else. Rooms live in memory, are
  snapshotted to `SPEAKEASY_STATE_FILE` every 15s and on shutdown. **A room
  closes when its last person presses Leave**, or 10 minutes after everyone has
  closed the page (no open streams, no reports), and in any case after 12 idle
  hours. Pages still open on it get an SSE `closed` event and say so. Caps: 200
  rooms, 24 people a room, 2KB bodies.

## API

All under `/speakeasy/api/` in production (nginx strips the prefix).

| | |
| --- | --- |
| `POST rooms` | create → `{room}` |
| `POST rooms/:code/join {name}` | → `{id, secret}` |
| `GET rooms/:code` | snapshot |
| `GET rooms/:code/events` | SSE stream of snapshots |
| `POST rooms/:code/report {secret, speaking, micOn, meetingId, ms}` | |
| `POST rooms/:code/meeting {secret, active}` | start / end |
| `POST rooms/:code/leave {secret}` | |
| `GET health` | |

## Run it locally

```bash
npm start            # http://127.0.0.1:3008
npm test
```

`getUserMedia` needs a secure context. `localhost` counts; a LAN IP does not.

## Deploy (aditya-h.com)

The droplet is **157.230.55.192** (`ssh aditya-h`). The site's README in
`aditya-h/` covers the box as a whole. This repo is public, so no deploy key is
needed.

```bash
cd /opt/speakeasy && git pull && systemctl restart speakeasy
curl -s localhost:3008/api/health
```

No build, no `npm ci`. The restart keeps rooms: the state is saved on SIGTERM
and reloaded on start.

First time only:
```bash
git clone https://github.com/Aditya-H2O/SpeakEasy.git /opt/speakeasy
cp /opt/speakeasy/deploy/speakeasy.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now speakeasy
curl -s localhost:3008/api/health          # before touching nginx
```

**Gate first, then nginx.** `/speakeasy` is in Gate's `ROOM_PREFIXES` (every
method passes the door; the app checks the room). nginx has the `/speakeasy/`
proxy block plus 301s from `/speakeasy` and `/SpeakEasy`. **When the site is in
private mode, SpeakEasy is closed with everything else**, so people without the
admin login cannot join.
