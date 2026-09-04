#!/usr/bin/env node
/**
 * 合成压测用的占位图片（手头没有真实食材照片时的兜底）。
 *
 * ⚠️ 这批图不含任何真实食材。模型看不出东西，会返回空的 ingredients 数组，
 *    于是 completion_tokens 会明显少于真实照片，t_e2e_ms / tpot_ms / cost_total
 *    也跟着偏低。**合成图的数据不能跟真实照片的数据混在一张表里比。**
 *    它只用来验证链路能跑通，以及测「上传 + prefill」这一段（request_body_bytes、
 *    t_req_body_ms、t_ttfb_ms 是可信的，因为它们只跟图片体积和图片 token 数有关）。
 *    正式长测前请换成真实照片：node tools/prepare-fixtures.mjs
 *
 * 规格与生产环境（大厨秘诀 image-compressor.js）对齐：长边 1280px、JPEG quality 0.82。
 * 图案用**固定种子**的伪随机噪声 + 色块，不用 Math.random()，保证同一台机器重跑
 * 得到完全一样的像素。噪声是必须的：纯色块的 JPEG 只有几十 KB，
 * 上传耗时会比真实照片小一个量级，测出来的 t_req_body_ms 毫无意义。
 *
 * 本地一次性脚本，sharp 只是 devDependency，CI 运行时不装、也不会跑它。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Windows 上 path.relative 给的是反斜杠，跟提示里的命令混排会很难读。 */
function rel(target) {
  return path.relative(ROOT, target).split(path.sep).join('/');
}

/** 与 image-compressor.js 的 DEFAULTS 对齐；长边 1280、4:3 横构图。 */
const WIDTH = 1280;
const HEIGHT = 960;
const JPEG_QUALITY = 82;

const OUTPUT_COUNT = 8;
const OUTPUT_PATTERN = /^ingredients-\d{2}\.jpg$/;

/** 换了它整批图就全变，所以写死。想要另一批图请改 --seed 并在 README 记一笔。 */
const BASE_SEED = 20260904;

/**
 * 噪声幅度（0~255 的绝对值，均匀分布 ±LUMA_NOISE）。
 *
 * 这是唯一需要调的旋钮：JPEG 的码率几乎全被高频噪声吃掉，色块本身几乎不占体积。
 * 默认 18（亮度标准差约 10.4）对应 q82 下约 290KB，正落在真实食材照片的量级里；
 * 在这个区间附近，幅度每 ±4 大约对应 ±45KB。
 * 太小 → 文件比真实照片小一个量级，上传耗时失真；太大 → 变成电视雪花，体积失控。
 */
const LUMA_NOISE = 18;
/** 色度噪声要小得多：JPEG 的 4:2:0 会把它下采样掉，给太多只是浪费码率。 */
const CHROMA_NOISE = 8;

/** 真实食材照片压到 1280/q82 后的典型区间，合成图要落在同一量级。 */
const TARGET_MIN_BYTES = 200 * 1024;
const TARGET_MAX_BYTES = 400 * 1024;

const DATA_URL_PREFIX_BYTES = 'data:image/jpeg;base64,'.length;

/** 偏食材的配色，纯粹为了看着不像电视雪花；对体积和 token 数没有影响。 */
const PALETTE = [
  [ 92, 128,  62], [154, 178,  84], [ 58,  92,  48],
  [186,  64,  52], [214, 132,  48], [232, 198,  96],
  [206, 196, 176], [148, 106,  72], [ 96,  74,  58],
  [232, 226, 214], [166,  86,  92], [ 74, 110, 122],
];

/** mulberry32：短、快、确定性好。这里不需要密码学强度，只需要可复现。 */
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

/**
 * 生成一张 RGB raw 像素图：底层是色块网格，上面盖几个圆斑，最后整幅叠噪声。
 * 色块和圆斑只提供低频结构（几乎不占码率），体积基本由噪声决定。
 */
