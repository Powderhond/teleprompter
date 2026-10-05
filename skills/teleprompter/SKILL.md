---
name: teleprompter
description: "Spin up a localhost teleprompter and recorder. Picks any camera or microphone (external gear included), scrolls a script at a pace you control, optionally replaces the background and meters your gaze, then hands the finished take back to this session. Use when the task needs the user's own voice or face: a voiceover, a demo narration, a screencast read, a founder clip, a podcast segment, or any recording that has to be read from a script."
---

# Teleprompter

A capture station that runs on localhost and hands its output back to the session that
launched it. Everything records in the browser, so there is no ffmpeg, Python, or torch
in the capture path.

Every command below runs a script inside this skill's folder. `${CLAUDE_SKILL_DIR}` is that
folder. If it shows up unexpanded, use the base directory printed when this skill loaded.

## When to invoke

- The task needs the user's voice or face, and a script exists or can be written
- A screencast or demo needs narration timed to what is on screen
- The user says "let me record that", "I'll read it", "voiceover", "talking head", "take two"
- A previous take needs re-recording at a different pace

Not for: editing existing footage (see **Post pass** below), or text-to-speech.

## Run it

One command, from the user's project folder. It starts the server **detached**, opens the
browser, and returns immediately. The server keeps running after the command exits, which
is the whole point: a session is minutes of reading, re-reading and running a correction
pass, and anything that holds the process open gets reaped long before that.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --task "intro voiceover for the partner demo"
```

```
  Teleprompter ready   http://localhost:4455/
  Task                 intro voiceover for the partner demo
  Session folder       .teleprompter/2026-10-01-211040-intro-voiceover
```

Give the person that URL and let them record. **Do not run `server.mjs` directly in a
foreground or background shell** and do not wait on it: it blocks, and when the shell is
reaped the session dies mid-take.

Launching again while one is up reuses it rather than piling up servers. Add `--restart`
for a fresh session.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --status   # is one running, which task, which folder
node "${CLAUDE_SKILL_DIR}/scripts/launch.mjs" --stop     # shut it down
```

Then read the take whenever they say they are done:

```bash
cat .teleprompter/latest.json
```

Recordings land in `.teleprompter/` in the current folder. If that folder is a git repo
and `.teleprompter/` is not ignored yet, offer to add it to `.gitignore`.

### Options

| Flag | Effect |
|---|---|
| `--task "<label>"` | What the recording is for. Shows in the app, lands in the manifest. |
| `--script <file>` | Script to read. Markdown or plain text. `-` reads stdin. |
| `--text "<words>"` | Inline script instead of a file. |
| `--audio-only` | Microphone only. Records m4a or opus. |
| `--out <dir>` | Session root. Default `.teleprompter`. Pass the same value to `--status` and `--stop`. |
| `--port <n>` | Default 4455, climbs if busy. |
| `--no-open` | Do not launch a browser. |
| `--restart` | Replace a running session with a fresh one. |
| `--wait` | Only for `server.mjs` run directly: exit after the first submitted take. The launcher does not use it. |

The server stays up for as many takes as the person wants, and every submit rewrites
`.teleprompter/latest.json`.

## Script format

Blank lines separate blocks. Each block gets its own pace slot and its own cue.

```
# Section heading, not read aloud

The words you actually say. Keep blocks short, because the column is narrow
and short blocks give the pace engine something honest to work with.

(( direction for the reader, not read aloud ))

---

A beat.
```

Pace is words per minute against the real word count, so headings, directions, and beats
do not inflate the clock. The panel shows the spoken word count and the estimated
duration before a single frame is recorded, which is the number to check when a take has
to fit a slot.

## What the user does

1. Pick camera and microphone from the dropdowns. External gear shows up after
   **Rescan devices**.
2. Drag the **lens marker** to where the camera physically sits on the screen.
3. Press **F** to go live. The reading band jumps to the lens, the panel slides away.
4. Press **R** to record. Three second countdown, then the scroll starts.
5. Press **R** again to stop, then **Submit for task**.

