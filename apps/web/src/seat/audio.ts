// Low-delay game sound for seats. The seat streams raw 22.05 kHz mono mu-law over a WebSocket
// (/api/seat/audio); an AudioWorklet plays it from a small jitter buffer (~80 ms) and drops any
// backlog beyond ~250 ms, so the sound never drifts behind the picture.
const RATE = 22050;
const TARGET_MS = 80;
const MAX_MS = 250;

// The worklet is inlined (as a Blob URL) so it needs no separate build step.
const WORKLET = `
class SeatAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { step, target, max } = options.processorOptions;
    this.step = step;          // source samples per output sample
    this.target = target;      // samples to buffer before (re)starting
    this.max = max;            // backlog beyond this is dropped
    this.buf = new Float32Array(1 << 16);
    this.mask = this.buf.length - 1;
    this.r = 0; this.w = 0; this.n = 0; this.frac = 0; this.playing = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) & this.mask; }
      this.n = Math.min(this.n + d.length, this.buf.length);
      if (this.n > this.max) { const drop = this.n - this.target; this.r = (this.r + drop) & this.mask; this.n -= drop; }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    if (!this.playing && this.n >= this.target) this.playing = true;
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing || this.n < 2) { ch[i] = 0; this.playing = false; continue; }
      const a = this.buf[this.r], b = this.buf[(this.r + 1) & this.mask];
      ch[i] = a + (b - a) * this.frac;   // linear interpolation between source samples
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this.r = (this.r + 1) & this.mask; this.n--; }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}
registerProcessor("seat-audio", SeatAudio);
`;

// G.711 mu-law → float
const ULAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  ULAW[i] = ((u & 0x80 ? 0x84 - t : t - 0x84) / 32768);
}

export type SeatAudio = {
  setMuted(muted: boolean): void;
  stop(): void;
  /** For testing: bytes received and the loudest recent sample. */
  stats(): { bytes: number; peak: number; state: string; ws: number; retry: number; failed: string; mode: string };
};

/** Fallback for pages without AudioWorklet (plain-http addresses, old browsers): the same jitter
 *  buffer driven by a ScriptProcessorNode on the main thread. */
function scriptProcessorPlayer(ctx: AudioContext, target: number, max: number) {
  const buf = new Float32Array(1 << 16);
  const mask = buf.length - 1;
  const step = RATE / ctx.sampleRate;
  let r = 0, w = 0, n = 0, frac = 0, playing = false;
  const node = ctx.createScriptProcessor(1024, 0, 2);
  node.onaudioprocess = (e) => {
    const ch = e.outputBuffer.getChannelData(0);
    if (!playing && n >= target) playing = true;
    for (let i = 0; i < ch.length; i++) {
      if (!playing || n < 2) {
        ch[i] = 0;
        playing = false;
        continue;
      }
      const a = buf[r], b = buf[(r + 1) & mask];
      ch[i] = a + (b - a) * frac;
      frac += step;
      while (frac >= 1) {
        frac -= 1;
        r = (r + 1) & mask;
        n--;
      }
    }
    e.outputBuffer.getChannelData(1).set(ch);
  };
  node.connect(ctx.destination);
  return {
    push(d: Float32Array) {
      for (let i = 0; i < d.length; i++) {
        buf[w] = d[i];
        w = (w + 1) & mask;
      }
      n = Math.min(n + d.length, buf.length);
      if (n > max) {
        const drop = n - target;
        r = (r + drop) & mask;
        n -= drop;
      }
    },
  };
}

export function startSeatAudio(url: string, initiallyMuted: boolean): SeatAudio {
  let ctx: AudioContext | null = null;
  /** Where decoded samples go: the worklet's port, or the fallback player. */
  let node: { push(d: Float32Array): void } | null = null;
  let ws: WebSocket | null = null;
  let muted = initiallyMuted;
  let stopped = false;
  let retry = 0;
  let bytes = 0;
  let peak = 0;

  async function ensureContext() {
    if (ctx) return;
    try {
      ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    } catch {
      ctx = new AudioContext({ latencyHint: "interactive" }); // browser resamples in the worklet
    }
    const target = Math.round((RATE * TARGET_MS) / 1000);
    const max = Math.round((RATE * MAX_MS) / 1000);
    if (!ctx.audioWorklet) {
      node = scriptProcessorPlayer(ctx, target, max);
      return;
    }
    const blobUrl = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const worklet = new AudioWorkletNode(ctx, "seat-audio", {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { step: RATE / ctx.sampleRate, target, max },
    });
    worklet.connect(ctx.destination);
    node = { push: (d) => worklet.port.postMessage(d, [d.buffer]) };
  }

  function connect() {
    if (stopped || muted || ws) return;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer);
      bytes += data.length;
      const f = new Float32Array(data.length);
      let p = 0;
      for (let i = 0; i < data.length; i++) {
        const v = ULAW[data[i]];
        f[i] = v;
        if (Math.abs(v) > p) p = Math.abs(v);
      }
      peak = Math.max(p, peak * 0.9);
      node?.push(f);
    };
    ws.onclose = () => {
      ws = null;
      if (!stopped && !muted && retry < 20) setTimeout(connect, Math.min(1000 * ++retry, 10_000));
    };
  }

  // Browsers only allow sound after the player interacts with the page.
  const unlock = () => void ctx?.resume();
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { capture: true });

  let failed = "";
  void ensureContext()
    .then(() => {
      if (!muted) void ctx!.resume();
      connect();
    })
    .catch((e: Error) => {
      failed = e.message || String(e);
      console.warn("Game sound unavailable:", e);
    });

  return {
    setMuted(m) {
      muted = m;
      if (m) {
        ws?.close();
        void ctx?.suspend();
      } else if (node) {
        void ctx?.resume();
        connect();
      }
    },
    stop() {
      stopped = true;
      ws?.close();
      void ctx?.close();
    },
    stats: () => ({
      bytes,
      peak,
      state: ctx?.state ?? "none",
      ws: ws?.readyState ?? -1,
      retry,
      failed,
      mode: ctx ? (ctx.audioWorklet ? "worklet" : "fallback") : "none",
    }),
  };
}
