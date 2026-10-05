/**
 * Script parsing, pacing, and the scroll engine.
 *
 * Pace is driven by velocity rather than an absolute clock: at any scroll
 * position the engine knows which block it is crossing and how long that block
 * should take at the current words-per-minute, so moving the pace slider takes
 * effect on the next frame without re-anchoring the position.
 */

const MIN_SECONDS = { line: 0.6, heading: 0.45, direction: 0.9, break: 0.3 };

export function countWords(text) {
  const cleaned = text.replace(/[^\p{L}\p{N}'’-]+/gu, ' ').trim();
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

/**
 * Blank lines separate blocks. A leading # is a heading you do not read aloud,
 * (( double parens )) is a direction for the reader, --- is a beat.
 */
export function parseScript(text) {
  const blocks = [];
  const chunks = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const raw of chunks) {
    const chunk = raw.trim();
    if (!chunk) continue;
    for (const piece of splitInlineDirections(chunk)) {
      if (!piece.text) continue;
      if (/^-{3,}$/.test(piece.text)) {
        blocks.push({ kind: 'break', text: '', words: 0 });
        continue;
      }
      if (piece.kind === 'direction') {
        blocks.push({ kind: 'direction', text: piece.text, words: 0 });
        continue;
      }
      if (/^#{1,6}\s/.test(piece.text)) {
        blocks.push({ kind: 'heading', text: piece.text.replace(/^#{1,6}\s*/, ''), words: 0 });
        continue;
      }
      const text = piece.text.replace(/\n[ \t]*/g, ' ');
      blocks.push({ kind: 'line', text, words: countWords(text) });
    }
  }

  if (!blocks.length) blocks.push({ kind: 'line', text: 'Your script is empty.', words: 3 });
  return blocks;
}

/** Pull (( directions )) out of a chunk without losing the spoken words around them. */
function splitInlineDirections(chunk) {
  const out = [];
  const re = /\(\(([\s\S]*?)\)\)/g;
  let last = 0;
  let match = re.exec(chunk);
  while (match) {
    const before = chunk.slice(last, match.index).trim();
    if (before) out.push({ kind: 'line', text: before });
    const note = match[1].trim();
    if (note) out.push({ kind: 'direction', text: note });
    last = match.index + match[0].length;
    match = re.exec(chunk);
  }
  const tail = chunk.slice(last).trim();
  if (tail) out.push({ kind: 'line', text: tail });
  return out.length ? out : [{ kind: 'line', text: chunk }];
}

export class Prompter {
  /**
   * @param {object} refs
   * @param {HTMLElement} refs.body     block container
   * @param {HTMLElement} refs.inner    translated wrapper
   * @param {HTMLElement} refs.stage    viewport the band sits in
   * @param {(info: object) => void} [refs.onBlock]  fires when the active block changes
   */
  constructor({ body, inner, stage, onBlock }) {
    this.body = body;
    this.inner = inner;
    this.stage = stage;
    this.onBlock = onBlock ?? (() => {});

    this.blocks = [];
    this.els = [];
    this.anchors = [];
    this.scroll = 0;
    this.maxScroll = 0;
    this.wpm = 140;
    this.playing = false;
    this.activeIndex = -1;
    this.focusFraction = 0.38;
  }

  setScript(text) {
    this.blocks = parseScript(text);
    this.body.textContent = '';
    this.els = this.blocks.map((block) => {
      const el = document.createElement(block.kind === 'heading' ? 'h2' : 'p');
      el.className = `blk blk-${block.kind}`;
      el.textContent = block.text;
      if (block.kind === 'break') el.setAttribute('aria-hidden', 'true');
      this.body.appendChild(el);
      return el;
    });
    this.reset();
    this.layout();
  }

  /** Re-measure after any change to size, column width, or viewport. */
  layout() {
    const stageH = this.stage.clientHeight;
    const focusPx = Math.round(stageH * this.focusFraction);
    this.focusPx = focusPx;
    document.documentElement.style.setProperty('--focus-y', `${focusPx}px`);
    // The fade below the band has to stay clear of it, or placing the words low
    // on the screen masks out the thing you are meant to be reading.
    const fadeStart = Math.round(Math.max(stageH * 0.86, focusPx + stageH * 0.1));
    document.documentElement.style.setProperty('--fade-y', `${Math.min(fadeStart, stageH)}px`);

    // offsetTop already includes the body's focus padding, so the first block
    // sits exactly on the band at scroll 0.
    this.anchors = this.els.map((el) => Math.max(0, el.offsetTop - focusPx));
    const lastEl = this.els[this.els.length - 1];
    this.maxScroll = lastEl ? Math.max(0, lastEl.offsetTop + lastEl.offsetHeight - focusPx) : 0;
    this.apply();
  }

  setFocusFraction(fraction) {
    this.focusFraction = Math.min(0.86, Math.max(0.05, fraction));
    this.layout();
  }

  setWpm(wpm) {
    this.wpm = Math.min(260, Math.max(50, Number(wpm) || 140));
  }

  durationOf(index) {
    const block = this.blocks[index];
    if (!block) return 1;
    const floor = MIN_SECONDS[block.kind] ?? 0.6;
    return Math.max(floor, (block.words / this.wpm) * 60);
  }

  /** Total read time at the current pace, in seconds. */
  estimateSeconds() {
    return this.blocks.reduce((total, _b, i) => total + this.durationOf(i), 0);
  }

  totalWords() {
    return this.blocks.reduce((total, block) => total + block.words, 0);
  }

  segmentFor(scroll) {
    const n = this.anchors.length;
    let index = 0;
    for (let i = 0; i < n; i += 1) {
      if (this.anchors[i] <= scroll + 0.5) index = i;
      else break;
    }
    const from = this.anchors[index];
    const to = index + 1 < n ? this.anchors[index + 1] : this.maxScroll;
    return { index, from, to: Math.max(to, from + 1) };
  }

  play() { this.playing = true; }
  pause() { this.playing = false; }
  toggle() { this.playing = !this.playing; return this.playing; }

  reset() {
    this.scroll = 0;
    this.playing = false;
    this.activeIndex = -1;
    this.apply();
  }

  atEnd() { return this.scroll >= this.maxScroll - 0.5; }

  seekBlock(index) {
    const clamped = Math.min(this.anchors.length - 1, Math.max(0, index));
    this.scroll = this.anchors[clamped] ?? 0;
    this.apply();
  }

  stepBlock(delta) {
    const { index } = this.segmentFor(this.scroll);
    this.seekBlock(index + delta);
  }

  /** @param {number} dt seconds since the previous frame */
  tick(dt) {
    if (!this.playing || this.atEnd()) return;
    const seg = this.segmentFor(this.scroll);
    const velocity = (seg.to - seg.from) / this.durationOf(seg.index);
    this.scroll = Math.min(this.maxScroll, this.scroll + velocity * dt);
    this.apply();
  }

  apply() {
    this.inner.style.transform = `translate3d(0, ${-this.scroll.toFixed(2)}px, 0)`;
    const { index } = this.segmentFor(this.scroll);
    if (index === this.activeIndex) return;

    if (this.els[this.activeIndex]) {
      this.els[this.activeIndex].classList.remove('active');
      this.els[this.activeIndex].classList.add('done');
    }
    this.activeIndex = index;
    const el = this.els[index];
    if (el) {
      el.classList.add('active');
      el.classList.remove('done');
    }
    this.els.forEach((node, i) => {
      if (i > index) node.classList.remove('done', 'active');
    });

    this.onBlock({ index, block: this.blocks[index] ?? null, progress: this.progress() });
  }

  progress() {
    return this.maxScroll > 0 ? Math.min(1, this.scroll / this.maxScroll) : 0;
  }

  /** Seconds of script still ahead of the band at the current pace. */
  remainingSeconds() {
    const { index, from, to } = this.segmentFor(this.scroll);
    const spanLeft = Math.max(0, to - this.scroll) / Math.max(1, to - from);
    let total = this.durationOf(index) * spanLeft;
    for (let i = index + 1; i < this.blocks.length; i += 1) total += this.durationOf(i);
    return total;
  }
}

export function formatClock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Cue list to WebVTT, so a take arrives with the read already timed. */
export function cuesToVtt(cues, totalSeconds) {
  const stampOf = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const frac = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s}.${frac}`;
  };

  const spoken = cues.filter((cue) => cue.kind === 'line' && cue.text);
  const lines = ['WEBVTT', ''];
  spoken.forEach((cue, i) => {
    const end = spoken[i + 1]?.t ?? totalSeconds;
    if (end <= cue.t) return;
    lines.push(String(i + 1), `${stampOf(cue.t)} --> ${stampOf(end)}`, cue.text, '');
  });
  return lines.join('\n');
}
