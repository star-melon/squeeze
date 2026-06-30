'use strict';

/*
 * Squeeze — preload (contextBridge).
 *
 * Exposes window.squeeze with EXACTLY the shared-contract surface. The renderer
 * gets capabilities only through this object (contextIsolation:true).
 *
 * IPC channel names (must match main.js):
 *   invoke:
 *     'squeeze:addFilesViaDialog'
 *     'squeeze:addPaths'
 *     'squeeze:addImagesViaDialog'
 *     'squeeze:addImagePaths'
 *     'squeeze:chooseOutputDir'
 *     'squeeze:defaultOutputDirFor'
 *     'squeeze:start'          (video)
 *     'squeeze:startImages'    (images)
 *     'squeeze:cancelAll'
 *     'squeeze:reveal'
 *     'squeeze:openPath'
 *   events (main -> renderer):
 *     'squeeze:onProgress'     (video only)
 *     'squeeze:onItemDone'     (video + images)
 *     'squeeze:onItemError'    (video + images)
 *     'squeeze:onAllDone'      (video + images)
 *
 * Each on* registrar wraps ipcRenderer.on and RETURNS an unsubscribe function.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Build an event registrar that returns an unsubscribe function.
function makeRegistrar(channel) {
  return function register(cb) {
    if (typeof cb !== 'function') {
      return function noop() {};
    }
    const listener = (_event, payload) => {
      cb(payload);
    };
    ipcRenderer.on(channel, listener);
    return function unsubscribe() {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const squeeze = {
  // ----- invoke methods (return Promises) -----

  // Open a video file dialog in main, probe each, return FileInfo[].
  addFilesViaDialog() {
    return ipcRenderer.invoke('squeeze:addFilesViaDialog');
  },

  // Probe the given absolute paths (drag & drop) -> FileInfo[].
  addPaths(paths) {
    return ipcRenderer.invoke('squeeze:addPaths', paths);
  },

  // Open an image file dialog in main, probe each, return ImageInfo[].
  addImagesViaDialog() {
    return ipcRenderer.invoke('squeeze:addImagesViaDialog');
  },

  // Probe the given absolute image paths (drag & drop) -> ImageInfo[].
  addImagePaths(paths) {
    return ipcRenderer.invoke('squeeze:addImagePaths', paths);
  },

  // PRELOAD-ONLY sync helper: resolve the real filesystem path of a dropped
  // File object in modern Electron. Returns a string (or '' on failure).
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return '';
    }
  },

  // Choose an output directory -> string | null.
  chooseOutputDir() {
    return ipcRenderer.invoke('squeeze:chooseOutputDir');
  },

  // Default output dir for a source path -> dirname(path)+'/compressed'.
  defaultOutputDirFor(p) {
    return ipcRenderer.invoke('squeeze:defaultOutputDirFor', p);
  },

  // Begin VIDEO compression. payload = { items, options }. Returns Promise<void>.
  start(payload) {
    return ipcRenderer.invoke('squeeze:start', payload);
  },

  // Begin IMAGE compression (cwebp). payload = { items, options:{ mode, sizeKB,
  // quality, concurrency } }. Returns Promise<void>.
  startImages(payload) {
    return ipcRenderer.invoke('squeeze:startImages', payload);
  },

  // Cancel all running + queued work. Returns Promise<void>.
  cancelAll() {
    return ipcRenderer.invoke('squeeze:cancelAll');
  },

  // Reveal a file in the OS file manager. Returns Promise<void>.
  reveal(p) {
    return ipcRenderer.invoke('squeeze:reveal', p);
  },

  // Open a path (folder) in the OS file manager. Returns Promise<void>.
  openPath(p) {
    return ipcRenderer.invoke('squeeze:openPath', p);
  },

  // ----- event registrars (return unsubscribe fns) -----

  // cb({ id, pass, itemPercent, speed, fps }) — VIDEO only.
  onProgress: makeRegistrar('squeeze:onProgress'),

  // cb({ id, ok:true, output, oldBytes, newBytes, mbps, savedPct }) — video + images.
  onItemDone: makeRegistrar('squeeze:onItemDone'),

  // cb({ id, ok:false, message }) — video + images.
  onItemError: makeRegistrar('squeeze:onItemError'),

  // cb() — video + images.
  onAllDone: makeRegistrar('squeeze:onAllDone'),
};

contextBridge.exposeInMainWorld('squeeze', squeeze);
