#!/usr/bin/env node
/**
 * 把 fixtures/raw/ 里的任意照片批量转成压测用的标准规格图片。
 *
 * 规格必须跟生产环境（大厨秘诀 image-compressor.js）完全一致：
 * 长边 1280px、JPEG quality 0.82、只缩不放、按 EXIF 方向摆正、去掉元数据。
 * 规格一旦不同，测出的 request_body_bytes、t_req_body_ms 和 image token 数
 * 就跟线上不可比，这批数据也就失去了「代表生产」的意义。
 *
 * 这是本地一次性脚本：sharp 只是 devDependency，CI 运行时不装、也不会跑这个文件。
 * 产物 fixtures/ingredients-NN.jpg 要 commit 进仓库，采样时由 src/payloads.js 直接读。
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

/** 与 image-compressor.js 的 DEFAULTS 一一对应，改这里等于改测量口径。 */
const MAX_LONG_EDGE = 1280;
const JPEG_QUALITY = 82;

const OUTPUT_COUNT = 8;
const OUTPUT_PATTERN = /^ingredients-\d{2}\.jpg$/;

const SOURCE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.gif', '.bmp',
]);

/**
 * 真实食材照片压到 1280/q82 之后的合理体积区间。
 * 太小说明画面过于干净（跟生产的杂乱冰箱照不像，上传耗时偏乐观），
 * 太大说明画面过碎（会把 t_req_body_ms 拉高，同样不具代表性）。
 */
const SANE_MIN_BYTES = 80 * 1024;
const SANE_MAX_BYTES = 700 * 1024;

/** data URL 前缀 `data:image/jpeg;base64,` 的固定长度，用来还原真实请求体大小。 */
const DATA_URL_PREFIX_BYTES = 'data:image/jpeg;base64,'.length;

/** 火山方舟文档给的估算式：图片 token ≈ 宽 × 高 ÷ 1764（1764 = 42²）。 */
function estimateArkImageTokens(width, height) {
  return Math.ceil((width * height) / 1764);
}

/** 硅基 Qwen-VL 文档给的估算式：宽高各自向上取到 28 的整数倍后，token ≈ (h/28) × (w/28)。 */
function estimateQwenImageTokens(width, height) {
  return Math.ceil(height / 28) * Math.ceil(width / 28);
}

