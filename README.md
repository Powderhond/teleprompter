# Teleprompter

A teleprompter and recorder that Claude Code can start for you. Give Claude the script, or
ask it to write one. It opens a local page that scrolls the words while you record from
any camera and microphone, and it gets the finished take back when you press Submit.

Everything runs on your own machine. Nothing is uploaded anywhere.

## What it does

- Scrolls the script at a words-per-minute pace you set, and tells you how long the read
  will take before you start.
- Records video (MP4, or WebM as a fallback) or audio only, from any camera or microphone,
  external gear included.
- Puts the reading line right under your camera, so your eyes stay near the lens.
- Writes a caption file (WebVTT) timed to your read, taken from the scroll itself.
- Keeps every take on disk, lets you retake, discard and compare, and checks each file
  actually opens before calling it saved.
- Optional: background blur or replacement, and a meter that shows how much of the take
  you spent looking at the lens.
- Optional: an offline pass that nudges your eyes toward the lens (needs ffmpeg).

## Install

### As a Claude Code plugin

```
/plugin marketplace add Powderhond/teleprompter
/plugin install teleprompter@powderhond
```

### By hand

Copy `skills/teleprompter` to `~/.claude/skills/teleprompter` for every project, or to
`.claude/skills/teleprompter` inside one project.

### Requirements

- Node 18 or newer
- Chrome or Edge

Developed and tested on Windows with Chrome and Edge. macOS and Linux should work, but
haven't been tested yet.

## Use it

Ask Claude for a recording in plain words:

> Let me record a 60 second intro for the demo. Here's roughly what I want to say...

Claude writes the script, starts the teleprompter and gives you a link. Then:

1. Pick your camera and microphone.
2. Drag the lens marker to where your camera sits on the screen.
3. Press **F** to go live, **R** to record, **R** again to stop.
4. Press **Submit for task**. Claude picks up the take from there.

Takes are saved in `.teleprompter/` in your project. Add that folder to `.gitignore`.

[`skills/teleprompter/SKILL.md`](skills/teleprompter/SKILL.md) has the full guide: script
format, every key, every option and troubleshooting.

## Optional extras

Background replacement and the gaze meter use Google's MediaPipe models. Download them
once (about 23 MB). Every file is checked against a SHA-256 hash recorded in
`models.lock.json`, and a download that doesn't match is rejected:

```
node skills/teleprompter/scripts/fetch-models.mjs
```

The gaze correction pass and the test suite need Playwright, plus ffmpeg for the
correction pass:

```
npm install
```

## Phone version

Not built yet. The plan is a page you open in your phone's browser: Claude puts the
script in the link, you read and record on the phone, and the take saves to your phone.

[`phone/check`](phone/check/index.html) is a test page for that. It checks whether a
phone browser can do the job: front camera, a short recording with words scrolling over
it, and saving the clip.

## Development

```
npm install
npm run verify
```

`verify` drives the whole recorder in a headless browser with a simulated camera and
microphone, and reports each check as it goes.
[`skills/teleprompter/scripts/README.md`](skills/teleprompter/scripts/README.md)
explains how it's built and why.

## License

MIT. The MediaPipe runtime and models are downloaded separately, not included in this
repo, and are licensed Apache-2.0.
