# Squeeze

Squeeze is a minimal, clean cross-platform (Windows + macOS) desktop app that compresses videos. Add files by drag & drop or the **Add files** button, pick a target bitrate in MB/s, and Squeeze encodes them to H.264 (`libx264`) using **two-pass ABR** to hit your target size precisely with the best quality at that bitrate.

## Features

- Batch compression with adjustable parallelism (并行数, 1–4)
- Target bitrate in MB/s with a live `≈ N kbps` readout
- Keep or remove audio
- Quality/speed presets: Fast / Balanced / Best
- Per-file and overall live progress, new size, and saved %
- Default output to `<source-folder>/compressed/<name>.mp4`; never overwrites the input

## Requirements

- [Node.js](https://nodejs.org/) (LTS recommended)

**ffmpeg is bundled** via the `ffmpeg-static` and `ffprobe-static` npm packages — there is no separate ffmpeg install or PATH setup. They are unpacked from the asar archive in packaged builds automatically.

## Run (development)

```bash
npm install
npm start
```

## Build (distributables)

Output goes to the `dist/` folder.

```bash
# Windows installer (NSIS) — run on Windows
npm run build:win

# macOS disk image (DMG) — run on a Mac
npm run build:mac
```

Note: a macOS **DMG can only be produced on macOS**, and the Windows installer is built on Windows. Run each build command on its matching platform.

## License

MIT