function base64Bytes(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * sharp 是 devDependency，用户很可能没装。
 * 这里只给中文提示和安装命令，不把原始堆栈甩出去。
 */
async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default;
  } catch (error) {
    const code = error && error.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      console.error([
        '',
        '找不到 sharp。这个脚本只在本地跑一次，用它把照片压到跟生产一致的规格。',
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

/** sharp 0.32 之前不认 failOn，加个退路免得老版本直接崩。 */
function openImage(sharp, filePath) {
  try {
    // 手机照片常带无害的 JPEG warning，默认的 failOn:'warning' 会把它们判死。
    return sharp(filePath, { failOn: 'error' });
  } catch (error) {
    return sharp(filePath);
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

/** 中日韩字符在终端占两列，不算进去表格就会歪。 */
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

function truncate(text, max) {
  const source = String(text);
  if (displayWidth(source) <= max) return source;
  let out = '';
  let width = 0;
  for (const ch of source) {
    const chWidth = displayWidth(ch);
    if (width + chWidth > max - 1) break;
    out += ch;
    width += chWidth;
  }
  return `${out}…`;
}

function printTable(headers, aligns, rows) {
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(row[index])),
  ));
  const line = widths.map((width) => '─'.repeat(width)).join('──');
  console.log(headers.map((header, i) => pad(header, widths[i], aligns[i])).join('  '));
  console.log(line);
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i], aligns[i])).join('  '));
  }
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}`;
}

function listSourceFiles(rawDir) {
  return fs.readdirSync(rawDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** 只删自己生成的 ingredients-NN.jpg。留着旧文件会让轮换用到上一批素材，静默污染数据。 */
function cleanOutputs(outDir) {
  const stale = fs.readdirSync(outDir).filter((name) => OUTPUT_PATTERN.test(name));
  for (const name of stale) {
    fs.unlinkSync(path.join(outDir, name));
  }
  return stale;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDir = path.resolve(ROOT, args.raw || 'fixtures/raw');
  const outDir = path.resolve(ROOT, args.out || 'fixtures');
  const wanted = toPositiveInt(args.count, OUTPUT_COUNT);
  const quality = toPositiveInt(args.quality, JPEG_QUALITY);
  const maxEdge = toPositiveInt(args['max-edge'], MAX_LONG_EDGE);

  if (quality !== JPEG_QUALITY || maxEdge !== MAX_LONG_EDGE) {
    console.warn(`⚠ 你改了规格（长边 ${maxEdge}px / quality ${quality}），这批图片将不再等价于生产环境，`);
    console.warn('  跟按默认规格采到的历史数据不可比。确认这是你想要的再继续。\n');
  }

  if (!fs.existsSync(rawDir)) {
    fs.mkdirSync(rawDir, { recursive: true });
    console.error([
      '',
      `已创建 ${rel(rawDir)}/，但里面还没有照片。`,
      '',
      '把 8 张左右的食材照片丢进去再跑一次。原图不会进仓库（.gitignore 里已忽略）。',
      '手头没有照片就先跑兜底方案：node tools/make-synthetic-fixtures.mjs',
      '',
    ].join('\n'));
    process.exit(1);
  }

  const sources = listSourceFiles(rawDir);
  if (sources.length === 0) {
    console.error([
      '',
      `${rel(rawDir)}/ 里没有可用图片（支持 ${[...SOURCE_EXTS].join(' ')}）。`,
      '',
      '放几张进去再跑一次，或者先用合成图跑通链路：',
      '    node tools/make-synthetic-fixtures.mjs',
      '',
    ].join('\n'));
    process.exit(1);
  }

  const sharp = await loadSharp();

  fs.mkdirSync(outDir, { recursive: true });
  const removed = cleanOutputs(outDir);
  if (removed.length > 0) {
    console.log(`已清掉上一批产物 ${removed.length} 个（${removed[0]} …），避免轮换里混进旧素材。\n`);
  }

  const rows = [];
  const records = [];
  const failures = [];

  // 编号按「成功的第几张」而不是「源文件的第几个」：中间有照片处理失败时，
  // 产物必须仍然是连续的 ingredients-01..NN，否则一眼看去像是跑坏了。
  // 也因此要遍历全部源文件而不是只取前 N 个——失败一张就顺延用下一张补上。
  for (const sourceName of sources) {
    if (records.length >= wanted) break;
    const outName = `ingredients-${String(records.length + 1).padStart(2, '0')}.jpg`;
    const sourcePath = path.join(rawDir, sourceName);

    try {
      const sourceMeta = await openImage(sharp, sourcePath).metadata();
      const { data, info } = await openImage(sharp, sourcePath)
        // 无参 rotate() = 按 EXIF orientation 摆正，跟生产的 imageOrientation:'from-image' 一致。
        .rotate()
        // PNG/WebP 可能带 alpha，JPEG 没有 alpha 通道；不显式垫底会合成到黑色上。
        .flatten({ background: '#ffffff' })
        // fit:'inside' + withoutEnlargement 等价于生产的 scale = min(1, 1280 / 长边)。
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        // sharp 默认不带出任何元数据（没调 withMetadata），EXIF / GPS 就此丢掉。
        .jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: false })
        .toBuffer({ resolveWithObject: true });

      fs.writeFileSync(path.join(outDir, outName), data);

      const record = {
        outName,
        sourceName,
        width: info.width,
        height: info.height,
        bytes: data.length,
        b64: base64Bytes(data.length),
        sourceLongEdge: Math.max(sourceMeta.width || 0, sourceMeta.height || 0),
      };
      records.push(record);
      rows.push([
        record.outName,
        truncate(record.sourceName, 24),
        `${record.width}×${record.height}`,
        String(record.bytes),
        formatKb(record.bytes),
        String(record.b64),
        String(estimateArkImageTokens(record.width, record.height)),
        String(estimateQwenImageTokens(record.width, record.height)),
      ]);
    } catch (error) {
      failures.push({ sourceName, message: error && error.message ? error.message : String(error) });
    }
  }

  if (records.length === 0) {
    console.error('\n一张都没处理成功。上面的报错通常是文件损坏或 sharp 不支持该格式（如未编译 libheif 的 HEIC）。\n');
    for (const failure of failures) console.error(`  ${failure.sourceName}：${failure.message}`);
    process.exit(1);
  }

  console.log(`已生成 ${records.length} 张（长边 ${maxEdge}px / JPEG q${quality} / 已去元数据）→ ${rel(outDir)}/\n`);
  printTable(
    ['输出文件', '来源', '像素', '字节', 'KB', 'base64 字节', '火山 token', 'Qwen token'],
    ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
    rows,
  );

  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const meanBytes = totalBytes / records.length;
  console.log('');
  console.log(`平均 ${formatKb(meanBytes)} KB，base64 后平均 ${formatKb(base64Bytes(Math.round(meanBytes)))} KB。`);
  console.log(`实际请求体里还要再加 ${DATA_URL_PREFIX_BYTES} 字节的 data URL 前缀，以及提示词本身。`);
  console.log('token 两列都是按官方公式估的；真实值以每条样本回读的 prompt_tokens 为准。');

  const warnings = [];
  if (failures.length > 0) {
    warnings.push(`${failures.length} 张处理失败：${failures.map((f) => f.sourceName).join('、')}`);
  }
  if (records.length < OUTPUT_COUNT) {
    warnings.push(`只有 ${records.length} 张，少于建议的 ${OUTPUT_COUNT} 张。轮换池太小，破图片缓存的效果会打折。`);
  }
  for (const record of records) {
    if (record.bytes < SANE_MIN_BYTES) {
      warnings.push(`${record.outName} 只有 ${formatKb(record.bytes)} KB，画面可能过于干净，测出的上传耗时会偏乐观。`);
    } else if (record.bytes > SANE_MAX_BYTES) {
      warnings.push(`${record.outName} 有 ${formatKb(record.bytes)} KB，比典型生产照片大不少，会把 t_req_body_ms 拉高。`);
    }
    if (record.sourceLongEdge > 0 && record.sourceLongEdge < maxEdge) {
      warnings.push(`${record.outName} 的原图长边只有 ${record.sourceLongEdge}px，没触发缩放，比生产规格小。`);
    }
  }
  const ratios = records.map((record) => record.width / record.height);
  const ratioSpread = Math.max(...ratios) / Math.min(...ratios);
  if (ratioSpread > 1.3) {
    warnings.push('这批图片长宽比差异较大，各轮的 image token 数会跟着跳；横竖构图尽量统一，好让不同轮次的 prompt_tokens 可比。');
  }

  if (warnings.length > 0) {
    console.log('\n提醒：');
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  }

  console.log([
    '',
    '下一步：',
    `  1. 逐张打开 ${rel(outDir)}/ingredients-*.jpg 亲眼确认没有人脸、住址、快递单、含真实姓名电话的小票。`,
    '     这个仓库是公开的，commit 上去就撤不回来了。',
    '  2. git add fixtures/ingredients-*.jpg && git commit',
    `  3. 原图留在 ${rel(rawDir)}/，已被 .gitignore 忽略，不会进仓库。`,
    '',
  ].join('\n'));
}

main().catch((error) => {
  console.error(`\n执行失败：${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
