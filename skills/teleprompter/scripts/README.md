# Teleprompter capture station

A localhost web app that reads a script to you, records you reading it, and hands the
take back to the Claude session that launched it. Operational docs live in
[`SKILL.md`](../SKILL.md). This file is for whoever maintains the code.

## Why it is built this way

Capture runs entirely in the browser. `MediaRecorder` on Chrome and Edge for Windows
produces H.264/AAC MP4 directly, and MediaPipe Tasks Vision runs segmentation and face
landmarks in WASM. That removes ffmpeg, Python, and torch from the path that has to work
every time. None of them need to be installed to record.

The heavier tools only appear in `enhance.mjs`, which is explicitly a second-class path:
it reports what is missing rather than half-running.

## Pieces

| File | Job |
|---|---|
| `server.mjs` | Zero-dependency HTTP server. Serves the app, streams uploads to disk, writes the submission manifest, prints it to the terminal the agent is watching. |
| `app/index.html` | Markup. Two modes on one page: `mode-studio` for setup, `mode-perform` for reading. |
| `app/app.css` | All styling. `--focus-y`, `--lens-x`, `--lens-y`, and `--preview-gutter` are the layout joints. |
| `app/prompter.js` | Script parsing, pace maths, scroll engine, WebVTT. No DOM beyond the nodes handed to it. |
| `app/capture.js` | Devices, `MediaRecorder`, the canvas compositor, and the silence gate. |
| `app/vision.js` | Loads the vendored models, the eye landmark specs, and the gaze meter. |
| `app/gaze-correct.js` | The in-browser warp, now used only for the instant single-frame preview. |
| `app/gaze-plate.js` | Clean plate and compositing for the offline pass. |
| `gaze-pass.mjs` | The offline pass: ffmpeg decodes every frame, a headless browser corrects each, ffmpeg re-encodes. |
| `qc-gaze.mjs` | Visual QC: real frames out of a take, original against corrected against an amplified difference. |
| `app/gaze-correct.js` | The post-capture gaze warp: decode, warp each eye, re-encode. |
| `app/main.js` | Wiring, state, keyboard, take list, submit. |
| `fetch-models.mjs` | Vendors MediaPipe and pins every byte by SHA-256 into `models.lock.json`. |
| `enhance.mjs` | Post-capture passes on an existing file. Detection first, work second. |
| `verify.mjs` | Headless end-to-end run with a synthetic camera and microphone. |

## Design notes worth keeping

**Pace is velocity, not a timeline.** At any scroll position the engine knows which block
it is crossing and how long that block should take at the current words per minute, so
moving the slider mid-read changes speed on the next frame without re-anchoring the
position. A timeline would have to re-derive `t` from the scroll on every change.

**The reading band goes to the lens, not the lens to the band.** Drag the lens marker to
where the camera physically sits and the band follows it. That geometry is what fixes an
eyeline. The gaze meter measures whether it worked; it does not move anyone's eyes.

**Mask polarity is detected, not assumed.** Segmenter category order is not guaranteed
across model revisions, so `Compositor.checkPolarity` samples the middle of the frame
against the corners and flips the mask if the subject came out as background.

**Cues come free.** The prompter knows when each block crossed the band, so every take
ships with a WebVTT track aligned to the read. No ASR involved.

**The recording is never mirrored.** Mirroring is a preview and beam-splitter nicety.

**Takes live on disk, not in the page.** A take plays from its blob only until the upload
lands, then the card switches to `/api/takes/<id>/media` and the blob is revoked. Cards
are built once and updated in place. Holding every take in memory and rebuilding the list
on each change is what broke playback past the third take: each rebuild made fresh
`<video>` elements, the old ones kept their decoders, and the browser ran out.

**Nothing is called saved until it has been opened.** See the container guard below.

**The iris moves as a disc, not as a field.** The first version pushed pixels with a
smooth displacement field. Symmetric, seam-free, and still wrong on a real face: a field
drags the bottom of the iris up with everything else instead of revealing the sclera
behind it, so a rising iris left a dark crescent smeared under it. That was the
"scratchy" artifact. Now the hole is filled from the sclera beside it, the iris is
composited at its new position with a soft edge, and the eye opening masks the result.

**Two ceilings on the shift, and the lids usually bind first.** The iris radius limits
smearing at the limbus; the opening height limits jamming into a lid. On a real 720p take
the lids were 19 px apart while the iris was 29 px across, so a shift sized off the iris
alone was nearly 40% of the visible eye and looked it.

**Sign conventions are the thing to get right.** MediaPipe's eye corners have opposite
handedness between the eyes, so dividing by a signed width makes the two eyes report
opposite offsets for the same gaze. That cancelled half the live meter's horizontal
reading and made a calibrated baseline pull one eye toward the lens and push the other
away, which is what "it only works on one eye" looked like. `eyeGeometry` is the single
derivation both the meter and the correction use, and its widths are absolute.

**The old note, kept because the falloff still matters.** `warpEye` does a per-pixel inverse map over the eye
bounding box, with the displacement held flat across the iris and smoothed to zero at the
real eye-opening boundary (found by casting a ray from the iris centre to the landmark
polygon, not by guessing a radius). Per-pixel over a small region beats a triangulated
mesh here: no seams, no hundreds of clipped `drawImage` calls, and about 12k pixels an eye.

**Takes stream from disk, not from blobs.** Holding every recording in memory and
rebuilding the list on each change orphaned a media decoder per card, and the browser
eventually refused to open another: playback died past the third take. Cards are built
once and updated in place, media comes from `/api/takes/<id>/media` with range support,
and the blob is revoked as soon as the upload lands.

