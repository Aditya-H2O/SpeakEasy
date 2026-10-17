# SpeakEasy

How much of the meeting are you doing the talking? Served at
**https://aditya-h.com/speakeasy/**, and as a Chrome side-panel extension.

Everyone in the meeting opens SpeakEasy on their own laptop and joins the same
room. Each browser listens only to **its own** microphone, works out when its
person is speaking, and turns what they say into text. The room shows
everyone's talk time and share live, beside a running transcript. A small
open-weight AI model on the server flags anything out of pocket, and the host
gets the transcript with its flags at the end.

## What it does

**In the room** (left column: talk time, your notes, your to-do list; right:
the transcript in its own scrolling pane; one column on narrow screens):

- **Talk time.** Each person's time and share, who is speaking now, an even-share
  tick, and the host's speak-up threshold tick.
- **Host and meeting plan.** Whoever creates a room is its host. Only the host
  starts and ends the meeting, and must first enter the **expected length** and a
  **speak-up threshold** (a percentage of the talking).
- **Speak-up nudge.** At the halfway point of the planned length, anyone whose
  share is under the threshold gets a closable card on screen (and a system
  notification if the page is hidden and they allowed notifications).
- **Pings.** The host has a *Ping* button next to everyone else, with a fixed set
  of quiet messages ("Was there something you wanted to share?", "Please wrap up
  what you're saying, for the sake of time.", short on time, can't hear you,
  background noise, thanks). Only the recipient sees it.
- **Transcript.** Every line has the speaker and a timestamp from the meeting's
  start. Everyone sees it as it is written.
- **Out-of-pocket flags.** Each line is scored by the moderator. Flags are shown
  **to the host only**, with the reason (insult, threat, obscene, ...). The host
  can unflag a line the model got wrong or flag one it missed, filter to flagged
  lines, and **download the transcript as .txt**, during or after the meeting.
- **AI summary.** When the host presses *End meeting*, the host's own Chrome
  summarises the transcript on their computer: decisions, action items, owners.
  It appears at the top of their transcript pane, is saved with the room, and is
  included in the download. It needs desktop Chrome with its built-in AI (Chrome
  138+, roughly 16GB RAM and 22GB free disk, plus a one-time model download).
  Anywhere else the host is told so, and the transcript download still works.
- **Your speaking habits, on your screen only.** A small red card (closable)
  when you use a lot of filler words ("like", "you know", "basically"... over 8
  per 100 words, at most every 3 minutes), and when you start talking over
  someone who was already mid-sentence (at most once a minute). Nobody else sees
  either. Chrome's speech recognition mostly leaves "um" and "uh" out of its
  text, so those are under-counted.
- **The mic bar blinks** whenever no sound is reaching SpeakEasy: mic off,
  unplugged, or sending pure silence. "I'm muted" does not stop it, because that
  box only pauses the counting.
- **Leaving.** Leave takes a confirming second click. Closing or reloading the
  tab asks first. A tab that closes anyway tells the server on its way out, and
  after 15 seconds (a reload comes back sooner and cancels it) you are out of the
  room. A host leaving closes the room for everyone, which frees the one meeting
  slot. A host whose page vanishes without a word (crash, lid closed) closes the
  room after a minute.
- **Close meeting.** The host's button closes the room for everyone (second
  click to confirm) and **deletes the transcript**. Download it first.
- **One meeting at a time**, for now. Starting a second room is refused, and the
  lobby says so, without revealing the running room's code.

**Accounts.** SpeakEasy uses aditya-h.com's existing visitor accounts, the same
sign-in as Grounds Guessr and VS. Making one needs the site's invite code. Sign
in from the lobby; it is optional, and anyone can join a meeting without one.
Signed-in people get a ✓ in the room. SpeakEasy never sees your password hash
or holds the site's session key: it asks Grounds Guessr, over loopback, who your
session cookie belongs to.

**Yours: notes and scheduled meetings.** Signed in, they are saved to your
account on the server (`/mnt/twenty_gb_volume/speakeasy/users/<id>.json`) and
follow you to any device and into the extension. The first sign-in moves this
browser's copy up to an account that is still empty. Signed out, they stay in
this browser only (`localStorage`):

- **Notes** you carry from meeting to meeting. Export to .txt; import .txt
  (appended, never replacing).
- **Scheduled meetings**, each with a **to-do list**. Import a to-do list from a
  .txt file (one item per line; leading `-`, `*`, `1.` or `[ ]` are stripped),
  export it, tick items off. The one you choose to bring (or the one scheduled
  nearest now) shows in the room.

