'use strict';
// Rasterize build/icon.svg -> build/icon.png (1024) + build/icon.ico (multi-size).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const _pngToIco = require('png-to-ico');
const pngToIco = typeof _pngToIco === 'function' ? _pngToIco : _pngToIco.default;

const buildDir = path.join(__dirname, 'build');
const svg = fs.readFileSync(path.join(buildDir, 'icon.svg'));

(async () => {
  await sharp(svg, { density: 384 })
    .resize(1024, 1024)
    .png()
    .toFile(path.join(buildDir, 'icon.png'));

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const bufs = [];
  for (const s of sizes) {
    bufs.push(await sharp(svg, { density: 384 }).resize(s, s).png().toBuffer());
  }
  const ico = await pngToIco(bufs);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('OK: build/icon.png (1024) + build/icon.ico (' + sizes.join(',') + ')');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