**Nothing is called saved until it is proven to open.** See the container guard below.

## Why correction went offline

The in-browser pass ran at playback speed and could not keep up. Measured on a real take:
178 source frames at 14.99 fps in, **135 frames out at a nonsense 60 fps**. A quarter of
the frames were being dropped, which is most of what "shaky" meant. It also had to guess
the colour of the band a raised iris vacates from a single frame, and on a normally framed
shot there is barely any sclera to guess from.

`gaze-pass.mjs` decodes every frame with ffmpeg, corrects each one in a headless browser
and re-encodes: 178 frames in, 178 out, at the source rate. Being offline also buys the
clean plate and the centred smoothing window described in `app/gaze-plate.js`, neither of
which is possible one frame at a time. The output is a progressive MP4, so it seeks.

The in-browser warp is still there, for the instant single-frame preview.

## The container guard

Chrome's MP4 recorder can stop emitting the `ftyp`/`moov` initialisation segment once its
hardware encoder has been reused. What lands is a run of bare `moof` fragments: right
size, right duration, and `DEMUXER_ERROR_COULD_NOT_OPEN` in every player, Chrome and Edge
included. It showed up in a real session where takes three, four and five were all
headless; it does **not** reproduce against Chromium's synthetic camera, so there is no
local repro to regress against.

The defence does not depend on knowing the cause:

1. `cloneForRecording` gives every take its own tracks, so the encoder starts cold.
2. `inspectContainer` reads the first bytes before anything is called saved.
3. `initSegmentLength` caches the first healthy take's init segment; a later headless one
   gets it spliced back on, and the repair is only accepted if `probePlayable` opens it.
4. After upload the saved file is loaded back. A failure marks the take and flips the
   session to WebM.

`verify.mjs` builds the broken shape from a healthy recording, asserts it really is
unplayable, and asserts the repair fixes it.

## The localhost guard

Binding to 127.0.0.1 keeps other machines out, but not other websites. Any page open in
the same browser can send requests to `localhost`, and a page whose own hostname has been
pointed at 127.0.0.1 (DNS rebinding) counts as same-origin and can read the replies,
recordings included. So the server:

1. answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`, which a
   rebinding page cannot fake, and
2. refuses any write whose `Origin` is not this server's own page. Requests with no
   `Origin` at all come from local tooling, not a browser, and are allowed.

`serveFile` also compares against the root plus a path separator, so `app/` cannot be
escaped into a sibling such as `app-other/`. `verify.mjs` tries each of these and expects
a 403; all of them came back 200 or 404 before the guard existed.

## Gotchas this code already paid for

- **`[hidden]` loses to any author rule.** `#countdown { display: grid }` kept a
  full-screen 80%-opaque veil painted while the element was "hidden", dimming the whole
  stage to a quarter brightness. `getComputedStyle` still reported white text.
  `[hidden] { display: none !important }` near the top of the stylesheet nails it down,
  and `verify.mjs` now asserts contrast on **painted pixels** so it cannot come back.
- **`padding-top: <percentage>` resolves against width, not height.** The focus offset is
  set in px from JS for that reason.
- **`getSettings()` omits width and height on some drivers.** The device readout falls
  back to the video element's decoded size.
- **Headless Chromium's synthetic camera is usable but may be missing from
  `enumerateDevices`.** `verify.mjs` asserts the picker agrees with what the browser
  reports rather than assuming a device count.
- **Assert after `boot()` signals ready.** `document.body.dataset.booted` exists so tests
  do not race the async device work.
- **`ch` resolves against the font size of the element using it.** A 13px control bar
  cannot work out how wide a 46px reading column is from `26ch`. `applyTypography`
  measures the column and publishes `--read-col-px`.
- **`MediaRecorder` stops every track in the stream it was given.** `Compositor.outputStream`
  therefore clones the microphone track instead of borrowing it; borrowing meant the first
  composited take killed the mic and every later take came back empty.
- **`video.captureStream()` audio follows the element's volume.** The correction pass pulls
  audio through `createMediaElementSource` into a `MediaStreamAudioDestinationNode`
  instead, which keeps the recording's sound while playing silently in the room.
- **MP4 metadata loading is not MP4 decoding.** `loadedmetadata` can fire off a container
  parse. If a check needs to prove a file is usable, it has to open it, not just read it.
- **`ch` resolves against the element's own font size.** Offsetting a 13px control by
  `calc(var(--read-col) / 2)` measured 26ch of 13px text, not of the 46px prompter.
  `applyTypography` measures the column and publishes `--read-col-px`.
- **Chrome's MP4 recorder can drop the init segment.** Once its hardware encoder has been
  reused, `MediaRecorder` may emit bare `moof` fragments with no `ftyp`/`moov`. The file
  is the right size and completely unplayable, and nothing downstream notices. Every take
  is now inspected, repaired from the session's cached init segment where possible, and
  loaded back to prove it opens.
- **Do not stop tracks you were only lent.** `Compositor.outputStream` used to borrow the
  live microphone track, and per-take cleanup then killed the mic for the rest of the
  session: every later take came back empty. It clones the audio now. If a stream is
  handed to the recorder, the recorder owns every track in it.

## Running the checks

```bash
node scripts/verify.mjs            # 76 checks, headless
node scripts/verify.mjs --headed   # watch it drive
node scripts/fetch-models.mjs --check
node scripts/enhance.mjs --check
```

`verify.mjs` leaves its screenshots and session files in a temp folder and prints the
path. Look at them when changing anything visual.
