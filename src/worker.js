// iWebOS worker entry: firmware loading + emulation loop. (Module registry `require` is prepended by the bundler.)
const { loadFirmware } = require('./loader.js');
const { Emulator } = require('./emu.js');
let emu = null, running = false, traceMode = 'off', capture = null, lastFrameHash = -1;
let conBuf = [], evSent = 0, lastPost = 0, lastFrame = 0, lastSweep = 0, lastStats = 0, lastTrace = 0, haltedNote = false;
const post = (m, tr) => self.postMessage(m, tr || []);
const status = (text, kind) => post({ type: 'status', text, kind: kind || 'info' });
function frameOut() {
  const w = emu.fbW, h = emu.fbH, src = emu.frame(); let hash = 0;
  for (let i = 0; i < src.length; i += 7) hash = (Math.imul(hash, 31) + src[i]) | 0;
  if (hash === lastFrameHash) return; lastFrameHash = hash;
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) { const v = src[i]; out[i] = 0xFF000000 | ((v & 255) << 16) | (v & 0xFF00) | ((v >>> 16) & 255); }
  post({ type: 'frame', w, h, buf: out.buffer }, [out.buffer]);
}
function housekeeping(now) {
  if (conBuf.length && now - lastPost > 80) { post({ type: 'console', lines: conBuf }); conBuf = []; }
  if (now - lastPost > 150) {
    lastPost = now;
    if (emu.events.length > evSent || emu.eventsDropped) { post({ type: 'events', lines: emu.events.slice(evSent), dropped: emu.eventsDropped }); evSent = emu.events.length; }
  }
  if (now - lastFrame > 400) { lastFrame = now; frameOut(); }
  if (now - lastStats > 300) { lastStats = now; const s = emu.stats(); s.elapsed = (now - emu.startMs) / 1000; post({ type: 'stats', s }); }
  if (traceMode === 'tail' && now - lastTrace > 300) { lastTrace = now; post({ type: 'trace', lines: emu.traceLines(400) }); }
  if (now - lastSweep > 2000) { lastSweep = now; emu.sweep(); }
}
function loop() {
  if (!running) return;
  const t0 = performance.now();
  try {
    while (performance.now() - t0 < 16) {
      let n = 20000;
      if (capture) n = Math.min(n, capture.target - emu.ran);
      const r = emu.run(n);
      if (capture && emu.ran >= capture.target) { const lines = emu.traceLines(capture.n); post({ type: 'capture', lines }); capture = null; if (traceMode === 'off') emu.setTrace(false); }
      if (!r) { if (!haltedNote) { haltedNote = true; status('CPU halted: waiting for an interrupt that never arrives (no timer armed).', 'warn'); } break; }
    }
    housekeeping(performance.now());
  } catch (e) {
    running = false; housekeeping(performance.now());
    post({ type: 'error', msg: 'Emulator stopped: ' + (e && e.message || e) + (e && e.stack ? '\n' + e.stack.split('\n').slice(0, 4).join('\n') : '') });
    return;
  }
  setTimeout(loop, 0);
}
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === 'start') {
      status('Reading IPSW…');
      const fw = await loadFirmware(m.file, m.keys, s => post({ type: 'events', lines: ['[loader] ' + s], dropped: 0 }));
      post({ type: 'info', info: fw.info });
      status('Building machine…');
      emu = new Emulator(fw, { cmdline: m.cmdline, graphical: !!m.graphical });
      emu.consoleSink = t => { conBuf.push(t.replace(/\n$/, '')); };
      emu.startMs = performance.now(); evSent = 0; running = true; haltedNote = false;
      post({ type: 'ready', syms: emu.syms.length, idleHook: emu.idleOK });
      status('Running', 'run'); loop();
    } else if (m.cmd === 'pause') { running = false; status('Paused', 'pause'); if (emu) housekeeping(1e12); }
    else if (m.cmd === 'resume') { if (emu && !running) { running = true; status('Running', 'run'); loop(); } }
    else if (m.cmd === 'trace') { traceMode = m.mode; if (emu) { emu.setTrace(m.mode !== 'off'); if (m.mode === 'off') post({ type: 'trace', lines: [] }); } }
    else if (m.cmd === 'capture') { if (emu) { emu.setTrace(true); capture = { n: Math.min(m.n, 30000), target: emu.ran + Math.min(m.n, 30000) }; if (!running) { running = true; status('Capturing…', 'run'); loop(); } } }
  } catch (e) { post({ type: 'error', msg: String(e && e.message || e) }); }
};