function renderRaw({ width, height, seed, lumaNoise, chromaNoise }) {
  const layout = makeRng(seed);

  const cols = 3 + Math.floor(layout() * 4);
  const rows = 3 + Math.floor(layout() * 3);
  const cellWidth = width / cols;
  const cellHeight = height / rows;

  const cellR = new Uint8Array(cols * rows);
  const cellG = new Uint8Array(cols * rows);
  const cellB = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const base = PALETTE[Math.floor(layout() * PALETTE.length)];
    const shift = Math.floor(layout() * 40) - 20;
    cellR[i] = clampByte(base[0] + shift);
    cellG[i] = clampByte(base[1] + shift);
    cellB[i] = clampByte(base[2] + shift);
  }

  const blobCount = 6 + Math.floor(layout() * 4);
  const blobX = new Float64Array(blobCount);
  const blobY = new Float64Array(blobCount);
  const blobR2 = new Float64Array(blobCount);
  const blobR = new Uint8Array(blobCount);
  const blobG = new Uint8Array(blobCount);
  const blobB = new Uint8Array(blobCount);
  for (let i = 0; i < blobCount; i += 1) {
    blobX[i] = layout() * width;
    blobY[i] = layout() * height;
    const radius = (0.06 + layout() * 0.16) * Math.min(width, height);
    blobR2[i] = radius * radius;
    const base = PALETTE[Math.floor(layout() * PALETTE.length)];
    blobR[i] = base[0];
    blobG[i] = base[1];
    blobB[i] = base[2];
  }

  // 噪声用独立的流，改布局参数时噪声序列不跟着漂。
  const noise = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const data = Buffer.allocUnsafe(width * height * 3);

  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor(y / cellHeight));
    for (let x = 0; x < width; x += 1) {
      const col = Math.min(cols - 1, Math.floor(x / cellWidth));
      const cell = row * cols + col;
      let r = cellR[cell];
      let g = cellG[cell];
      let b = cellB[cell];

      for (let i = 0; i < blobCount; i += 1) {
        const dx = x - blobX[i];
        const dy = y - blobY[i];
        if (dx * dx + dy * dy <= blobR2[i]) {
          r = blobR[i];
          g = blobG[i];
          b = blobB[i];
        }
      }

      // 三通道同增同减 = 纯亮度扰动，走 JPEG 的 Y 通道（不被 4:2:0 下采样，码率也主要花在这）。
      const luma = (noise() * 2 - 1) * lumaNoise;
      // R 加 B 减 = 一个廉价的色度扰动，让画面不至于是灰噪点。
      const chroma = (noise() * 2 - 1) * chromaNoise;

      data[offset] = clampByte(r + luma + chroma);
      data[offset + 1] = clampByte(g + luma);
      data[offset + 2] = clampByte(b + luma - chroma);
      offset += 3;
    }
  }

  return data;
}

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default;
  } catch (error) {
    const code = error && error.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      console.error([
        '',
        '找不到 sharp。这个脚本只在本地跑一次，用它把合成像素编成跟生产同规格的 JPEG。',
        '',
        '安装（只装到开发依赖，不进 CI 运行时）：',
        '',
        '    npm i -D sharp',
        '',
      ].join('\n'));
    } else {
      console.error([
        '',
        `sharp 装上了但加载失败：${error && error.message ? error.message : error}`,
        '',
        '常见原因是平台二进制不匹配（换过 Node 版本、跨系统拷过 node_modules）。试试：',
        '',
        '    npm rebuild sharp',
        '    # 还不行就删掉 node_modules 重装：rm -rf node_modules && npm i',
        '',
      ].join('\n'));
    }
    process.exit(1);
    return null;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[token.slice(2)] = next;
      i += 1;
    } else {
      args[token.slice(2)] = 'true';
    }
  }
  return args;
}

function toPositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function toNonNegativeInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function estimateArkImageTokens(width, height) {
  return Math.ceil((width * height) / 1764);
}

function estimateQwenImageTokens(width, height) {
  return Math.ceil(height / 28) * Math.ceil(width / 28);
}

