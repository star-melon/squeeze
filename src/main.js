'use strict';

/*
 * Squeeze — Electron MAIN process.
 *
 * H.264 (libx264) two-pass ABR video compressor + cwebp image compressor,
 * each driven by a parallel batch queue that shares one concurrency pool,
 * one output-safety helper, one cancel Map, and one single-run guard.
 *
 * ----------------------------------------------------------------------------
 * IPC CHANNELS (keep in sync with preload.js and the renderer)
 * ----------------------------------------------------------------------------
 * invoke (renderer -> main, returns Promise):
 *   'squeeze:addFilesViaDialog'   ()                -> FileInfo[]
 *   'squeeze:addPaths'            (paths:string[])  -> FileInfo[]
 *   'squeeze:addImagesViaDialog'  ()                -> ImageInfo[]
 *   'squeeze:addImagePaths'       (paths:string[])  -> ImageInfo[]
 *   'squeeze:chooseOutputDir'     ()                -> string|null
 *   'squeeze:defaultOutputDirFor' (path:string)     -> string
 *   'squeeze:start'               (payload)         -> void   (video run)
 *   'squeeze:startImages'         (payload)         -> void   (image run)
 *   'squeeze:cancelAll'           ()                -> void
 *   'squeeze:reveal'              (path:string)     -> void
 *   'squeeze:openPath'            (path:string)     -> void
 *   ('pathForFile' is preload-only, no IPC — uses webUtils.getPathForFile.)
 *
 * events (main -> renderer, via webContents.send):
 *   'squeeze:onProgress'   { id, pass, itemPercent, speed, fps }   (video only)
 *   'squeeze:onItemDone'   { id, ok:true, output, oldBytes, newBytes, mbps, savedPct }
 *   'squeeze:onItemError'  { id, ok:false, message }
 *   'squeeze:onAllDone'    ()
 *
 * Images REUSE onItemDone / onItemError / onAllDone. Images have NO granular
 * progress, so onProgress is NEVER emitted for an image run.
 * ----------------------------------------------------------------------------
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe / cwebp binary resolution (with the app.asar.unpacked fix)
// ---------------------------------------------------------------------------
function unpackedPath(p) {
  // In a packaged build the binaries live under app.asar.unpacked.
  // Anchor on a trailing separator so we only rewrite the asar segment,
  // never an unrelated "app.asar" substring elsewhere in the install path.
  if (!p) return p;
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

let ffmpegPath = null;
let ffprobePath = null;

function resolveBinaries() {
  if (ffmpegPath && ffprobePath) return;
  // ffmpeg-static: default export is the path string.
  const ffmpegStatic = require('ffmpeg-static');
  // ffprobe-static: exports { path }.
  const ffprobeStatic = require('ffprobe-static');

  const rawFfmpeg =
    typeof ffmpegStatic === 'string' ? ffmpegStatic : (ffmpegStatic && ffmpegStatic.path);
  const rawFfprobe =
    typeof ffprobeStatic === 'string' ? ffprobeStatic : (ffprobeStatic && ffprobeStatic.path);

  ffmpegPath = unpackedPath(rawFfmpeg);
  ffprobePath = unpackedPath(rawFfprobe);
}

// cwebp resolution: try cwebp-bin (default export is a path string), apply the
// same app.asar.unpacked fix as ffmpeg. If the resolved file does not exist,
// fall back to a known local libwebp install when that exists. Otherwise leave
// cwebpPath null so each item surfaces a clear error.
const CWEBP_FALLBACK = 'C:\\tools\\libwebp\\libwebp-1.5.0-windows-x64\\bin\\cwebp.exe';
let cwebpPath = null;
let cwebpResolved = false;

function fileExists(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function resolveCwebp() {
  if (cwebpResolved) return;
  cwebpResolved = true;

  let raw = null;
  try {
    const cwebpBin = require('cwebp-bin');
    // cwebp-bin@7 is ESM: require() yields { default: '<path>' }. Older/other
    // shapes give a string or { path }. Handle all three.
    raw = typeof cwebpBin === 'string'
      ? cwebpBin
      : (cwebpBin && (cwebpBin.default || cwebpBin.path));
  } catch (_) {
    raw = null;
  }

  const fixed = unpackedPath(raw);
  if (fileExists(fixed)) {
    cwebpPath = fixed;
    return;
  }

  if (fileExists(CWEBP_FALLBACK)) {
    cwebpPath = CWEBP_FALLBACK;
    return;
  }

  // Neither available — leave null; per-item errors will explain.
  cwebpPath = null;
}

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'Squeeze',
    backgroundColor: '#11131a',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv',
  'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'vob',
];

const IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif',
  'tga', 'pnm', 'ppm', 'pgm', 'pam',
];

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function safeName(p) {
  try {
    return path.basename(p);
  } catch (_) {
    return String(p);
  }
}

function statBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return 0;
  }
}

// Parse a frame-rate expression like "30000/1001" or "25/1" into a number.
function parseFps(expr) {
  if (!expr) return 0;
  if (typeof expr === 'number') return expr;
  const s = String(expr).trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/');
    const num = parseFloat(a);
    const den = parseFloat(b);
    if (den && isFinite(num) && isFinite(den)) return num / den;
    return 0;
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Parse "HH:MM:SS.xx" -> seconds.
function parseTimecode(tc) {
  if (!tc) return 0;
  const parts = String(tc).trim().split(':');
  if (parts.length !== 3) return 0;
  const h = parseFloat(parts[0]) || 0;
  const m = parseFloat(parts[1]) || 0;
  const s = parseFloat(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// ---------------------------------------------------------------------------
// ffprobe — produce a FileInfo for a single absolute path.
// ---------------------------------------------------------------------------
function probeFile(absPath) {
  return new Promise((resolve) => {
    resolveBinaries();

    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      absPath,
    ];

    let stdout = '';
    let stderr = '';
    let child;

    try {
      child = spawn(ffprobePath, args, { windowsHide: true });
    } catch (err) {
      resolve(null);
      return;
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', () => resolve(null));

    child.on('close', () => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (_) {
        resolve(null);
        return;
      }

      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const format = parsed.format || {};

      const videoStream = streams.find((s) => s.codec_type === 'video');
      const audioStream = streams.find((s) => s.codec_type === 'audio');

      if (!videoStream) {
        // Not a usable video file.
        resolve(null);
        return;
      }

      // Duration: prefer format.duration, fall back to the video stream.
      let durationSec = parseFloat(format.duration);
      if (!isFinite(durationSec) || durationSec <= 0) {
        durationSec = parseFloat(videoStream.duration);
      }
      if (!isFinite(durationSec) || durationSec <= 0) durationSec = 0;

      // FPS: prefer avg_frame_rate, fall back to r_frame_rate.
      let fps = parseFps(videoStream.avg_frame_rate);
      if (!fps) fps = parseFps(videoStream.r_frame_rate);

      const info = {
        id: makeId(),
        path: absPath,
        name: path.basename(absPath),
        dir: path.dirname(absPath),
        bytes: statBytes(absPath),
        durationSec: durationSec,
        width: parseInt(videoStream.width, 10) || 0,
        height: parseInt(videoStream.height, 10) || 0,
        fps: fps,
        hasAudio: !!audioStream,
        vcodec: videoStream.codec_name || '',
      };

      resolve(info);
    });
  });
}

// Probe many paths; skip anything that fails to probe. Dedupe by absolute path.
async function probePaths(paths) {
  const seen = new Set();
  const results = [];
  for (const raw of paths) {
    if (!raw) continue;
    let abs;
    try {
      abs = path.resolve(raw);
    } catch (_) {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);

    // Must exist and be a file.
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
    } catch (_) {
      continue;
    }

    const info = await probeFile(abs);
    if (info) results.push(info);
  }
  return results;
}

// ---------------------------------------------------------------------------
// ffprobe — produce an ImageInfo for a single absolute path.
// Uses the SAME bundled ffprobe: width/height from the video stream,
// format from codec_name (or the file extension), bytes from fs.stat.
// ---------------------------------------------------------------------------
function probeImage(absPath) {
  return new Promise((resolve) => {
    resolveBinaries();

    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      absPath,
    ];

    let stdout = '';
    let child;

    try {
      child = spawn(ffprobePath, args, { windowsHide: true });
    } catch (err) {
      resolve(null);
      return;
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => {});

    child.on('error', () => resolve(null));

    child.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (_) {
        parsed = null;
      }

      const streams = (parsed && Array.isArray(parsed.streams)) ? parsed.streams : [];
      const videoStream = streams.find((s) => s.codec_type === 'video');

      // Format: prefer codec_name, fall back to the file extension.
      const extFmt = (path.extname(absPath) || '').replace(/^\./, '').toLowerCase();
      const format = (videoStream && videoStream.codec_name)
        ? videoStream.codec_name
        : (extFmt || 'image');

      const info = {
        id: makeId(),
        path: absPath,
        name: path.basename(absPath),
        dir: path.dirname(absPath),
        bytes: statBytes(absPath),
        width: videoStream ? (parseInt(videoStream.width, 10) || 0) : 0,
        height: videoStream ? (parseInt(videoStream.height, 10) || 0) : 0,
        format: format,
      };

      resolve(info);
    });
  });
}

// Probe many image paths; skip anything missing. Dedupe by absolute path.
// Files that ffprobe can't read still return an ImageInfo (dimensions 0) as
// long as they exist, since cwebp may still handle them.
async function probeImagePaths(paths) {
  const seen = new Set();
  const results = [];
  for (const raw of paths) {
    if (!raw) continue;
    let abs;
    try {
      abs = path.resolve(raw);
    } catch (_) {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);

    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
    } catch (_) {
      continue;
    }

    const info = await probeImage(abs);
    if (info) results.push(info);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Output-path safety
// ---------------------------------------------------------------------------
function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Engine — two-pass ABR with a concurrency pool.
// ---------------------------------------------------------------------------
const NULLDEV = process.platform === 'win32' ? 'NUL' : '/dev/null';

// State for the active run. ONE active run at a time (video OR images), so the
// cancel Map and the activeRun guard are shared across both engines.
const runningChildren = new Map(); // id -> ChildProcess (currently spawned child)
let cancelRequested = false;
let activeRun = false;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function passLogBase(id) {
  // Unique per item under temp so parallel files don't collide.
  return path.join(app.getPath('temp'), 'squeeze-' + id);
}

// Best-effort unlink that tolerates Windows holding the handle briefly after
// a SIGKILL (EBUSY/EPERM) by retrying a few times asynchronously.
function unlinkWithRetry(file, attempts) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (!err || err.code === 'ENOENT') return; // already gone
    if ((err.code === 'EBUSY' || err.code === 'EPERM') && attempts > 0) {
      setTimeout(() => unlinkWithRetry(file, attempts - 1), 200);
    }
    // Otherwise give up quietly — temp is OS-cleaned anyway.
  }
}

// Remove the two-pass log artifacts for an item. The passlogfile base is unique
// per item (squeeze-<id>), so libx264's deterministic outputs fully cover it.
function cleanupPassLogs(logBase) {
  const candidates = [
    logBase + '-0.log',
    logBase + '-0.log.mbtree',
    logBase + '.log',
    logBase + '.log.mbtree',
  ];
  for (const f of candidates) {
    unlinkWithRetry(f, 5);
  }
}

function buildPass1Args(input, videoKbps, preset, logBase) {
  return [
    '-y',
    '-i', input,
    '-c:v', 'libx264',
    '-b:v', videoKbps + 'k',
    '-pass', '1',
    '-passlogfile', logBase,
    '-preset', preset,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'null',
    NULLDEV,
    '-progress', 'pipe:1',
    '-nostats',
  ];
}

function buildPass2Args(input, output, videoKbps, preset, removeAudio, audioKbps, logBase) {
  const audioArgs = removeAudio
    ? ['-an']
    : ['-c:a', 'aac', '-b:a', audioKbps + 'k'];
  return [
    '-y',
    '-i', input,
    '-c:v', 'libx264',
    '-b:v', videoKbps + 'k',
    '-pass', '2',
    '-passlogfile', logBase,
    '-preset', preset,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    ...audioArgs,
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    output,
  ];
}

// Run a single ffmpeg pass. Resolves with { code, stderr } on close.
// Parses '-progress pipe:1' lines and emits onProgress via the callback.
function runPass(id, args, durationSec, pass, onTick) {
  return new Promise((resolve, reject) => {
    resolveBinaries();

    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    runningChildren.set(id, child);

    let stderrTail = '';
    let stdoutBuf = '';
    let lastSpeed = '';
    let lastFps = 0;

    function flushLines() {
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;

        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();

        let seconds = null;
        if (key === 'out_time_us' || key === 'out_time_ms') {
          // ffmpeg sometimes labels microseconds as out_time_ms; both are µs here.
          const us = parseFloat(val);
          if (isFinite(us) && us >= 0) seconds = us / 1e6;
        } else if (key === 'out_time') {
          seconds = parseTimecode(val);
        } else if (key === 'speed') {
          lastSpeed = val; // e.g. "1.23x" or "N/A"
        } else if (key === 'fps') {
          const f = parseFloat(val);
          if (isFinite(f)) lastFps = f;
        }

        if (seconds !== null && durationSec > 0) {
          const percentThisPass = clamp((seconds / durationSec) * 100, 0, 100);
          const itemPercent =
            pass === 1 ? percentThisPass * 0.5 : 50 + percentThisPass * 0.5;
          onTick({
            id,
            pass,
            itemPercent,
            speed: lastSpeed,
            fps: lastFps,
          });
        }
      }
    }

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      flushLines();
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail += s;
      // Keep only the tail to avoid unbounded memory on long runs.
      if (stderrTail.length > 8192) {
        stderrTail = stderrTail.slice(stderrTail.length - 8192);
      }
    });

    child.on('error', (err) => {
      runningChildren.delete(id);
      reject(err);
    });

    child.on('close', (code, signal) => {
      runningChildren.delete(id);
      resolve({ code, signal, stderr: stderrTail });
    });
  });
}

// Compress one item: pass 1 then pass 2. Throws on failure / cancel.
async function compressItem(item, options) {
  const { id, input, output } = item;
  const { videoKbps, removeAudio, audioKbps, preset } = options;

  if (cancelRequested) {
    throw new Error('Cancelled');
  }

  const oldBytes = statBytes(input);

  // Resolve a probe for duration. We re-probe to be safe (renderer may not
  // pass it through). Fall back to a tiny non-zero to avoid divide-by-zero.
  let durationSec = 0;
  const info = await probeFile(input);
  if (info && info.durationSec > 0) durationSec = info.durationSec;

  const logBase = passLogBase(id);

  // Make sure the output directory exists.
  ensureDirSync(path.dirname(output));

  try {
    // ----- PASS 1 -----
    if (cancelRequested) throw new Error('Cancelled');
    const r1 = await runPass(id, buildPass1Args(input, videoKbps, preset, logBase), durationSec, 1, (p) => {
      sendToRenderer('squeeze:onProgress', p);
    });
    if (cancelRequested) throw new Error('Cancelled');
    if (r1.code !== 0) {
      throw new Error('Pass 1 failed (exit ' + r1.code + '): ' + tailLine(r1.stderr));
    }

    // Snap progress to 50% at the pass boundary.
    sendToRenderer('squeeze:onProgress', {
      id, pass: 1, itemPercent: 50, speed: '', fps: 0,
    });

    // ----- PASS 2 -----
    if (cancelRequested) throw new Error('Cancelled');
    const r2 = await runPass(
      id,
      buildPass2Args(input, output, videoKbps, preset, removeAudio, audioKbps, logBase),
      durationSec,
      2,
      (p) => { sendToRenderer('squeeze:onProgress', p); }
    );
    if (cancelRequested) throw new Error('Cancelled');
    if (r2.code !== 0) {
      throw new Error('Pass 2 failed (exit ' + r2.code + '): ' + tailLine(r2.stderr));
    }

    // Snap to 100%.
    sendToRenderer('squeeze:onProgress', {
      id, pass: 2, itemPercent: 100, speed: '', fps: 0,
    });

    const newBytes = statBytes(output);
    const safeDur = durationSec > 0 ? durationSec : 1;
    const mbps = newBytes / 1048576 / safeDur;
    const savedPct = oldBytes > 0 ? Math.round((1 - newBytes / oldBytes) * 100) : 0;

    sendToRenderer('squeeze:onItemDone', {
      id,
      ok: true,
      output,
      oldBytes,
      newBytes,
      mbps,
      savedPct,
    });
  } finally {
    cleanupPassLogs(logBase);
  }
}

function tailLine(stderr) {
  if (!stderr) return 'unknown error';
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'unknown error';
  return lines[lines.length - 1].slice(0, 400);
}

// ---------------------------------------------------------------------------
// Image engine — single cwebp pass per item, sharing the concurrency pool,
// the cancel Map, and the activeRun guard.
// ---------------------------------------------------------------------------

// Build cwebp args for a given mode.
function buildCwebpArgs(input, output, imgOptions) {
  const { mode, sizeKB, quality } = imgOptions;
  if (mode === 'size') {
    const targetBytes = Math.round(clamp(sizeKB, 1, 1024 * 1024) * 1024);
    return ['-mt', '-m', '6', '-pass', '10', '-size', String(targetBytes), input, '-o', output];
  }
  if (mode === 'quality') {
    const q = Math.round(clamp(quality, 1, 100));
    return ['-mt', '-m', '6', '-q', String(q), input, '-o', output];
  }
  // Default: visually lossless.
  return ['-mt', '-m', '6', '-q', '90', input, '-o', output];
}

// Run cwebp ONCE for one image item. Throws on failure / cancel.
async function compressImageItem(item, imgOptions) {
  const { id, input, output } = item;

  if (cancelRequested) {
    throw new Error('Cancelled');
  }

  resolveCwebp();
  if (!cwebpPath) {
    throw new Error(
      'cwebp not found. Install the "cwebp-bin" dependency or place cwebp.exe at ' + CWEBP_FALLBACK
    );
  }

  const oldBytes = statBytes(input);
  ensureDirSync(path.dirname(output));

  const args = buildCwebpArgs(input, output, imgOptions);

  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cwebpPath, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    runningChildren.set(id, child);

    let stderrTail = '';

    child.stdout.on('data', () => {});

    child.stderr.on('data', (d) => {
      // cwebp prints stats and errors on stderr; keep only the tail.
      stderrTail += d.toString();
      if (stderrTail.length > 8192) {
        stderrTail = stderrTail.slice(stderrTail.length - 8192);
      }
    });

    child.on('error', (err) => {
      runningChildren.delete(id);
      reject(err);
    });

    child.on('close', (code, signal) => {
      runningChildren.delete(id);
      resolve({ code, signal, stderr: stderrTail });
    });
  });

  if (cancelRequested) throw new Error('Cancelled');
  if (result.code !== 0) {
    throw new Error('cwebp failed (exit ' + result.code + '): ' + tailLine(result.stderr));
  }

  const newBytes = statBytes(output);
  const savedPct = oldBytes > 0 ? Math.round((1 - newBytes / oldBytes) * 100) : 0;

  sendToRenderer('squeeze:onItemDone', {
    id,
    ok: true,
    output,
    oldBytes,
    newBytes,
    mbps: null, // images have no bitrate concept
    savedPct,
  });
}

// ---------------------------------------------------------------------------
// Shared concurrency pool. `task` is the async per-item worker.
// ---------------------------------------------------------------------------
async function runQueue(items, options, task) {
  const concurrency = clamp(parseInt(options.concurrency, 10) || 2, 1, 4);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (cancelRequested) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];

      try {
        await task(item, options);
      } catch (err) {
        if (cancelRequested) {
          // On cancel, don't emit a per-item error storm; just stop.
          return;
        }
        sendToRenderer('squeeze:onItemError', {
          id: item.id,
          ok: false,
          message: (err && err.message) ? err.message : String(err),
        });
        // Continue with the rest of the queue.
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// Normalize the VIDEO options block from the renderer with safe defaults.
function normalizeOptions(opts) {
  const o = opts || {};
  const presetIn = o.preset;
  const preset = (presetIn === 'medium' || presetIn === 'slow' || presetIn === 'veryslow')
    ? presetIn
    : 'slow';
  let videoKbps = parseInt(o.videoKbps, 10);
  if (!isFinite(videoKbps) || videoKbps < 1) videoKbps = 200;
  let audioKbps = parseInt(o.audioKbps, 10);
  if (!isFinite(audioKbps) || audioKbps < 1) audioKbps = 128;
  let concurrency = parseInt(o.concurrency, 10);
  if (!isFinite(concurrency)) concurrency = 2;
  concurrency = clamp(concurrency, 1, 4);
  return {
    videoKbps,
    removeAudio: !!o.removeAudio,
    audioKbps,
    preset,
    concurrency,
  };
}

// Normalize the IMAGE options block from the renderer with safe defaults.
function normalizeImageOptions(opts) {
  const o = opts || {};
  const modeIn = o.mode;
  const mode = (modeIn === 'size' || modeIn === 'quality') ? modeIn : 'lossless';

  let sizeKB = parseInt(o.sizeKB, 10);
  if (!isFinite(sizeKB) || sizeKB < 1) sizeKB = 100;

  let quality = parseInt(o.quality, 10);
  if (!isFinite(quality)) quality = 80;
  quality = clamp(quality, 1, 100);

  let concurrency = parseInt(o.concurrency, 10);
  if (!isFinite(concurrency)) concurrency = 2;
  concurrency = clamp(concurrency, 1, 4);

  return { mode, sizeKB, quality, concurrency };
}

// Validate / sanitize an item's output path so we never overwrite the input
// and never collide within the batch. Returns a new items array.
// `defaultExt` is used when an output path has no extension.
function resolveOutputs(rawItems, defaultExt) {
  const fallbackExt = defaultExt || '.mp4';
  const used = new Set();
  const out = [];

  for (const it of rawItems) {
    if (!it || !it.input || !it.output) continue;

    const input = path.resolve(it.input);
    let output = path.resolve(it.output);

    // Never overwrite the input: if equal, append "_compressed".
    if (path.normalize(output).toLowerCase() === path.normalize(input).toLowerCase()) {
      const ext = path.extname(output) || fallbackExt;
      const base = output.slice(0, output.length - path.extname(output).length);
      output = base + '_compressed' + ext;
    }

    // Batch / disk collision: append a numeric suffix until unique.
    const ext = path.extname(output) || fallbackExt;
    const base = output.slice(0, output.length - path.extname(output).length);
    let candidate = output;
    let n = 1;
    const inputNorm = path.normalize(input).toLowerCase();
    while (
      used.has(path.normalize(candidate).toLowerCase()) ||
      path.normalize(candidate).toLowerCase() === inputNorm ||
      fs.existsSync(candidate)
    ) {
      candidate = base + '_' + n + ext;
      n++;
      // Safety valve.
      if (n > 9999) break;
    }
    output = candidate;
    used.add(path.normalize(output).toLowerCase());

    out.push({ id: it.id, input, output });
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc() {
  // Open a dialog, probe each selected file, return FileInfo[].
  ipcMain.handle('squeeze:addFilesViaDialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频文件 / Choose videos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos', extensions: VIDEO_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return [];
    }
    return await probePaths(result.filePaths);
  });

  // Probe the given absolute paths (drag & drop).
  ipcMain.handle('squeeze:addPaths', async (_evt, paths) => {
    if (!Array.isArray(paths)) return [];
    return await probePaths(paths);
  });

  // Open a dialog filtered to images, probe each, return ImageInfo[].
  ipcMain.handle('squeeze:addImagesViaDialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片文件 / Choose images',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: IMAGE_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return [];
    }
    return await probeImagePaths(result.filePaths);
  });

  // Probe the given absolute image paths (drag & drop) -> ImageInfo[].
  ipcMain.handle('squeeze:addImagePaths', async (_evt, paths) => {
    if (!Array.isArray(paths)) return [];
    return await probeImagePaths(paths);
  });

  // Choose an output directory.
  ipcMain.handle('squeeze:chooseOutputDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择输出文件夹 / Choose output folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return null;
    }
    return result.filePaths[0];
  });

  // Default output dir for a given source path = <dir>/compressed.
  ipcMain.handle('squeeze:defaultOutputDirFor', async (_evt, p) => {
    if (!p) return '';
    return path.join(path.dirname(path.resolve(p)), 'compressed');
  });

  // Begin VIDEO compression.
  ipcMain.handle('squeeze:start', async (_evt, payload) => {
    if (activeRun) {
      // Already running (video or images); ignore a second start.
      return;
    }
    const rawItems = (payload && Array.isArray(payload.items)) ? payload.items : [];
    const options = normalizeOptions(payload && payload.options);
    const items = resolveOutputs(rawItems, '.mp4');

    if (!items.length) {
      // Nothing to do — still signal completion so the UI resets.
      sendToRenderer('squeeze:onAllDone');
      return;
    }

    cancelRequested = false;
    activeRun = true;

    // Run asynchronously; the invoke resolves immediately (returns void).
    runQueue(items, options, compressItem)
      .catch(() => { /* per-item errors already emitted */ })
      .finally(() => {
        activeRun = false;
        runningChildren.clear();
        sendToRenderer('squeeze:onAllDone');
      });
  });

  // Begin IMAGE compression (cwebp). REUSES onItemDone/onItemError/onAllDone.
  ipcMain.handle('squeeze:startImages', async (_evt, payload) => {
    if (activeRun) {
      // Already running (video or images); ignore a second start.
      return;
    }
    const rawItems = (payload && Array.isArray(payload.items)) ? payload.items : [];
    const imgOptions = normalizeImageOptions(payload && payload.options);
    const items = resolveOutputs(rawItems, '.webp');

    if (!items.length) {
      sendToRenderer('squeeze:onAllDone');
      return;
    }

    cancelRequested = false;
    activeRun = true;

    runQueue(items, imgOptions, compressImageItem)
      .catch(() => { /* per-item errors already emitted */ })
      .finally(() => {
        activeRun = false;
        runningChildren.clear();
        sendToRenderer('squeeze:onAllDone');
      });
  });

  // Cancel everything: kill running children, stop the queue.
  ipcMain.handle('squeeze:cancelAll', async () => {
    cancelRequested = true;
    for (const child of runningChildren.values()) {
      try {
        child.kill('SIGKILL');
      } catch (_) { /* ignore */ }
    }
    runningChildren.clear();
  });

  // Reveal a file in the OS file manager (selects the item).
  ipcMain.handle('squeeze:reveal', async (_evt, p) => {
    if (p) {
      try {
        shell.showItemInFolder(path.resolve(p));
      } catch (_) { /* ignore */ }
    }
  });

  // Open a path (e.g. a folder) in the OS file manager.
  ipcMain.handle('squeeze:openPath', async (_evt, p) => {
    if (p) {
      try {
        await shell.openPath(path.resolve(p));
      } catch (_) { /* ignore */ }
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    try {
      resolveBinaries();
    } catch (err) {
      // Surface a clear error if binaries can't be resolved.
      dialog.showErrorBox(
        'Squeeze',
        'Failed to locate bundled ffmpeg/ffprobe.\n' + (err && err.message ? err.message : String(err))
      );
    }
    // Resolve cwebp best-effort; absence is surfaced per image item instead.
    try {
      resolveCwebp();
    } catch (_) { /* ignore */ }
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Cancel any in-flight work before quitting.
    cancelRequested = true;
    for (const child of runningChildren.values()) {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    runningChildren.clear();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    cancelRequested = true;
    for (const child of runningChildren.values()) {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    runningChildren.clear();
  });
}