Keys: `Space` scroll/pause · `R` record · `↑`/`↓` pace · `←`/`→` jump block · `T` retake ·
`Home` back to top · `F` go live · `Shift+F` fullscreen · `M` mirror for a beam splitter ·
`B` background · `G` gaze meter · `Esc` back to setup.

**Go live takes the whole screen.** Browser chrome sits across the top, which is where the
camera is and where the reading band wants to be, so `F` and the Go live button ask for
real fullscreen as well as clearing the panel. `Shift+F` or the Fullscreen button toggles
it on its own. Escape leaves fullscreen first and the reading view second, so one press
does not dump you back into setup.

**Back to top** and **Retake** also sit beside the reading line, at band height, so a bad
read does not mean a trip to the panel. Retake drops the newest take and resets the
scroll. Every take is still written to disk the moment it stops, because losing a good
read to a misclick is worse than keeping a bad one; **Discard** on a take deletes the file
for real. A take already submitted cannot be discarded.

## Gaze and background

Both run on MediaPipe models (Apache-2.0) in WASM, downloaded once into this skill's
folder:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fetch-models.mjs"           # downloads about 23 MB, checks SHA-256
node "${CLAUDE_SKILL_DIR}/scripts/fetch-models.mjs" --check   # status only
```

Every byte is hashed into `models.lock.json`, and a later fetch that disagrees fails
instead of swapping code that runs with camera access.

**Background** replacement is real and burns into the recording: blur, solid colour, or
an image, composited through `selfie_segmenter.tflite` on a canvas pipeline.

**Gaze** works in two stages, and the difference matters when you describe it:

- *Live*: the meter reads iris position and head aim against a baseline you set by
  looking into the lens, scores every frame, and reports `onLensPct` with the take.
  Parking the reading band at the lens marker is what actually fixes an eyeline; the
  meter tells you whether it worked.
- *After the take*: **Correct gaze** on a take card runs a pass that warps the iris
  toward that baseline and writes a **new take beside the original**, so both can be
  played and the better one submitted. Strength is adjustable in the Gaze panel.

**Correct gaze runs outside the browser.** The page asks the server, which decodes every
frame with ffmpeg, corrects each one in a headless browser, and re-encodes with the
original audio. It takes minutes, not seconds, and it is worth it: the in-browser version
had to keep up with playback and was dropping roughly a quarter of the frames, which is
what made its output judder. The offline pass also gets two things the live one cannot:

- **A clean plate.** Across a whole take the iris wanders, so medianing the eye region
  over every frame where the iris was not covering a pixel builds a photograph of the eye
  with the iris removed. The band a raised iris vacates is then filled with real sclera,
  lid and lash rather than a colour guessed from one frame. Coverage is reported; 94% is
  typical.
- **Centred smoothing.** Every frame's landmarks are known before anything is drawn, so
  the displacement is smoothed with a window centred on each frame. A running average can
  only look backwards, so it lags and passes jitter through.

Its output is a normal progressive MP4, so unlike the recorder's own files it seeks and
reports its duration honestly.

It needs ffmpeg and Playwright. Playwright comes from `npm install` in the teleprompter
repo. For ffmpeg:

```bash
winget install --id Gyan.FFmpeg -e     # Windows
brew install ffmpeg                    # macOS
node "${CLAUDE_SKILL_DIR}/scripts/gaze-pass.mjs" --in take-01.mp4   # also runs standalone
```

Be accurate about what the correction is: **geometry, not a generative model**. The iris
is treated as a disc in front of a background. The hole it currently occupies is filled
with the sclera beside it, the iris is composited at its new position with a soft edge,
and the whole thing is masked by the eye opening so lids and skin are never touched. It
cannot open a lid wider, repaint a highlight, or invent an eye that was not there.

**Preview before committing to a pass.** The Preview gaze button warps a single frame and
shows it beside the original, which takes a second instead of the length of the take.

**How far it will go is capped by the face, not the slider.** The shift is limited by both
the iris radius and the gap between the lids, so past a certain strength the slider stops
having an effect and the readout says so. On a 720p take at normal framing an eye opening
is around 19 px tall, which leaves room for about 5 px of movement. If a correction needs
to be bigger than that, the camera is in the wrong place and no amount of strength will
rescue it. More pixels on the eye, from 1080p or closer framing, buys real headroom.

If the models are not downloaded, the app still records. The two toggles report why they
are off instead of silently doing nothing.

## Recording integrity

Chrome's MP4 recorder can stop emitting the `ftyp`/`moov` initialisation segment once its
hardware encoder has been reused, leaving a run of bare `moof` fragments: right size,
right duration, unplayable anywhere. This bit a real session, where takes three onward
were silently unusable.

Three things now stop that reaching you:

1. Each take records from its own cloned tracks, so the encoder starts cold.
2. Every take is inspected before it is called saved. A missing init segment is spliced
   back from this session's first healthy take, and the repair is only accepted if the
   file then actually opens.
3. After saving, the file is loaded back to prove it opens. If it does not, the take is
   marked and the session switches to WebM for the next one.

Takes also stream from disk rather than from blobs held in the page, so the fourth take
plays as readily as the first.

## Post pass

For footage recorded elsewhere, a background change after a good take, or model-based
gaze redirection beyond what the built-in warp does:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/enhance.mjs" --check         # what is installed, what it unlocks
node "${CLAUDE_SKILL_DIR}/scripts/enhance.mjs" --install-plan  # exact commands for the gaps
node "${CLAUDE_SKILL_DIR}/scripts/enhance.mjs" --in take-01.mp4 --background blur:24
```