Signed out, the website and the extension each have their own storage, so use
export and import to move things between them, or sign in.

## Privacy, plainly

- **Talk time** is decided on the laptop. Only the totals leave it.
- **Speech-to-text** is Chrome's built-in speech recognition. Where Chrome can
  do it on the device, audio stays on the laptop. Otherwise Chrome sends the
  audio to Google's speech service to transcribe. The page says which is
  happening. SpeakEasy's server only ever receives the text.
- **The transcript** lives in the server's memory (and its restart snapshot)
  while the room exists, and is deleted when the room closes. The room shows a
  notice that the meeting is transcribed and checked. Anyone can untick
  *Transcribe me*.
- **Moderation** runs on the droplet itself, and the **summary** runs in the
  host's own browser. No transcript text goes to any third-party AI service.
- **Accounts:** your notes and scheduled meetings are stored under your account
  on the droplet; only requests carrying your own session can read them.

## How it works

```
web/vad-worklet.js     voice activity detection on the audio thread
web/transcribe.js      speech-to-text for one person (Web Speech API)
web/personal.js        notes, scheduled meetings, to-do lists (account or localStorage)
web/summarize.js       the host's on-device AI summary (Chrome Summarizer API)
accounts.js            who a request is (via Grounds Guessr), and per-account data
web/app.js             the room: mic, reporting, transcript, pings, nudges
server.js              rooms, host, meeting plan, totals, transcript, flags; SSE. Zero dependencies
moderator/             the open-weight model service (onnxruntime-node)
extension/             the Chrome side panel; mostly generated from web/
deploy/                systemd units for both processes
```

- **Talk-time detection.** Mic → highpass 120Hz → lowpass 3.4kHz → AudioWorklet.
  Every 20ms it measures the level and tracks the room's noise floor. Speech is
  the level sitting *sensitivity* dB above the floor for 60ms, with a 350ms
  hangover. It runs on the audio thread because during a meeting the tab is in
  the background, where timers are throttled.
- **Trust.** The server trusts a client about *whether* its person is speaking,
  never about how long: totals only go up, by at most the wall time since the
  last report, and never past the meeting's length. Transcript times are clamped
  inside the meeting too.
- **Rooms** are an 8-character code (about 40 bits) plus a per-participant secret
  for every write. A room closes when the host leaves, when the last person
  leaves, 10 minutes after everyone has closed the page, or after 12 idle hours.

### The moderator