function base64Bytes(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = code >= 0x1100 && (
      code <= 0x115f
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text, width, align) {
  const gap = width - displayWidth(text);
  const fill = gap > 0 ? ' '.repeat(gap) : '';
  return align === 'right' ? fill + text : text + fill;
}

function printTable(headers, aligns, rows) {
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(row[index])),
  ));
  console.log(headers.map((header, i) => pad(header, widths[i], aligns[i])).join('  '));
  console.log(widths.map((width) => '─'.repeat(width)).join('──'));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i], aligns[i])).join('  '));
  }
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, args.out || 'fixtures');
  const count = toPositiveInt(args.count, OUTPUT_COUNT);
  const width = toPositiveInt(args.width, WIDTH);
  const height = toPositiveInt(args.height, HEIGHT);
  const quality = toPositiveInt(args.quality, JPEG_QUALITY);
  const seed = toPositiveInt(args.seed, BASE_SEED);
  const lumaNoise = toNonNegativeInt(args.noise, LUMA_NOISE);
  const chromaNoise = toNonNegativeInt(args.chroma, CHROMA_NOISE);
  const force = args.force === 'true';

  if (Math.max(width, height) !== WIDTH || quality !== JPEG_QUALITY) {
    console.warn(`⚠ 你改了规格（${width}×${height} / quality ${quality}），这批图片将不再等价于生产环境，`);
    console.warn('  跟按默认规格采到的历史数据不可比。确认这是你想要的再继续。\n');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const existing = fs.readdirSync(outDir).filter((name) => OUTPUT_PATTERN.test(name));
  if (existing.length > 0 && !force) {
    // 这些很可能是用户辛苦挑出来的真实照片，覆盖掉就得重新跑 prepare-fixtures。
    console.error([
      '',
      `${rel(outDir)}/ 里已经有 ${existing.length} 张 ingredients-*.jpg 了。`,
      '',
      '如果那是 prepare-fixtures 生成的真实照片，合成图会把它们盖掉，而且真实照片的数据更有价值。',
      '确认要覆盖就加 --force 重跑：',
      '',
      '    node tools/make-synthetic-fixtures.mjs --force',
      '',
    ].join('\n'));
    process.exit(1);
  }
  for (const name of existing) {
    fs.unlinkSync(path.join(outDir, name));
  }

  const sharp = await loadSharp();
  const rows = [];
  const records = [];

  for (let index = 0; index < count; index += 1) {
    const outName = `ingredients-${String(index + 1).padStart(2, '0')}.jpg`;
    const raw = renderRaw({ width, height, seed: seed + index * 1013, lumaNoise, chromaNoise });
    const { data, info } = await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: false })
      .toBuffer({ resolveWithObject: true });

    fs.writeFileSync(path.join(outDir, outName), data);

    records.push({ outName, width: info.width, height: info.height, bytes: data.length });
    rows.push([
      outName,
      `${info.width}×${info.height}`,
      String(data.length),
      formatKb(data.length),
      String(base64Bytes(data.length)),
      String(estimateArkImageTokens(info.width, info.height)),
      String(estimateQwenImageTokens(info.width, info.height)),
    ]);
  }

  console.log(`已生成 ${records.length} 张合成图（${width}×${height} / JPEG q${quality} / seed ${seed} / noise ${lumaNoise}）→ ${rel(outDir)}/\n`);
  printTable(
    ['输出文件', '像素', '字节', 'KB', 'base64 字节', '火山 token', 'Qwen token'],
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    rows,
  );

  const sizes = records.map((record) => record.bytes);
  const meanBytes = sizes.reduce((sum, value) => sum + value, 0) / sizes.length;
  const minBytes = Math.min(...sizes);
  const maxBytes = Math.max(...sizes);
  console.log('');
  console.log(`体积：平均 ${formatKb(meanBytes)} KB，区间 ${formatKb(minBytes)} ~ ${formatKb(maxBytes)} KB；`
    + `目标 ${formatKb(TARGET_MIN_BYTES)} ~ ${formatKb(TARGET_MAX_BYTES)} KB。`);
  console.log(`base64 后平均 ${formatKb(base64Bytes(Math.round(meanBytes)))} KB，`
    + `另加 ${DATA_URL_PREFIX_BYTES} 字节的 data URL 前缀。`);
  console.log('token 两列都是按官方公式估的；真实值以每条样本回读的 prompt_tokens 为准。');

  // 体积对噪声幅度是对数关系（实测 10~36 区间拟合：体积 ≈ 常数 + 224KB × ln(幅度)），
  // 所以修正量要用乘的。线性外推会严重过冲。
  const BYTES_PER_LN_NOISE = 224 * 1024;
  const targetMid = (TARGET_MIN_BYTES + TARGET_MAX_BYTES) / 2;
  if (meanBytes < TARGET_MIN_BYTES || meanBytes > TARGET_MAX_BYTES) {
    const factor = Math.exp((targetMid - meanBytes) / BYTES_PER_LN_NOISE);
    const suggested = Math.min(120, Math.max(2, Math.round(lumaNoise * factor)));
    console.log('');
    console.log(meanBytes < TARGET_MIN_BYTES
      ? '⚠ 偏小：比真实食材照片轻，t_req_body_ms 会偏乐观。调一下噪声幅度再跑一次：'
      : '⚠ 偏大：会把上传耗时拉高到真实照片之上。调一下噪声幅度再跑一次：');
    console.log(`    node tools/make-synthetic-fixtures.mjs --force --noise ${suggested}`);
  }

  console.log([
    '',
    '记住这批是合成图：',
    '  · 模型认不出食材，会返回空的 ingredients 数组，输出 token 数明显少于真实照片。',
    '  · 因此 t_e2e_ms / tpot_ms / output_tps / cost_total 都偏低，不能跟真实照片的数据混着比。',
    '  · 可信的只有上传与 prefill 那一段：request_body_bytes、t_req_body_ms、t_ttfb_ms。',
    '  · 正式长测前请换成真实照片：把照片放进 fixtures/raw/ 后跑 node tools/prepare-fixtures.mjs',
    '',
  ].join('\n'));
}

main().catch((error) => {
  console.error(`\n执行失败：${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