This path needs ffmpeg plus a Python provider. `--check` reports what is missing rather
than failing mid-run. Gaze redirection has no turnkey open-source package;
`--install-plan` names the research repos and the adapter contract to drop in at
`scripts/vendor/gaze/redirect.py`.

## Verify after changing any of this

From the teleprompter repo, after `npm install`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/verify.mjs"          # headless, synthetic camera and mic
node "${CLAUDE_SKILL_DIR}/scripts/verify.mjs" --headed # watch it
node "${CLAUDE_SKILL_DIR}/scripts/qc-gaze.mjs" --in <take.mp4>   # eye-level before/after sheet
```

The checks cover script parsing, pace maths, device pickers, the scroll engine,
segmentation, the gaze meter, a real recording, the WebVTT cue track, the submit handoff,
the container guard, discard, and the gaze warp.

Two of those are worth knowing about. It asserts contrast on **painted pixels**, not
computed CSS, because a translucent overlay will dim the prompter while
`getComputedStyle` still reports white. And it rebuilds the broken-container failure from
a healthy recording, confirms that shape really is unplayable, and checks the repair
fixes it, so the guard cannot rot into theatre.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No camera prompt, blank picker | Opened the LAN address. Browsers only grant devices on `localhost` without TLS. |
| Device list empty after plugging gear in | Press **Rescan devices**. Labels need one granted permission first. |
| Background toggle refuses | Models not downloaded. Run `fetch-models.mjs`, reload. |
| Gaze reads `no face` | Sit in frame and light your face. The meter needs 478 landmarks. |
| Recording is WebM, not MP4 | Either the format picker says so, or a take came back broken and the session fell back on purpose. |
| A take says "header repaired" | Chrome's recorder dropped the file's init segment. It was spliced back from this session's first take and checked to open. |
| A take says "will not open" | The recorder produced an unplayable file and it could not be repaired. The bytes are kept. Re-record, and the session switches to WebM. |
| Scroll races ahead of you | Lower the pace, or switch on **Hold on silence** so it waits while you breathe. |