- **Model:** [`minuva/MiniLMv2-toxic-jigsaw-onnx`](https://huggingface.co/minuva/MiniLMv2-toxic-jigsaw-onnx),
  Apache-2.0. A 6-layer MiniLM distilled from `unitary/toxic-bert` on the Jigsaw
  toxic-comment data, int8-quantised to **23MB**. It gives six independent
  probabilities: toxic, severe_toxic, obscene, threat, insult, identity_hate.
  Pinned to one Hugging Face commit and checked by SHA-256 (`fetch-model.js`).
  The weights are not in git.
- **Why this and not an LLM:** the droplet has one vCPU and ~220MB of free RAM.
  This model takes ~6ms a line on a laptop core and ~110MB resident. A chat
  model would not fit.
- **Runtime:** `onnxruntime-node`, one thread, with a hand-written BERT WordPiece
  tokenizer instead of transformers.js, to save resident memory.
  `moderator/test.mjs` checks the tokenizer's ids and the scores against the real
  Hugging Face tokenizer and onnxruntime (`reference.json`).
- **The rule** (`FLAG` in server.js). A line is flagged on its own when its worst
  label is ≥ 0.70. It is also flagged *in context* when the speaker's last three
  lines read together reach ≥ 0.80 and this line itself is ≥ 0.35, because speech
  recognition chops one remark into fragments. Labels ≥ 0.50 are listed as the
  reason.
- **Keeping it from eating the box:**
  - One inference at a time, bounded queues (it answers 503 rather than growing).
  - The model is **released after 10 idle minutes**, so between meetings it is a
    bare ~45MB Node process.
  - systemd: `CPUQuota=50%`, `Nice=10`, idle I/O, `MemoryHigh=160M`, `MemoryMax=220M`.
  - If it is down or killed, SpeakEasy keeps working. Lines wait, shown to the
    host as "checking…", and are scored when it comes back.

## API

All under `/speakeasy/api/` in production (nginx strips the prefix). Bodies
are JSON, capped at 4KB.

| | |
| --- | --- |
| `GET status` | `{full}`: whether a new room would be refused |
| `POST rooms {name}` | create and join as host → `{room, id, secret}` (409 if one is running) |
| `POST rooms/:code/join {name}` | → `{id, secret}` |
| `GET rooms/:code` | snapshot |
| `GET rooms/:code/events` | SSE: snapshots; `line` (new transcript line); `closed` |
| `POST rooms/:code/report {secret, speaking, micOn, transcribing, meetingId, ms}` | → `{pings}` addressed to you |
| `POST rooms/:code/meeting {secret, active, durationMin, thresholdPct}` | host only; plan required to start |
| `POST rooms/:code/ping {secret, to, kind}` | host only, during a meeting |
| `POST rooms/:code/transcript {secret, meetingId, text, startMs, endMs}` | add a line |
| `POST rooms/:code/transcript/read {secret, meetingId?}` | lines; with scores and flags for the host |
| `POST rooms/:code/transcript/flag {secret, n, flagged}` | host only; `null` returns to the model's verdict |
| `POST rooms/:code/leave {secret}` | the host leaving closes the room |
| `POST rooms/:code/transcript/summary {secret, meetingId, text}` | host only, after the meeting ends |
| `GET me` | `{player, accounts}`: who your aditya-h.com session is |
| `GET me/data` / `POST me/data {version, notes, plans, activePlan}` | your saved data; a stale `version` gets 409 and the newer copy |
| `GET health` | |

## Chrome extension

`extension/` is the same app as a Chrome **side panel**. Click the toolbar
button and it opens beside your Meet/Zoom/Teams tab and stays there as you
switch tabs in that window. It uses the same server and rooms, and invite links
point at the web app.

**Install (unpacked):** `chrome://extensions`, turn on Developer mode, click
*Load unpacked*, and pick the `extension/` folder. After pulling changes, click
*reload* on its card.

The first *Turn on microphone* opens a tab to ask for the mic, because a side
panel cannot show Chrome's prompt. Counting and transcription run only while
the panel is open.

| File | |
| --- | --- |
| `manifest.json`, `sw.js`, `config.js`, `permission.*` | hand-written, extension only |
| `sidepanel.html`, `app.js`, `personal.js`, `summarize.js`, `transcribe.js`, `style.css`, `vad-worklet.js`, `icon.svg`, `icons/` | **generated** from `web/` by `npm run build:extension` |

Edit `web/` and re-run the build; never edit the copies. `npm test` fails if
they have drifted.

## Run it locally

```bash
npm start                                    # http://127.0.0.1:3008
cd moderator && npm ci && npm run fetch-model && npm start   # :3009, optional
npm test                                     # server + extension
cd moderator && npm test                     # tokenizer + model, needs the model
```

`getUserMedia` and speech recognition need a secure context. `localhost` counts;
a LAN IP does not. Without the moderator running, lines simply stay unchecked.

## Deploy (aditya-h.com)

The droplet is **157.230.55.192** (`ssh aditya-h`). The site's README in
`aditya-h/` covers the box as a whole. This repo is public, so no deploy key is
needed. The checkout is on the volume: `/opt/speakeasy` → `/mnt/twenty_gb_volume/opt/speakeasy`.

```bash
cd /opt/speakeasy && git pull
install -d -o www-data -g www-data /mnt/twenty_gb_volume/speakeasy/users   # first time
cd moderator && npm ci --omit=dev --ignore-scripts && npm run fetch-model && cd ..
chown -R www-data:www-data /opt/speakeasy/       # trailing slash: it is a symlink
cp deploy/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl restart speakeasy-moderator speakeasy
curl -s localhost:3008/api/health; curl -s localhost:3009/health
```

`--ignore-scripts` is deliberate. onnxruntime-node's install script only fetches
optional GPU providers. The CPU build ships in the package and is all this box
can use.

Restarting `speakeasy` keeps rooms and transcripts: state is saved on SIGTERM
and reloaded on start.

**Gate first, then nginx.** `/speakeasy` is in Gate's `ROOM_PREFIXES` (every
method passes the door; the app checks the room). nginx has the `/speakeasy/`
proxy block (16k body cap, for the summary; the app caps everything else at
4k), a `/speakeasy/api/me/` block (600k, for account data), plus 301s from
`/speakeasy` and `/SpeakEasy`. **When
the site is in private mode, SpeakEasy is closed with everything else.**
