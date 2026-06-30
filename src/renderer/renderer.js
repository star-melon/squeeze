/* Squeeze — renderer logic. Consumes ONLY window.squeeze (no node/require). */
'use strict';

(function () {
  const sq = window.squeeze;

  const AUDIO_KBPS = 128;

  // ===== Shared run state (single run at a time across both panels) =====
  let running = false;
  let activePanel = null; // the panel whose run is currently active
  /** @type {Array<function():void>} */
  const startEnablers = [];

  function setGlobalRunning(isRunning) {
    running = isRunning;
    // While running, Start is disabled on BOTH panels. When idle, each panel
    // re-evaluates its own enable condition.
    for (const fn of startEnablers) fn();
  }

  // ===== Helpers =====
  function fmtBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  function basename(p) {
    if (!p) return '';
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function dirname(p) {
    if (!p) return '';
    const parts = p.split(/[\\/]/);
    parts.pop();
    return parts.join(p.indexOf('\\') >= 0 && p.indexOf('/') < 0 ? '\\' : '/');
  }

  function joinPath(dir, name) {
    const sep = dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function clamp(n, lo, hi) {
    n = parseInt(n, 10);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  // ===== Event registries: route backend events to the owning panel =====
  /** id -> panel */
  const idOwner = new Map();
  /** @type {Array<object>} */
  const panels = [];

  function panelForId(id) {
    return idOwner.get(id) || null;
  }

  // ===========================================================================
  //  Panel factory — encapsulates a working list + completed list for one tab.
  // ===========================================================================
  function createPanel(cfg) {
    const el = {};
    for (const key in cfg.ids) {
      el[key] = document.getElementById(cfg.ids[key]);
    }

    /** @type {Map<string, {info:object, status:string, percent:number, row:HTMLElement}>} */
    const files = new Map();
    let chosenOutputDir = null;        // null => per-file default (source/compressed)
    let lastCompletedDir = null;       // dir of most recently completed item

    const panel = {
      el: el,
      files: files,
      // exposed for routing
      hasId: function (id) { return files.has(id); },
    };
    panels.push(panel);

    // ---- enable logic ----
    function canStart() {
      return !running && files.size > 0 && cfg.inputsValid();
    }
    function updateStartEnabled() {
      el.btnStart.disabled = !canStart();
    }
    startEnablers.push(updateStartEnabled);

    function updateEmptyHint() {
      el.emptyHint.classList.toggle('is-hidden', files.size > 0);
    }

    // ---- output dir ----
    // Expose the privately-tracked chosen dir so cfg.buildItems can mirror it.
    panel.getChosenDir = function () { return chosenOutputDir; };
    function effectiveDir() {
      return chosenOutputDir || lastCompletedDir || null;
    }
    function updateOpenButton() {
      el.btnOpenOutput.disabled = !effectiveDir();
    }
    function renderOutputDir() {
      if (chosenOutputDir) {
        el.outputDir.textContent = chosenOutputDir;
        el.outputDir.title = chosenOutputDir;
      } else {
        el.outputDir.textContent = '默认：源文件夹/compressed';
        el.outputDir.title = '默认输出到每个源文件所在文件夹下的 compressed 子目录';
      }
      updateOpenButton();
    }
    async function changeOutputDir() {
      try {
        const dir = await sq.chooseOutputDir();
        if (dir) { chosenOutputDir = dir; renderOutputDir(); }
      } catch (e) { /* cancelled */ }
    }
    function openOutput() {
      const dir = effectiveDir();
      if (!dir) return;
      try { sq.openPath(dir); } catch (e) { /* ignore */ }
    }

    // ---- overall ----
    function setOverallStatus(text) { el.overallStatus.textContent = text; }
    function updateOverall() {
      const total = files.size;
      let sumPercent = 0;
      let done = 0;
      for (const rec of files.values()) {
        if (rec.status === 'done' || rec.status === 'error') { sumPercent += 100; done++; }
        else sumPercent += rec.percent;
      }
      // Include already-moved (completed) rows as 100% so the bar reflects true
      // progress instead of dropping/snapping to 0 as rows leave the working list.
      const totalAll = total + panel._movedCount;
      const overall = totalAll ? (sumPercent + panel._movedCount * 100) / totalAll : 0;
      el.overallBar.style.width = Math.max(0, Math.min(100, overall)) + '%';
      // Count includes already-moved completed rows too.
      el.overallCount.textContent = (done + panel._movedCount) + ' / ' + (total + panel._movedCount);
    }
    panel._movedCount = 0;

    // ---- working row ----
    function makeRow(info) {
      const li = document.createElement('li');
      li.className = 'file-row';
      li.dataset.id = info.id;

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = info.name || basename(info.path);
      name.title = info.path || '';

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      const size = document.createElement('span');
      size.className = 'file-old-size';
      size.textContent = fmtBytes(info.bytes);
      const remove = document.createElement('button');
      remove.className = 'file-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除 · Remove';
      remove.addEventListener('click', function () {
        if (running) return;
        files.delete(info.id);
        idOwner.delete(info.id);
        li.remove();
        updateEmptyHint();
        updateStartEnabled();
        updateOverall();
      });
      meta.appendChild(size);
      meta.appendChild(remove);

      const progress = document.createElement('div');
      progress.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      progress.appendChild(bar);

      const status = document.createElement('div');
      status.className = 'file-status';
      status.textContent = '排队中 · Queued';

      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(progress);
      li.appendChild(status);

      li._bar = bar;
      li._progress = progress;
      li._status = status;
      li._remove = remove;
      return li;
    }

    function setRowPercent(id, pct) {
      const rec = files.get(id);
      if (!rec) return;
      rec.percent = pct;
      rec.row._bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    function setRowStatus(id, text) {
      const rec = files.get(id);
      if (!rec) return;
      rec.row._status.textContent = text;
    }
    function setRowIndeterminate(id, on) {
      const rec = files.get(id);
      if (!rec) return;
      rec.row._progress.classList.toggle('is-indeterminate', !!on);
      if (on) rec.row._bar.style.width = '';
    }

    // ---- completed row ----
    function moveToCompleted(rec, d) {
      const info = rec.info;
      // remove from working list
      rec.row.remove();
      files.delete(info.id);

      const li = document.createElement('li');
      li.className = 'completed-row';

      const name = document.createElement('div');
      name.className = 'completed-name';
      name.textContent = basename(d.output) || info.name || basename(info.path);
      name.title = d.output || '';

      const inf = document.createElement('div');
      inf.className = 'completed-info';
      const saved = (d.savedPct != null) ? d.savedPct : 0;
      inf.innerHTML = '';
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = fmtBytes(d.newBytes);
      const savedSpan = document.createElement('span');
      savedSpan.className = 'completed-saved';
      savedSpan.textContent = ' · 节省 ' + saved + '%';
      inf.appendChild(sizeSpan);
      inf.appendChild(savedSpan);

      const open = document.createElement('button');
      open.className = 'completed-open';
      open.type = 'button';
      open.textContent = '打开 · Open';
      open.title = '在文件夹中显示 · Reveal in folder';
      open.addEventListener('click', function () {
        try { sq.reveal(d.output); } catch (e) { /* ignore */ }
      });

      li.appendChild(name);
      li.appendChild(inf);
      li.appendChild(open);
      el.completedList.appendChild(li);

      panel._movedCount++;
      el.completedSection.classList.remove('is-empty');
      el.completedCount.textContent = String(panel._movedCount);

      // track output dir for the "open output folder" button
      lastCompletedDir = dirname(d.output) || lastCompletedDir;
      updateOpenButton();

      updateEmptyHint();
    }

    // ---- add files ----
    function addInfos(infos) {
      if (!Array.isArray(infos)) return;
      let added = 0;
      for (const info of infos) {
        if (!info || !info.id) continue;
        if (files.has(info.id)) continue;
        const row = makeRow(info);
        files.set(info.id, { info: info, status: 'queued', percent: 0, row: row });
        idOwner.set(info.id, panel);
        el.fileList.appendChild(row);
        added++;
      }
      if (added) {
        updateEmptyHint();
        updateStartEnabled();
        updateOverall();
      }
    }

    async function addViaDialog() {
      try { addInfos(await cfg.addDialog()); }
      catch (e) { setOverallStatus('添加失败 · Failed to add'); }
    }
    async function addViaPaths(paths) {
      if (!paths || !paths.length) return;
      try { addInfos(await cfg.addPaths(paths)); }
      catch (e) { setOverallStatus('添加失败 · Failed to add'); }
    }

    // ---- running UI ----
    function setRunningUI(isRunning) {
      el.btnStart.hidden = isRunning;
      el.btnCancel.hidden = !isRunning;
      el.btnAddFiles.disabled = isRunning;
      el.btnChangeOutput.disabled = isRunning;
      if (cfg.setControlsDisabled) cfg.setControlsDisabled(isRunning);
      for (const rec of files.values()) {
        if (rec.row._remove) rec.row._remove.disabled = isRunning;
      }
    }

    // ---- start / cancel ----
    async function start() {
      if (running) return;
      if (files.size === 0) { setOverallStatus('请先添加 · Add files first'); return; }
      if (!cfg.inputsValid()) { setOverallStatus('参数无效 · Invalid options'); return; }

      // reset working rows
      for (const [id, rec] of files) {
        rec.status = 'queued';
        rec.percent = 0;
        rec.row.classList.remove('is-done', 'is-error');
        setRowIndeterminate(id, false);
        setRowPercent(id, 0);
        setRowStatus(id, '排队中 · Queued');
      }
      updateOverall();

      let items;
      try { items = await cfg.buildItems(files); }
      catch (e) { setOverallStatus('构建输出路径失败 · Failed to build outputs'); return; }

      const payload = { items: items, options: cfg.buildOptions() };

      activePanel = panel;
      setGlobalRunning(true);
      setRunningUI(true);
      setOverallStatus('压缩中 · Compressing…');
      if (cfg.onStart) cfg.onStart(files);
      try { cfg.invokeStart(payload); }
      catch (e) {
        activePanel = null;
        setGlobalRunning(false);
        setRunningUI(false);
        setOverallStatus('启动失败 · Failed to start');
      }
    }

    function cancel() {
      if (!running) return;
      try { sq.cancelAll(); } catch (e) { /* ignore */ }
      setOverallStatus('正在取消 · Cancelling…');
    }

    // ---- backend event handlers (called by global router for owned ids) ----
    panel.onProgress = function (p) {
      const rec = files.get(p.id);
      if (!rec || rec.status === 'done' || rec.status === 'error') return;
      rec.status = p.pass === 1 ? 'pass1' : 'pass2';
      setRowIndeterminate(p.id, false);
      setRowPercent(p.id, p.itemPercent);
      let label = (p.pass === 1 ? '分析中 Pass 1' : '压缩中 Pass 2') +
        ' · ' + Math.round(p.itemPercent) + '%';
      if (p.speed) label += '  ' + p.speed;
      setRowStatus(p.id, label);
      updateOverall();
    };

    panel.onItemDone = function (d) {
      const rec = files.get(d.id);
      if (!rec) return;
      rec.status = 'done';
      rec.percent = 100;
      setRowIndeterminate(d.id, false);
      idOwner.delete(d.id);
      moveToCompleted(rec, d);
      updateOverall();
    };

    panel.onItemError = function (e) {
      const rec = files.get(e.id);
      if (!rec) return;
      rec.status = 'error';
      rec.percent = 100;
      setRowIndeterminate(e.id, false);
      rec.row.classList.add('is-error');
      rec.row.classList.remove('is-done');
      setRowPercent(e.id, 100);
      setRowStatus(e.id, '失败 · ' + (e.message || 'Error'));
      updateOverall();
    };

    panel.onAllDone = function () {
      setRunningUI(false);
      updateOverall();
      let bad = 0;
      for (const rec of files.values()) {
        if (rec.status === 'error') bad++;
      }
      const ok = panel._movedCount;
      if (bad === 0) setOverallStatus('全部完成 · All done (' + ok + ')');
      else setOverallStatus('完成 ' + ok + ' · 失败 ' + bad + ' · Done with errors');
    };

    // ---- wire base controls ----
    el.btnAddFiles.addEventListener('click', addViaDialog);
    el.btnChangeOutput.addEventListener('click', changeOutputDir);
    el.btnOpenOutput.addEventListener('click', openOutput);
    el.btnStart.addEventListener('click', start);
    el.btnCancel.addEventListener('click', cancel);

    // drag & drop
    el.dropZone.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      if (running) return;
      el.dropZone.classList.add('is-dragover');
    });
    el.dropZone.addEventListener('dragleave', function (ev) {
      ev.preventDefault();
      el.dropZone.classList.remove('is-dragover');
    });
    el.dropZone.addEventListener('drop', function (ev) {
      ev.preventDefault();
      el.dropZone.classList.remove('is-dragover');
      if (running) return;
      const dt = ev.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      const paths = [];
      for (const f of dt.files) {
        let p = null;
        try { p = sq.pathForFile(f); } catch (e) { p = null; }
        if (p) paths.push(p);
      }
      if (paths.length) addViaPaths(paths);
    });

    // expose what the rest needs
    panel.setOverallStatus = setOverallStatus;
    panel.updateOverall = updateOverall;
    panel.updateStartEnabled = updateStartEnabled;
    panel.updateEmptyHint = updateEmptyHint;
    panel.renderOutputDir = renderOutputDir;
    panel.setRowIndeterminate = setRowIndeterminate;
    panel.setRowStatus = setRowStatus;

    // init
    renderOutputDir();
    updateEmptyHint();
    updateOverall();
    updateStartEnabled();

    return panel;
  }

  // ===========================================================================
  //  VIDEO panel
  // ===========================================================================
  let videoPreset = 'slow';

  const vEl = {
    targetMbps: document.getElementById('v-input-target-mbps'),
    kbpsLabel: document.getElementById('v-kbps-label'),
    presetSegmented: document.getElementById('v-preset-segmented'),
    removeAudio: document.getElementById('v-checkbox-remove-audio'),
    concurrency: document.getElementById('v-select-concurrency'),
  };

  function vTotalKbps() {
    const mbps = parseFloat(vEl.targetMbps.value);
    if (!isFinite(mbps) || mbps <= 0) return NaN;
    return Math.round(mbps * 8192);
  }
  function vVideoKbps() {
    const total = vTotalKbps();
    if (!isFinite(total)) return NaN;
    if (vEl.removeAudio.checked) return total;
    return Math.max(200, total - AUDIO_KBPS);
  }
  function vUpdateKbpsLabel() {
    const total = vTotalKbps();
    if (!isFinite(total)) {
      vEl.kbpsLabel.textContent = '≈ — kbps';
      vEl.kbpsLabel.style.color = 'var(--danger)';
    } else {
      vEl.kbpsLabel.textContent = '≈ ' + total + ' kbps';
      vEl.kbpsLabel.style.color = '';
    }
  }

  const videoPanel = createPanel({
    ids: {
      dropZone: 'v-drop-zone',
      btnAddFiles: 'v-btn-add-files',
      outputDir: 'v-output-dir',
      btnChangeOutput: 'v-btn-change-output',
      btnOpenOutput: 'v-btn-open-output',
      fileList: 'v-file-list',
      emptyHint: 'v-empty-hint',
      completedSection: 'v-completed-section',
      completedList: 'v-completed-list',
      completedCount: 'v-completed-count',
      overallCount: 'v-overall-count',
      overallStatus: 'v-overall-status',
      overallBar: 'v-overall-bar',
      btnStart: 'v-btn-start',
      btnCancel: 'v-btn-cancel',
    },
    addDialog: function () { return sq.addFilesViaDialog(); },
    addPaths: function (paths) { return sq.addPaths(paths); },
    inputsValid: function () { return isFinite(vTotalKbps()); },
    buildItems: async function (files) {
      const used = new Set();
      const items = [];
      for (const [id, rec] of files) {
        const info = rec.info;
        let dir = null; // chosen dir handled inside panel; recompute via defaultOutputDirFor
        // The chosen dir is tracked inside the panel; mirror that decision here:
        dir = videoPanel._chosenDir();
        if (!dir) dir = await sq.defaultOutputDirFor(info.path);
        const base = stripExt(info.name || basename(info.path));
        let candidate = joinPath(dir, base + '.mp4');
        if (candidate.toLowerCase() === String(info.path).toLowerCase()) {
          candidate = joinPath(dir, base + '_compressed.mp4');
        }
        let n = 1;
        let finalPath = candidate;
        while (used.has(finalPath.toLowerCase())) {
          finalPath = joinPath(dir, base + '_' + n + '.mp4');
          if (finalPath.toLowerCase() === String(info.path).toLowerCase()) {
            finalPath = joinPath(dir, base + '_' + n + '_compressed.mp4');
          }
          n++;
        }
        used.add(finalPath.toLowerCase());
        items.push({ id: id, input: info.path, output: finalPath });
      }
      return items;
    },
    buildOptions: function () {
      return {
        videoKbps: vVideoKbps(),
        removeAudio: vEl.removeAudio.checked,
        audioKbps: AUDIO_KBPS,
        preset: videoPreset,
        concurrency: parseInt(vEl.concurrency.value, 10) || 2,
      };
    },
    invokeStart: function (payload) { sq.start(payload); },
    setControlsDisabled: function (disabled) {
      vEl.targetMbps.disabled = disabled;
      vEl.removeAudio.disabled = disabled;
      vEl.concurrency.disabled = disabled;
      for (const seg of vEl.presetSegmented.querySelectorAll('.segment')) {
        seg.disabled = disabled;
      }
    },
  });

  // The panel owns chosenOutputDir privately; expose a reader for buildItems.
  videoPanel._chosenDir = function () { return videoPanel.getChosenDir(); };

  // video-specific control wiring
  vEl.targetMbps.addEventListener('input', function () {
    vUpdateKbpsLabel();
    videoPanel.updateStartEnabled();
  });
  vEl.removeAudio.addEventListener('change', vUpdateKbpsLabel);
  vEl.presetSegmented.addEventListener('click', function (ev) {
    const btn = ev.target.closest('.segment');
    if (!btn || running) return;
    videoPreset = btn.dataset.preset;
    for (const seg of vEl.presetSegmented.querySelectorAll('.segment')) {
      seg.classList.toggle('is-active', seg === btn);
    }
  });
  vUpdateKbpsLabel();

  // ===========================================================================
  //  IMAGE panel
  // ===========================================================================
  let imageMode = 'lossless';

  const iEl = {
    modeSegmented: document.getElementById('i-mode-segmented'),
    sizeGroup: document.getElementById('i-size-group'),
    sizeKb: document.getElementById('i-input-size-kb'),
    qualityGroup: document.getElementById('i-quality-group'),
    quality: document.getElementById('i-input-quality'),
    qualityValue: document.getElementById('i-quality-value'),
    concurrency: document.getElementById('i-select-concurrency'),
  };

  function iInputsValid() {
    if (imageMode === 'size') {
      const kb = parseFloat(iEl.sizeKb.value);
      return isFinite(kb) && kb > 0;
    }
    if (imageMode === 'quality') {
      const q = parseInt(iEl.quality.value, 10);
      return isFinite(q) && q >= 1 && q <= 100;
    }
    return true; // lossless
  }

  function iRefreshModeUI() {
    const sizeOn = imageMode === 'size';
    const qualOn = imageMode === 'quality';
    // Keep both controls visible; only the active mode's input is enabled,
    // the others are grayed out / disabled.
    iEl.sizeGroup.classList.toggle('is-disabled', !sizeOn);
    iEl.qualityGroup.classList.toggle('is-disabled', !qualOn);
    iEl.sizeKb.disabled = !sizeOn;
    iEl.quality.disabled = !qualOn;
  }

  const imagePanel = createPanel({
    ids: {
      dropZone: 'i-drop-zone',
      btnAddFiles: 'i-btn-add-files',
      outputDir: 'i-output-dir',
      btnChangeOutput: 'i-btn-change-output',
      btnOpenOutput: 'i-btn-open-output',
      fileList: 'i-file-list',
      emptyHint: 'i-empty-hint',
      completedSection: 'i-completed-section',
      completedList: 'i-completed-list',
      completedCount: 'i-completed-count',
      overallCount: 'i-overall-count',
      overallStatus: 'i-overall-status',
      overallBar: 'i-overall-bar',
      btnStart: 'i-btn-start',
      btnCancel: 'i-btn-cancel',
    },
    addDialog: function () { return sq.addImagesViaDialog(); },
    addPaths: function (paths) { return sq.addImagePaths(paths); },
    inputsValid: iInputsValid,
    buildItems: async function (files) {
      const used = new Set();
      const items = [];
      for (const [id, rec] of files) {
        const info = rec.info;
        let dir = imagePanel._chosenDir();
        if (!dir) dir = await sq.defaultOutputDirFor(info.path);
        const base = stripExt(info.name || basename(info.path));
        let candidate = joinPath(dir, base + '.webp');
        if (candidate.toLowerCase() === String(info.path).toLowerCase()) {
          candidate = joinPath(dir, base + '_compressed.webp');
        }
        let n = 1;
        let finalPath = candidate;
        while (used.has(finalPath.toLowerCase())) {
          finalPath = joinPath(dir, base + '_' + n + '.webp');
          if (finalPath.toLowerCase() === String(info.path).toLowerCase()) {
            finalPath = joinPath(dir, base + '_' + n + '_compressed.webp');
          }
          n++;
        }
        used.add(finalPath.toLowerCase());
        items.push({ id: id, input: info.path, output: finalPath });
      }
      return items;
    },
    buildOptions: function () {
      return {
        mode: imageMode,
        sizeKB: clamp(iEl.sizeKb.value, 1, 100000),
        quality: clamp(iEl.quality.value, 1, 100),
        concurrency: clamp(iEl.concurrency.value, 1, 4),
      };
    },
    invokeStart: function (payload) { sq.startImages(payload); },
    onStart: function (files) {
      // cwebp has no granular progress — show indeterminate "Compressing…" per row.
      for (const [id] of files) {
        imagePanel.setRowIndeterminate(id, true);
        imagePanel.setRowStatus(id, '压缩中… · Compressing…');
      }
    },
    setControlsDisabled: function (disabled) {
      iEl.concurrency.disabled = disabled;
      for (const seg of iEl.modeSegmented.querySelectorAll('.segment')) {
        seg.disabled = disabled;
      }
      if (disabled) {
        iEl.sizeKb.disabled = true;
        iEl.quality.disabled = true;
      } else {
        iRefreshModeUI(); // restore mode-based enable/disable after a run
      }
    },
  });

  imagePanel._chosenDir = function () { return imagePanel.getChosenDir(); };

  // image-specific control wiring
  iEl.modeSegmented.addEventListener('click', function (ev) {
    const btn = ev.target.closest('.segment');
    if (!btn || running) return;
    imageMode = btn.dataset.mode;
    for (const seg of iEl.modeSegmented.querySelectorAll('.segment')) {
      seg.classList.toggle('is-active', seg === btn);
    }
    iRefreshModeUI();
    imagePanel.updateStartEnabled();
  });
  iEl.sizeKb.addEventListener('input', function () { imagePanel.updateStartEnabled(); });
  iEl.quality.addEventListener('input', function () {
    iEl.qualityValue.textContent = String(clamp(iEl.quality.value, 1, 100));
    imagePanel.updateStartEnabled();
  });
  iRefreshModeUI();
  iEl.qualityValue.textContent = String(clamp(iEl.quality.value, 1, 100));

  // ===========================================================================
  //  Global backend event routing — dispatch to the panel that owns the id.
  // ===========================================================================
  sq.onProgress(function (p) {
    if (!p) return;
    const panel = panelForId(p.id);
    if (panel) panel.onProgress(p);
  });
  sq.onItemDone(function (d) {
    if (!d) return;
    const panel = panelForId(d.id);
    if (panel) panel.onItemDone(d);
  });
  sq.onItemError(function (e) {
    if (!e) return;
    const panel = panelForId(e.id);
    if (panel) panel.onItemError(e);
  });
  sq.onAllDone(function () {
    setGlobalRunning(false);
    // Only the panel that actually ran should report completion; otherwise the
    // idle panel would overwrite its status with a stale "All done".
    const p = activePanel;
    activePanel = null;
    if (p) p.onAllDone();
  });

  // ===========================================================================
  //  Tab switching
  // ===========================================================================
  const tabs = document.querySelectorAll('.tab');
  const tabPanels = {
    'panel-video': document.getElementById('panel-video'),
    'panel-image': document.getElementById('panel-image'),
  };
  function activateTab(tabBtn) {
    const targetId = tabBtn.dataset.panel;
    for (const t of tabs) {
      const on = t === tabBtn;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const pid in tabPanels) {
      const p = tabPanels[pid];
      const on = pid === targetId;
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    }
  }
  for (const t of tabs) {
    t.addEventListener('click', function () { activateTab(t); });
  }

  // Prevent the whole window from navigating when files are dropped outside a zone.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
})();
