#!/usr/bin/env node
// Generates the PWA icon set from a vector source, so the marks are crisp at
// every size and reproducible rather than checked in as opaque binaries.
//
// The manifest previously pointed at https://picsum.photos/seed/... — random
// placeholder photos served from a third party. Those are not icons, they are
// not cacheable offline, and Chrome will not consider a page installable when
// its 192/512 icons are cross-origin or decorative randoms.
//
// Run: node scripts/generate-pwa-icons.mjs
//
// Maskable icons keep every meaningful pixel inside the central 80% safe zone,
// because launchers crop maskable icons to a circle, squircle or teardrop
// depending on the device. Text or edges outside that zone get clipped.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Brand palette, matching app/layout.tsx viewport themeColor and the manifest
// background_color. Keep these three in step or the splash flashes a seam.
const INK = '#1E1208';   // near-black brown — theme_color
const CREAM = '#F0E6D3'; // warm off-white — background_color
const WOOD = '#3A2513';  // raised surface

// A church window: a cream arch with the cross cut out of it. Deliberately
// geometric — it has to survive being 48px in a notification shade.
function archMark({ scale = 1 } = {}) {
  const s = 512;
  const cx = s / 2;
  const w = 200 * scale;
  const left = cx - w / 2;
  const right = cx + w / 2;
  const radius = w / 2;
  const top = 136 * scale + (s - s * scale) / 2 + 0;
  const bottom = 400;
  const archTop = top + radius - radius; // arch begins at the top of the curve

  // Arch: a rectangle with a semicircular head.
  const arch = [
    `M ${left} ${bottom}`,
    `L ${left} ${archTop + radius}`,
    `A ${radius} ${radius} 0 0 1 ${right} ${archTop + radius}`,
    `L ${right} ${bottom}`,
    'Z',
  ].join(' ');

  const bar = 30 * scale;
  const crossV = { x: cx - bar / 2, y: top + 44 * scale, w: bar, h: 140 * scale };
  const crossH = { x: cx - 60 * scale, y: top + 89 * scale, w: 120 * scale, h: bar };

  return `
    <path d="${arch}" fill="${CREAM}"/>
    <rect x="${crossV.x}" y="${crossV.y}" width="${crossV.w}" height="${crossV.h}" rx="${bar / 3}" fill="${INK}"/>
    <rect x="${crossH.x}" y="${crossH.y}" width="${crossH.w}" height="${crossH.h}" rx="${bar / 3}" fill="${INK}"/>
  `;
}

// `safe` inserts the 10% margin maskable icons need.
function svg({ safe = false, background = INK } = {}) {
  if (!safe) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <rect width="512" height="512" fill="${background}"/>
      ${archMark()}
    </svg>`;
  }
  // Full-bleed background, mark scaled into the safe zone.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" fill="${background}"/>
    <g transform="translate(256 256) scale(0.74) translate(-256 -256)">
      ${archMark()}
    </g>
  </svg>`;
}

// Apple touch icons must be opaque — iOS composites them onto its own
// background and a transparent PNG shows up as a black square.
function appleSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" fill="${INK}"/>
    <g transform="translate(256 256) scale(0.86) translate(-256 -256)">
      ${archMark()}
    </g>
  </svg>`;
}

const TARGETS = [
  { file: 'public/icons/icon-192.png', size: 192, svg: svg() },
  { file: 'public/icons/icon-512.png', size: 512, svg: svg() },
  { file: 'public/icons/maskable-192.png', size: 192, svg: svg({ safe: true }) },
  { file: 'public/icons/maskable-512.png', size: 512, svg: svg({ safe: true }) },
  { file: 'public/icons/apple-touch-icon.png', size: 180, svg: appleSvg() },
  // Next.js file conventions: app/icon.png becomes the favicon link,
  // app/apple-icon.png becomes <link rel="apple-touch-icon">.
  { file: 'app/icon.png', size: 64, svg: svg() },
  { file: 'app/apple-icon.png', size: 180, svg: appleSvg() },
];

// Rounded corners for the any-purpose icons, so Android's launcher does not
// show the mark as a hard-edged square next to rounded neighbours.
const ROUNDED = new Set(['public/icons/icon-192.png', 'public/icons/icon-512.png', 'app/icon.png']);

async function main() {
  for (const t of TARGETS) {
    const out = join(ROOT, t.file);
    await mkdir(dirname(out), { recursive: true });

    let img = sharp(Buffer.from(t.svg)).resize(t.size, t.size, { fit: 'cover' });

    if (ROUNDED.has(t.file)) {
      const r = Math.round(t.size * 0.22);
      const mask = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${t.size}" height="${t.size}">
           <rect width="${t.size}" height="${t.size}" rx="${r}" ry="${r}" fill="#fff"/>
         </svg>`);
      img = sharp(await img.png().toBuffer())
        .composite([{ input: await sharp(mask).png().toBuffer(), blend: 'dest-in' }]);
    }

    await img.png({ compressionLevel: 9 }).toFile(out);
    console.log(`  ${t.file.padEnd(38)} ${t.size}x${t.size}`);
  }
  console.log(`\n✔ ${TARGETS.length} icons written`);
}

main().catch((err) => {
  console.error('icon generation failed:', err);
  process.exit(1);
});
