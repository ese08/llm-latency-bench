'use strict';

/**
 * 静态 HTML 报表生成器。零依赖，输出单文件（内联 CSS + 内联 SVG）。
 *
 * 用法：node src/report.js [--out report.html] [--results results] [--since YYYY-MM-DD]
 *
 * 全篇的统计口径写在页脚「方法学」里，任何一个数字都应该能在那里找到解释。
 * 三条硬规则：
 *   - 分位数一律「最近秩」法，样本量不到 MIN_N_P95 时不报 P95（阈值只写常量，不要在文案里抄数字）。
 *   - null 是「没测到」，任何聚合都跳过它，绝不当 0 参与平均。
 *   - 主延迟指标一律用 t_ttft_net_ms（不含握手）；只有第 6 节要看握手本身，才用 t_ttft_ms。
 */

const fs = require('node:fs');
const path = require('node:path');

const { ERROR_CLASS, TASK, CONN_MODE, isCleanSample, isClockSuspect } = require('./lib/schema');
const { CONFIGS, getConfig, PRICE_SNAPSHOT_DATE } = require('./config');

const TZ = 'Asia/Shanghai';
const HOURS = Array.from({ length: 24 }, (_, i) => i);
/**
 * P95 的最小样本量。
 *
 * 用最近秩法时，只要 ceil(0.95n) === n，「P95」算出来就是最大值本身——
 * n < 20 时恒成立，报出来的数字看着像分位数，其实是单个离群点。
 * 20 是让 ceil(0.95n) 第一次小于 n 的最小整数，所以门槛定在这里。
 *
 * 按当前采样计划（每 15 分钟 × 3 次重复），一个「配置 × 小时」格子跑满一天就有 12 个样本，
 * 两天 24 个即可过线；一周的数据每格约 84 个，充裕。
 */
const MIN_N_P95 = 20;
const MIN_N_CELL = 5;
const MAX_SCATTER_POINTS = 4000;

/** 线条与色块用的调色板。刻意选中等明度，浅色底和深色底上都能看见。 */
const PALETTE = [
  '#3572b0', '#d1622b', '#2e9e63', '#b3489e',
  '#a8862a', '#2f9ea3', '#c0453f', '#7a5cc4',
];

const LATENCY_TASKS = [TASK.IMAGE, TASK.TEXT];

/**
 * 第 1、2、3、4、5、7 节共用的口径说明（第 4 节另有自己的减法说明）。
 *
 * 这几节的主延迟指标全部是 t_ttft_net_ms，不是 t_ttft_ms：冷热连接的 TTFT 相差整整一次
 * TLS 握手，含握手的样本混在同一个分位数池里，P50 正好落在双峰的分界点上，
 * 那个数字既不代表冷连接也不代表热连接。剥掉握手之后冷热本来就可比，双峰消失。
 */
const NET_TTFT_NOTE = '本节的 TTFT 用的是不含握手的口径 t_ttft_net_ms（请求体写完 → 首个正文 token），'
  + 'DNS/TCP/TLS 已经扣掉。冷连接和热连接的 TTFT 差的就是一次握手，含握手的数字混在一个池子里算分位数，'
  + 'P50 会落在双峰的分界点上，既不代表冷也不代表热。握手本身值多少毫秒，请看第 6 节——'
  + '那一节刻意保留含握手的 t_ttft_ms，是全篇唯一口径不同的地方。';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupSeparated(intText) {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtInt(value) {
  if (!isNum(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + groupSeparated(String(Math.abs(rounded)));
}

function fmtNum(value, digits) {
  if (!isNum(value)) return '—';
  const fixed = value.toFixed(digits);
  const [head, tail] = fixed.split('.');
  const sign = head.startsWith('-') ? '-' : '';
  const body = groupSeparated(head.replace('-', ''));
  return sign + body + (tail ? '.' + tail : '');
}

function fmtSignedInt(value) {
  if (!isNum(value)) return '—';
  const text = fmtInt(Math.abs(value));
  if (Math.round(value) === 0) return '0';
  return (value > 0 ? '+' : '-') + text;
}

function fmtPct(ratio, digits) {
  if (!isNum(ratio)) return '—';
  return fmtNum(ratio * 100, digits === undefined ? 1 : digits) + '%';
}

/** 成本数字跨度很大（单次 0.00002 到总计几十），按量级换精度。 */
function fmtCost(value) {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1) return fmtNum(value, 2);
  if (abs >= 0.01) return fmtNum(value, 4);
  return value.toExponential(2);
}

function fmtBytes(value) {
  if (!isNum(value)) return '—';
  if (value >= 1024 * 1024) return fmtNum(value / (1024 * 1024), 2) + ' MiB';
  if (value >= 1024) return fmtNum(value / 1024, 1) + ' KiB';
  return fmtInt(value) + ' B';
}

/** 最近秩分位数：sorted[ceil(p/100*n)-1]。空数组返回 null。 */
function percentile(values, p) {
  const nums = values.filter(isNum).slice().sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const rank = Math.ceil((p / 100) * nums.length);
  const index = Math.min(Math.max(rank, 1), nums.length) - 1;
  return nums[index];
}

function median(values) {
  return percentile(values, 50);
}

/** 样本太少时 P95 只是「最大值的别名」，不报比乱报强。 */
function p95(values) {
  const nums = values.filter(isNum);
  if (nums.length < MIN_N_P95) return null;
  return percentile(nums, 95);
}

function maxOf(values) {
  const nums = values.filter(isNum);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => (b > a ? b : a), nums[0]);
}

function sumOf(values) {
  const nums = values.filter(isNum);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

function collect(rows, field) {
  const out = [];
  for (const row of rows) {
    const value = row.s[field];
    if (isNum(value)) out.push(value);
  }
  return out;
}

function uniqueValues(rows, field) {
  const seen = new Map();
  for (const row of rows) {
    const value = row.s[field];
    if (value === null || value === undefined || value === '') continue;
    const key = String(value);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return Array.from(seen.entries()).map(([value, count]) => ({ value, count }));
}

// ---------------------------------------------------------------------------
// 时区：ts_wall_utc 是 UTC，用户关心的是国内工作时段，所以一律换算到 Asia/Shanghai。
// 用 Intl 做换算而不是手写 +8 偏移，避免以后换时区时踩夏令时的坑。
// ---------------------------------------------------------------------------

const SHANGHAI_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function shanghaiParts(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return null;
  const parts = SHANGHAI_FMT.formatToParts(date);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : null;
  };
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  let hour = Number(pick('hour'));
  // 某些 ICU 版本会把午夜格式化成 24 时。
  if (hour === 24) hour = 0;
  if (!year || !month || !day || !Number.isFinite(hour)) return null;
  return { date: `${year}-${month}-${day}`, hour, ts };
}

function shanghaiHour(iso) {
  const parts = shanghaiParts(iso);
  return parts ? parts.hour : null;
}

// ---------------------------------------------------------------------------
// 读取数据
// ---------------------------------------------------------------------------

function findJsonlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out.sort();
}

function loadSamples(files, since) {
  const samples = [];
  let badLines = 0;
  let skippedBySince = 0;
  const contributing = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      badLines += 1;
      continue;
    }
    let kept = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        badLines += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        badLines += 1;
        continue;
      }
      if (since && typeof parsed.ts_wall_utc === 'string' && parsed.ts_wall_utc.slice(0, 10) < since) {
        skippedBySince += 1;
        continue;
      }
      samples.push(parsed);
      kept += 1;
    }
    if (kept > 0) contributing.push({ file, count: kept });
  }

  return { samples, badLines, skippedBySince, contributing };
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/**
 * 放宽版可用性判定。
 *
 * isCleanSample 会把 degraded 和 reasoning_tokens!==0 的样本剔掉，这对主统计是对的，
 * 但有两处必须用更宽的口径，否则整块数据为空：
 *   - control_empty 对照组多半拿不到 usage（reasoning_tokens 是 null 而不是 0）；
 *   - 火山降级专项恰恰要看 degraded=true 的那批样本有多慢。
 * 用到这个口径的地方都在页面上写明了。
 */
function isTimingUsable(sample) {
  return sample.ok === true
    && sample.is_retry !== true
    && !isClockSuspect(sample);
}

/**
 * 把一个 burst（同一时刻的 N 次重复）压成一个中位数。
 *
 * 同一 burst 内的重复只隔 3 秒，样本之间高度相关，直接汇在一起算分位数会高估有效样本量。
 * 主统计仍按「每次请求」算（要看的就是请求级的尾部），这里的 burst 中位数只作交叉验证列。
 */
function burstMedians(rows, field) {
  const groups = new Map();
  let solo = 0;
  for (const row of rows) {
    const key = row.s.burst_id || `__solo_${solo++}`;
    if (!groups.has(key)) groups.set(key, []);
    const value = row.s[field];
    if (isNum(value)) groups.get(key).push(value);
  }
  const out = [];
  for (const values of groups.values()) {
    const value = percentile(values, 50);
    if (isNum(value)) out.push(value);
  }
  return out;
}

function toRow(sample) {
  const parts = shanghaiParts(sample.ts_wall_utc);
  return {
    s: sample,
    hour: parts ? parts.hour : null,
    date: parts ? parts.date : null,
    ts: parts ? parts.ts : null,
    clean: isCleanSample(sample),
    usable: isTimingUsable(sample),
  };
}

function orderedConfigIds(rows) {
  const present = new Set();
  for (const row of rows) {
    if (typeof row.s.config_id === 'string' && row.s.config_id !== '') present.add(row.s.config_id);
  }
  const known = CONFIGS.map((config) => config.id).filter((id) => present.has(id));
  const unknown = Array.from(present).filter((id) => !known.includes(id)).sort();
  return known.concat(unknown);
}

function configLabel(configId) {
  const config = getConfig(configId);
  return config ? config.label : configId;
}

function configPlatform(configId, rows) {
  const config = getConfig(configId);
  if (config) return config.platform;
  const first = rows.find((row) => row.s.config_id === configId && row.s.platform);
  return first ? first.s.platform : null;
}

function isUnverifiedPricing(configId) {
  const config = getConfig(configId);
  return Boolean(config && config.pricing && config.pricing.confidence === 'unverified');
}

function aggregate(samples) {
  const rows = samples.map(toRow);
  const configIds = orderedConfigIds(rows);

  const byConfig = new Map();
  for (const id of configIds) byConfig.set(id, []);
  const orphanRows = [];
  for (const row of rows) {
    const bucket = byConfig.get(row.s.config_id);
    if (bucket) bucket.push(row);
    else orphanRows.push(row);
  }

  const clean = rows.filter((row) => row.clean);
  const usable = rows.filter((row) => row.usable);

  // 排除原因逐条对应 isCleanSample 的每个子句；一条样本可能同时命中多条。
  const reasons = {
    failed: rows.filter((row) => row.s.ok !== true).length,
    retry: rows.filter((row) => row.s.is_retry === true).length,
    cache: rows.filter((row) => row.s.cache_contaminated !== false).length,
    degraded: rows.filter((row) => row.s.degraded === true).length,
    reasoning: rows.filter((row) => row.s.reasoning_tokens !== 0).length,
    clock: rows.filter((row) => isClockSuspect(row.s)).length,
  };

  const nodeMap = new Map();
  for (const row of rows) {
    const key = [row.s.node_label, row.s.egress_ip, row.s.egress_geo, row.s.runner_os].join(' ');
    const existing = nodeMap.get(key);
    if (existing) existing.count += 1;
    else {
      nodeMap.set(key, {
        node_label: row.s.node_label,
        egress_ip: row.s.egress_ip,
        egress_geo: row.s.egress_geo,
        runner_os: row.s.runner_os,
        count: 1,
      });
    }
  }
  const nodes = Array.from(nodeMap.values()).sort((a, b) => b.count - a.count);

  const promptPacks = uniqueValues(rows, 'prompt_pack').sort((a, b) => b.count - a.count);
  const promptHashes = uniqueValues(rows, 'prompt_hash').sort((a, b) => b.count - a.count);

  const consistency = configIds.map((id) => {
    const configRows = byConfig.get(id) || [];
    return {
      configId: id,
      models: uniqueValues(configRows, 'model_returned'),
      requested: uniqueValues(configRows, 'model_requested'),
      httpVersions: uniqueValues(configRows, 'http_version'),
      tlsVersions: uniqueValues(configRows, 'tls_version'),
      providers: uniqueValues(configRows, 'provider_selected'),
      priceDates: uniqueValues(configRows, 'price_snapshot_date'),
      packs: uniqueValues(configRows, 'prompt_pack'),
    };
  });

  const dated = rows.filter((row) => isNum(row.ts));
  const tsList = dated.map((row) => row.ts).sort((a, b) => a - b);

  return {
    rows,
    clean,
    usable,
    configIds,
    byConfig,
    orphanRows,
    reasons,
    nodes,
    promptPacks,
    promptHashes,
    consistency,
    total: rows.length,
    okCount: rows.filter((row) => row.s.ok === true).length,
    truncated: rows.filter((row) => row.s.finish_reason === 'length').length,
    repeatCount: rows.filter((row) => isNum(row.s.attempt_index) && row.s.attempt_index > 0).length,
    burstCount: new Set(rows.map((row) => row.s.burst_id).filter(Boolean)).size,
    undatedCount: rows.length - dated.length,
    tsMin: tsList.length ? tsList[0] : null,
    tsMax: tsList.length ? tsList[tsList.length - 1] : null,
  };
}

function filterRows(rows, predicate) {
  return rows.filter((row) => predicate(row.s, row));
}

function latencyRows(agg, configId) {
  return (agg.byConfig.get(configId) || []).filter(
    (row) => row.clean && LATENCY_TASKS.includes(row.s.task),
  );
}

/** 把一组样本按小时铺成 24 格。 */
function hourBuckets(rows, field, minN) {
  const cells = HOURS.map(() => ({ n: 0, values: [] }));
  for (const row of rows) {
    if (row.hour === null) continue;
    const cell = cells[row.hour];
    cell.n += 1;
    const value = row.s[field];
    if (isNum(value)) cell.values.push(value);
  }
  return cells.map((cell) => ({
    n: cell.values.length,
    total: cell.n,
    p50: cell.values.length >= (minN || 1) ? percentile(cell.values, 50) : null,
    p95: p95(cell.values),
  }));
}

// ---------------------------------------------------------------------------
// HTML 构件
// ---------------------------------------------------------------------------

function cell(text, cls) {
  return { html: escapeHtml(text), cls: cls || '' };
}

function rawCell(html, cls) {
  return { html, cls: cls || '' };
}

function numCell(text, cls) {
  return { html: escapeHtml(text), cls: 'num ' + (cls || '') };
}

function renderTable(headers, rows, opts) {
  const options = opts || {};
  if (rows.length === 0) {
    return '<p class="empty">（无数据）</p>';
  }
  const head = headers
    .map((header) => {
      const obj = typeof header === 'string' ? { text: header } : header;
      const title = obj.title ? ` title="${escapeHtml(obj.title)}"` : '';
      const cls = obj.cls ? ` class="${escapeHtml(obj.cls)}"` : '';
      return `<th${cls}${title}>${escapeHtml(obj.text)}</th>`;
    })
    .join('');
  const body = rows
    .map((cells) => {
      const tds = cells
        .map((item, index) => {
          const cls = [item.cls || ''];
          if (index === 0 && options.stickyFirst) cls.push('sticky');
          const clsAttr = cls.join(' ').trim();
          const titleAttr = item.title ? ` title="${escapeHtml(item.title)}"` : '';
          return `<td${clsAttr ? ` class="${clsAttr}"` : ''}${titleAttr}>${item.html}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  const tableCls = options.cls ? ` class="${escapeHtml(options.cls)}"` : '';
  return `<div class="scroll"><table${tableCls}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function section(id, title, intro, body) {
  const introHtml = intro ? `<div class="intro">${intro}</div>` : '';
  return `<section id="${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${introHtml}${body}</section>`;
}

function noteP(text) {
  return `<p class="note">${escapeHtml(text)}</p>`;
}

function banner(level, text) {
  return `<p class="banner ${level}">${escapeHtml(text)}</p>`;
}

/** 单价未核实的配置，成本数字后面挂一个问号，避免被当成决策依据。 */
function costMark(configId) {
  if (!isUnverifiedPricing(configId)) return '';
  return ' <span class="qmark" title="该配置单价为 unverified，成本数字仅供参考">?</span>';
}

// ---------------------------------------------------------------------------
// 热力图
// ---------------------------------------------------------------------------

/**
 * cellsByConfig: Map<configId, Array(24) of { n, value }>
 */
function renderHeatmap(configIds, cellsByConfig, opts) {
  const options = opts || {};
  const minN = options.minN || MIN_N_CELL;
  const values = [];
  for (const id of configIds) {
    const cells = cellsByConfig.get(id) || [];
    for (const item of cells) {
      if (item && item.n >= minN && isNum(item.value)) values.push(item.value);
    }
  }
  if (values.length === 0) {
    return '<p class="empty">（没有任何一格达到最小样本数，无法作图）</p>';
  }
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = max - min;

  const header = ['配置 \\ 上海时'].concat(HOURS.map((h) => String(h)));
  const rows = configIds.map((id) => {
    const cells = cellsByConfig.get(id) || [];
    const line = [cell(id, 'rowhead')];
    for (const hour of HOURS) {
      const item = cells[hour];
      if (!item || item.n === 0) {
        line.push(rawCell('<span class="void">·</span>', 'hm'));
        continue;
      }
      if (item.n < minN || !isNum(item.value)) {
        line.push(rawCell(
          `<span class="sparseLabel">n=${escapeHtml(String(item.n))}</span>`,
          'hm sparse',
        ));
        continue;
      }
      const t = span > 0 ? (item.value - min) / span : 0.5;
      const hot = t > 0.55 ? ' hot' : '';
      const title = `${id} ${hour}:00 上海时 · ${options.unit || ''}${fmtInt(item.value)} · n=${item.n}`;
      line.push({
        html: `<span style="--t:${t.toFixed(3)}" class="hmv${hot}">${escapeHtml(fmtInt(item.value))}</span>`,
        cls: 'hm',
        title,
      });
    }
    return line;
  });

  const legendSteps = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `<span class="swatch" style="--t:${t.toFixed(2)}"></span>`)
    .join('');
  const legend = `<div class="heatlegend"><span class="muted">${escapeHtml(fmtInt(min))}${escapeHtml(options.unit || '')}</span>${legendSteps}<span class="muted">${escapeHtml(fmtInt(max))}${escapeHtml(options.unit || '')}</span>`
    + `<span class="muted legendsep">灰色斜线 = 样本数 &lt; ${minN}；· = 该小时无样本</span></div>`;

  return renderTable(header, rows, { cls: 'heat', stickyFirst: true }) + legend;
}

// ---------------------------------------------------------------------------
// 折线图（内联 SVG）
// ---------------------------------------------------------------------------

function niceTicks(max, count) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const stepNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = stepNorm * mag;
  const ticks = [];
  for (let value = 0; value <= max + step * 0.5; value += step) ticks.push(value);
  if (ticks.length < 2) ticks.push(step);
  return ticks;
}

/**
 * series: [{ label, color, dashed, points: Array(24) of number|null }]
 */
function renderHourLineChart(series, opts) {
  const options = opts || {};
  const width = 900;
  const height = 420;
  const left = 64;
  const right = 16;
  const top = 18;
  const bottom = 40;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const allValues = [];
  for (const item of series) {
    for (const value of item.points) if (isNum(value)) allValues.push(value);
  }
  if (allValues.length === 0) {
    return '<p class="empty">（没有可用于作图的分位数）</p>';
  }
  const dataMax = Math.max.apply(null, allValues);
  const ticks = niceTicks(dataMax, 5);
  const yMax = ticks[ticks.length - 1];

  const xOf = (hour) => left + (plotW * hour) / 23;
  const yOf = (value) => top + plotH - (plotH * value) / yMax;

  const gridLines = ticks
    .map((tick) => {
      const y = yOf(tick).toFixed(1);
      return `<line class="grid" x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}"/>`
        + `<text class="axis" x="${left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtInt(tick))}</text>`;
    })
    .join('');

  const xLabels = HOURS
    .filter((hour) => hour % 2 === 0)
    .map((hour) => {
      const x = xOf(hour).toFixed(1);
      return `<text class="axis" x="${x}" y="${top + plotH + 18}" text-anchor="middle">${hour}</text>`;
    })
    .join('');

  const hourGrid = HOURS
    .map((hour) => {
      const x = xOf(hour).toFixed(1);
      return `<line class="grid faint" x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}"/>`;
    })
    .join('');

  const paths = series
    .map((item) => {
      let d = '';
      let pen = false;
      const dots = [];
      for (const hour of HOURS) {
        const value = item.points[hour];
        if (!isNum(value)) {
          pen = false;
          continue;
        }
        const x = xOf(hour).toFixed(1);
        const y = yOf(Math.min(value, yMax)).toFixed(1);
        d += (pen ? 'L' : 'M') + x + ' ' + y + ' ';
        pen = true;
        dots.push(`<circle cx="${x}" cy="${y}" r="2.3" fill="${escapeHtml(item.color)}"/>`);
      }
      if (d === '') return '';
      const dash = item.dashed ? ' stroke-dasharray="6 4"' : '';
      return `<path d="${d.trim()}" fill="none" stroke="${escapeHtml(item.color)}" stroke-width="${item.dashed ? 1.5 : 2}"${dash} stroke-linejoin="round"/>`
        + dots.join('');
    })
    .join('');

  const title = escapeHtml(options.title || '按小时分位数');
  return `<div class="scroll"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid meet">`
    + `<title>${title}</title>`
    + hourGrid + gridLines
    + `<line class="axisline" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}"/>`
    + `<line class="axisline" x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}"/>`
    + paths
    + xLabels
    + `<text class="axis" x="${left + plotW / 2}" y="${height - 6}" text-anchor="middle">上海时（0–23）</text>`
    + `<text class="axis" x="12" y="${top + plotH / 2}" text-anchor="middle" transform="rotate(-90 12 ${top + plotH / 2})">${escapeHtml(options.yLabel || 'ms')}</text>`
    + '</svg></div>';
}

function renderSeriesLegend(configIds, colorOf) {
  const rows = configIds.map((id) => [
    rawCell(`<span class="sw" style="background:${escapeHtml(colorOf(id))}"></span>`, 'swcell'),
    cell(id),
    cell(configLabel(id)),
    rawCell('<span class="linesample solid"></span> 实线 = P50'),
    rawCell('<span class="linesample dashed"></span> 虚线 = P95'),
  ]);
  return renderTable(['颜色', 'config_id', '说明', 'P50', 'P95'], rows, { cls: 'compact' });
}

// ---------------------------------------------------------------------------
// 失败散点图
// ---------------------------------------------------------------------------

function renderFailureScatter(agg) {
  const failures = agg.rows.filter((row) => row.s.ok !== true && isNum(row.ts));
  if (failures.length === 0) {
    return '<p class="empty">（时间范围内没有失败样本）</p>';
  }
  const configIds = agg.configIds;
  const errorClasses = Array.from(new Set(failures.map((row) => row.s.error_class || 'unknown'))).sort();
  const colorOfError = (name) => PALETTE[errorClasses.indexOf(name) % PALETTE.length];

  const tsMin = agg.tsMin === null ? failures[0].ts : agg.tsMin;
  const tsMaxRaw = agg.tsMax === null ? failures[failures.length - 1].ts : agg.tsMax;
  const tsMax = tsMaxRaw > tsMin ? tsMaxRaw : tsMin + 1;

  const width = 900;
  const left = 170;
  const right = 16;
  const top = 16;
  const laneH = 26;
  const bottom = 34;
  const height = top + laneH * Math.max(configIds.length, 1) + bottom;
  const plotW = width - left - right;

  const xOf = (ts) => left + (plotW * (ts - tsMin)) / (tsMax - tsMin);

  const lanes = configIds
    .map((id, index) => {
      const y = top + laneH * index + laneH / 2;
      return `<text class="axis" x="${left - 10}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeHtml(id)}</text>`
        + `<line class="grid faint" x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}"/>`;
    })
    .join('');

  const shown = failures.slice(0, MAX_SCATTER_POINTS);
  const dots = shown
    .map((row) => {
      const laneIndex = configIds.indexOf(row.s.config_id);
      if (laneIndex < 0) return '';
      const y = top + laneH * laneIndex + laneH / 2;
      const x = xOf(row.ts).toFixed(1);
      const name = row.s.error_class || 'unknown';
      const label = `${row.s.config_id} ${row.s.ts_wall_utc} ${name}`;
      return `<circle cx="${x}" cy="${y.toFixed(1)}" r="3" fill="${escapeHtml(colorOfError(name))}" fill-opacity="0.75"><title>${escapeHtml(label)}</title></circle>`;
    })
    .join('');

  const startLabel = shanghaiParts(new Date(tsMin).toISOString());
  const endLabel = shanghaiParts(new Date(tsMax).toISOString());
  const axisText = `<text class="axis" x="${left}" y="${height - 10}" text-anchor="start">${escapeHtml(startLabel ? startLabel.date + ' ' + startLabel.hour + '时' : '')}</text>`
    + `<text class="axis" x="${left + plotW}" y="${height - 10}" text-anchor="end">${escapeHtml(endLabel ? endLabel.date + ' ' + endLabel.hour + '时' : '')}</text>`;

  const legend = errorClasses
    .map((name) => `<span class="lg"><span class="sw" style="background:${escapeHtml(colorOfError(name))}"></span>${escapeHtml(name)}</span>`)
    .join('');

  const truncated = failures.length > shown.length
    ? noteP(`失败样本共 ${failures.length} 条，图中只画了前 ${shown.length} 条。`)
    : '';

  return `<div class="scroll"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="失败样本时间散点" preserveAspectRatio="xMidYMid meet">`
    + '<title>失败样本时间散点（横轴为采样时刻，上海时）</title>'
    + lanes + dots + axisText
    + '</svg></div>'
    + `<div class="legendrow">${legend}</div>`
    + truncated;
}

// ---------------------------------------------------------------------------
// 各分块
// ---------------------------------------------------------------------------

function sectionCredibility(agg, meta) {
  const warnings = [];

  /**
   * t_ttft_net_ms 缺列告警。
   *
   * 这一列是后加的：在它存在之前采的 JSONL 里根本没有这个字段。
   * 而第 1–5、7 节的延迟指标全部改用了它，缺列的样本会被当 null 跳过——
   * 于是那几张表会安静地大面积空掉，只有页脚能看出口径。必须在最前面明说。
   */
  const missingNet = agg.clean.filter((row) => !isNum(row.s.t_ttft_net_ms)).length;
  const missingNetRatio = agg.clean.length > 0 ? missingNet / agg.clean.length : 0;
  if (missingNet > 0 && missingNetRatio > 0.5) {
    warnings.push(banner('err', `${fmtInt(missingNet)} 条干净样本（占干净样本的 ${fmtPct(missingNetRatio)}）没有 t_ttft_net_ms。`
      + '这批数据是在 t_ttft_net_ms 这一列存在之前采的，而第 1–5、7 节的延迟指标全部依赖它，'
      + '那几张表会大面积为空——空的是「没这一列」，不是「延迟为 0」，更不是「这几家都没数据」。'
      + '先把这批 JSONL 用 schema.js 的 deriveMetrics 重跑一遍补上这一列，或者重新采集，再来看本报表。'
      + '（第 6 节用的是含握手的 t_ttft_ms，不依赖这一列，仍然可读。）'));
  } else if (missingNet > 0) {
    warnings.push(banner('warn', `有 ${fmtInt(missingNet)} 条干净样本（占干净样本的 ${fmtPct(missingNetRatio)}）缺 t_ttft_net_ms，`
      + '多半是这一列存在之前采的老样本。它们不会进第 1–5、7 节的延迟统计：那几节一律用不含握手的 TTFT，'
      + '缺这一列的样本按 null 跳过、不会当 0 参与分位数，所以那几节的有效样本数小于「干净 n」。'
      + '第 6 节用含握手的 t_ttft_ms，不受影响。要把它们捞回来，用 schema.js 的 deriveMetrics 重跑一遍即可。'));
  }

  if (agg.promptPacks.length > 1) {
    warnings.push(banner('err', '这批数据里混入了多套提示词（prompt_pack）：'
      + agg.promptPacks.map((item) => `${item.value}×${item.count}`).join('，')
      + '。不同提示词的 token 数与 prefill 量不同，跨 pack 的延迟数字不可比，必须先按 pack 拆开再看。'));
  }
  if (agg.promptHashes.length > agg.promptPacks.length) {
    warnings.push(banner('warn', `同名 prompt_pack 下出现了 ${agg.promptHashes.length} 个不同的 prompt_hash，说明提示词内容中途改过；同一 pack 内部也未必可比。`));
  }
  for (const item of agg.consistency) {
    if (item.models.length > 1) {
      warnings.push(banner('err', `配置 ${item.configId} 返回过多个 model_returned：`
        + item.models.map((m) => `${m.value}×${m.count}`).join('，')
        + '。平台中途换了模型版本，这段数据不能当同一个模型来比。'));
    }
    if (item.httpVersions.length > 1) {
      warnings.push(banner('warn', `配置 ${item.configId} 混用了多个 HTTP 版本（`
        + item.httpVersions.map((v) => `${v.value}×${v.count}`).join('，')
        + '），h2 与 http/1.1 的握手与多路复用行为不同，混在一起算分位数会得出错误结论。'));
    }
    if (item.priceDates.length > 1) {
      warnings.push(banner('warn', `配置 ${item.configId} 的样本跨了多个 price_snapshot_date（`
        + item.priceDates.map((v) => v.value).join('，')
        + '），成本合计是跨价格版本相加的结果。'));
    }
    if (item.providers.length > 1) {
      warnings.push(banner('warn', `配置 ${item.configId} 命中过多个上游供应商（`
        + item.providers.map((v) => `${v.value}×${v.count}`).join('，')
        + '），OpenRouter 路由发生了漂移。'));
    }
  }
  for (const id of agg.configIds) {
    const retried = (agg.byConfig.get(id) || []).filter((row) => isNum(row.s.or_attempt) && row.s.or_attempt > 1);
    if (retried.length > 0) {
      warnings.push(banner('warn', `配置 ${id} 有 ${retried.length} 条样本的 openrouter_metadata.attempt > 1，`
        + '说明 OpenRouter 内部重试过。这些样本的耗时里含一次失败尝试的时间，不代表单次请求的延迟。'));
    }
  }
  const unverified = agg.configIds.filter(isUnverifiedPricing);
  if (unverified.length > 0) {
    warnings.push(banner('warn', `以下配置的单价是 unverified（官方定价页没查到）：${unverified.join('、')}。`
      + '页面里所有涉及它们的成本数字都带 ? 标记，不要拿去做决策。'));
  }
  if (agg.nodes.length > 1) {
    warnings.push(banner('warn', `数据来自 ${agg.nodes.length} 个不同的观测点/出口 IP。GitHub Actions 的出口不受控，`
      + '换机房会整体平移延迟基线，跨节点比较前先看下面的节点表。'));
  }
  if (agg.undatedCount > 0) {
    warnings.push(banner('warn', `有 ${agg.undatedCount} 条样本的 ts_wall_utc 无法解析，它们不进入任何按小时/按天的统计。`));
  }
  if (agg.orphanRows.length > 0) {
    warnings.push(banner('warn', `有 ${agg.orphanRows.length} 条样本缺少 config_id，已排除在分组统计之外。`));
  }
  if (meta.badLines > 0) {
    warnings.push(banner('warn', `有 ${meta.badLines} 行 JSONL 解析失败，已跳过。`));
  }

  const excluded = agg.total - agg.clean.length;
  const stats = [
    { label: '样本总数', value: fmtInt(agg.total) },
    { label: '干净样本（进分位数）', value: fmtInt(agg.clean.length) },
    { label: '被排除', value: fmtInt(excluded) },
    { label: '成功率（全部样本）', value: agg.total ? fmtPct(agg.okCount / agg.total) : '—' },
    { label: '输出被截断（finish_reason=length）', value: fmtInt(agg.truncated) },
    { label: '观测点数', value: fmtInt(agg.nodes.length) },
  ];
  const statCards = '<div class="cards">'
    + stats.map((item) => `<div class="card"><div class="cardv">${escapeHtml(item.value)}</div><div class="cardk">${escapeHtml(item.label)}</div></div>`).join('')
    + '</div>';

  const reasonRows = [
    ['请求失败（ok≠true）', agg.reasons.failed],
    ['失败后的重试样本（is_retry=true）', agg.reasons.retry],
    ['命中缓存（cache_contaminated 非 false）', agg.reasons.cache],
    ['服务档位降级（degraded=true）', agg.reasons.degraded],
    ['reasoning_tokens 非 0（含未采集到）', agg.reasons.reasoning],
    ['时钟可疑（墙钟与单调钟偏离 >20%）', agg.reasons.clock],
  ].map(([label, count]) => [
    cell(label),
    numCell(fmtInt(count)),
    numCell(agg.total ? fmtPct(count / agg.total) : '—'),
  ]);

  const nodeRows = agg.nodes.map((node) => [
    cell(node.node_label || '（未标注）'),
    cell(node.egress_ip || '—'),
    cell(node.egress_geo || '—'),
    cell(node.runner_os || '—'),
    numCell(fmtInt(node.count)),
    numCell(agg.total ? fmtPct(node.count / agg.total) : '—'),
  ]);

  const packRows = agg.promptPacks.map((item) => [
    cell(item.value),
    numCell(fmtInt(item.count)),
  ]);

  const consistencyRows = agg.consistency.map((item) => {
    const fmtValues = (list) => (list.length === 0 ? '—' : list.map((v) => v.value).join(' / '));
    return [
      cell(item.configId, 'rowhead'),
      cell(fmtValues(item.requested)),
      { html: escapeHtml(fmtValues(item.models)), cls: item.models.length > 1 ? 'bad' : '' },
      { html: escapeHtml(fmtValues(item.httpVersions)), cls: item.httpVersions.length > 1 ? 'warncell' : '' },
      cell(fmtValues(item.tlsVersions)),
      cell(fmtValues(item.providers)),
      cell(fmtValues(item.packs)),
      { html: escapeHtml(fmtValues(item.priceDates)), cls: item.priceDates.length > 1 ? 'warncell' : '' },
    ];
  });

  const body = (warnings.length > 0 ? warnings.join('') : banner('ok', '未发现会让数据不可比的硬问题（提示词、模型版本、协议版本、定价快照都一致）。'))
    + statCards
    + '<h3>排除原因分类</h3>'
    + noteP('一条样本可能同时命中多条原因，所以下表之和会大于「被排除」总数。判定规则完全对应 schema.js 的 isCleanSample()。')
    + renderTable(['原因', '样本数', '占总数'], reasonRows)
    + noteP(`注意：attempt_index>0 的 ${fmtInt(agg.repeatCount)} 条是同一 burst 内的正常重复采样，不是重试，不排除；`
      + `被排除的只有 is_retry=true 的失败重试。全部样本分布在 ${fmtInt(agg.burstCount)} 个 burst 里，`
      + '同一 burst 内的请求只隔几秒、彼此高度相关，所以按请求算出来的分位数，其有效样本量小于 n——'
      + 'P95 的可信度要按 burst 数而不是样本数来估。总览表里另给了一列按 burst 中位数折算的 P50 作交叉验证。')
    + '<h3>观测节点</h3>'
    + noteP('测量节点在美国（GitHub Actions），被测的硅基流动与火山方舟在中国大陆。出口 IP 一变，跨太平洋这条链路的基线就会整体平移。')
    + renderTable(['node_label', 'egress_ip', 'egress_geo', 'runner_os', '样本数', '占比'], nodeRows)
    + '<h3>提示词版本</h3>'
    + renderTable(['prompt_pack', '样本数'], packRows)
    + '<h3>配置一致性</h3>'
    + renderTable(
      ['config_id', 'model_requested', 'model_returned', 'http_version', 'tls_version', 'provider_selected', 'prompt_pack', 'price_snapshot_date'],
      consistencyRows,
      { stickyFirst: true },
    );

  return section('credibility', '0. 数据可信度', '这一节是全篇的前提。下面每一张图表都建立在这里的口径之上，先看完这节再看数字。', body);
}

function sectionOverview(agg) {
  const rows = agg.configIds.map((id) => {
    const all = agg.byConfig.get(id) || [];
    const lat = latencyRows(agg, id);
    const okCount = all.filter((row) => row.s.ok === true).length;

    const ttftNet = collect(lat, 't_ttft_net_ms');
    const ttftRaw = collect(lat, 't_ttft_ms');
    const e2e = collect(lat, 't_e2e_ms');
    const norm = collect(lat, 'e2e_norm_128_ms');
    const tpot = collect(lat, 'tpot_ms');
    const tps = collect(lat, 'output_tps');

    const costs = collect(all, 'cost_total');
    const currency = uniqueValues(all, 'currency').map((item) => item.value).join('/') || '—';
    const costSum = sumOf(costs);
    const costAvg = costs.length > 0 && isNum(costSum) ? costSum / costs.length : null;
    const mark = costMark(id);

    return [
      cell(id, 'rowhead'),
      numCell(`${fmtInt(okCount)}/${fmtInt(all.length)}`),
      numCell(all.length ? fmtPct(okCount / all.length) : '—'),
      numCell(fmtInt(lat.length)),
      numCell(fmtInt(percentile(ttftNet, 50))),
      numCell(fmtInt(p95(ttftNet))),
      numCell(fmtInt(percentile(burstMedians(lat, 't_ttft_net_ms'), 50))),
      numCell(fmtInt(percentile(ttftRaw, 50))),
      numCell(fmtInt(percentile(e2e, 50))),
      numCell(fmtInt(p95(e2e))),
      numCell(fmtInt(percentile(norm, 50))),
      numCell(fmtNum(percentile(tpot, 50), 1)),
      numCell(fmtNum(percentile(tps, 50), 1)),
      rawCell(escapeHtml(fmtCost(costSum)) + mark, 'num'),
      rawCell(escapeHtml(fmtCost(costAvg)) + mark, 'num'),
      cell(currency),
    ];
  });

  const headers = [
    'config_id',
    { text: '成功/总数', title: '口径：全部样本' },
    { text: '可用率', title: '口径：全部样本，含失败与重试' },
    { text: '干净 n', title: '口径：isCleanSample 且 task 为 image/text' },
    { text: 'TTFT净 P50', title: 't_ttft_net_ms：请求体写完 → 首个正文 token，不含 DNS/TCP/TLS 握手' },
    { text: 'TTFT净 P95', title: 't_ttft_net_ms 的 P95，同样不含握手' },
    { text: 'TTFT净 P50(burst)', title: '先对每个 burst 的重复取中位数，再算 P50。与左边的 TTFT净 P50 应当接近；差得多说明 burst 内部抖动很大' },
    { text: 'TTFT P50(含握手)', title: 't_ttft_ms：从请求开始算起，含 DNS/TCP/TLS。只作对照，用来看握手的量级；冷热混池，不要拿它做平台对比' },
    'E2E P50',
    'E2E P95',
    { text: '归一化E2E P50', title: 'e2e_norm_128_ms：TTFT净 + TPOT×128，消除输出长度差异。基底是不含握手的 TTFT净，与本表 TTFT净 两列同源；只有净列缺失时才回退到含握手的 TTFT' },
    'TPOT 中位',
    'output_tps 中位',
    '总成本',
    '平均每次',
    '币种',
  ];

  const body = noteP('两种口径不同，务必分开读：可用率用全部样本（含失败、重试、被污染的），'
    + '延迟分位数只用干净样本、且只统计 image/text 任务——control_empty 是网络对照组，不代表业务延迟。')
    + noteP(NET_TTFT_NOTE)
    + noteP('「TTFT P50(含握手)」这一列只是对照：它与左边的 TTFT净 P50 之差，就是这批样本里握手摊到 P50 上的量级。')
    + noteP('归一化 E2E（e2e_norm_128_ms = TTFT净 + TPOT×128）的基底也是不含握手的 TTFT净，'
      + '所以它和本表的 TTFT净 两列口径一致，冷热样本混在一起也不出双峰，可以直接跨平台跨时段比。'
      + '只有 t_ttft_net_ms 缺失的老样本才回退到含握手的 TTFT——这种样本有多少，第 0 节会告警。'
      + '而「E2E P50 / P95」用的是原始 t_e2e_ms，按定义从请求开始时刻算起、含握手，'
      + '它是这张表里唯一还带着握手的延迟列，冷热混比时要记住这一点。')
    + noteP('TPOT 与 output_tps 依赖 completion_tokens；流式下拿不到 usage 的样本这两列是 null，会被跳过而不是当 0 算，所以它们的有效样本数可能小于「干净 n」。')
    + renderTable(headers, rows, { stickyFirst: true });

  return section('overview', '1. 总览', '', body);
}

function buildHeatCells(agg, filterTask) {
  const map = new Map();
  for (const id of agg.configIds) {
    const rows = latencyRows(agg, id).filter((row) => (filterTask ? row.s.task === filterTask : true));
    const buckets = hourBuckets(rows, 't_ttft_net_ms', 1);
    map.set(id, buckets.map((bucket) => ({ n: bucket.n, value: bucket.p50 })));
  }
  return map;
}

function sectionHeatmap(agg) {
  const intro = '纵轴是配置，横轴是<strong>上海时间</strong>的 0–23 时（ts_wall_utc 是 UTC，这里已经换算过）。'
    + '格子里的数字是该小时<strong>不含握手的</strong> TTFT 的 P50（毫秒，t_ttft_net_ms），颜色越深越慢。'
    + '这是整套采集的核心产出：如果「工作时段变慢」为真，应该能在 9–12 与 14–18 这两段看到连片的深色。';

  const combined = renderHeatmap(agg.configIds, buildHeatCells(agg, null), { unit: ' ms' });
  const textMap = buildHeatCells(agg, TASK.TEXT);
  const imageMap = buildHeatCells(agg, TASK.IMAGE);

  const body = noteP(NET_TTFT_NOTE)
    + combined
    + noteP('上表混合了 image 与 text 两种任务，也混合了冷热连接。'
      + '任务配比只要每小时一致（采样计划本身保证了这点），横向比较就成立；'
      + '冷热混合在这里不成问题——握手已经从指标里扣掉了，剩下的部分冷热同源。'
      + '但绝对值介于两种任务之间，不要拿它跟单一任务的数字对齐。下面按任务拆开。')
    + '<h3>仅 text_ingredients</h3>'
    + renderHeatmap(agg.configIds, textMap, { unit: ' ms' })
    + '<h3>仅 image_ingredients</h3>'
    + renderHeatmap(agg.configIds, imageMap, { unit: ' ms' });

  return section('heatmap', '2. 按小时的 TTFT 热力图（不含握手）', intro, body);
}

function sectionHourlyLines(agg) {
  const colorOf = (id) => PALETTE[agg.configIds.indexOf(id) % PALETTE.length];
  const series = [];
  for (const id of agg.configIds) {
    // P50 也要有最小样本门槛：只有 1 个样本的小时格照画 P50，等于把单个点当成分位数，
    // 而且折线会把它连成一条看起来有数据的直线。不够就断开。
    const buckets = hourBuckets(latencyRows(agg, id), 't_ttft_net_ms', MIN_N_CELL);
    series.push({
      label: id + ' P50',
      color: colorOf(id),
      dashed: false,
      points: buckets.map((bucket) => bucket.p50),
    });
    series.push({
      label: id + ' P95',
      color: colorOf(id),
      dashed: true,
      points: buckets.map((bucket) => bucket.p95),
    });
  }

  const body = noteP(NET_TTFT_NOTE)
    + renderHourLineChart(series, { title: '按小时的 TTFT净 分位数（上海时）', yLabel: 'TTFT净 (ms)' })
    + renderSeriesLegend(agg.configIds, colorOf)
    + noteP('同一配置的 P50 与 P95 用同一个颜色，实线 P50、虚线 P95。'
      + `某小时的干净样本不足 ${MIN_N_CELL} 条时不画 P50，不足 ${MIN_N_P95} 条时不画 P95——`
      + '两条线都会在那里出现断口。断口是「样本不够，不知道」，不是「延迟为 0」，'
      + '更不是「这一段平稳」：把两个隔着空档的点连成直线，等于凭空编出中间那几个小时的走势。');

  return section('hourly-lines', '3. 按小时的分位数曲线', 'P95 与 P50 的间距就是抖动。间距在某几个小时明显张开，比 P50 整体抬高更值得警惕：那意味着偶发的长尾，用户会直接感知成「卡住了」。', body);
}

function baselineByPlatformHour(agg) {
  const map = new Map();
  const controlRows = agg.rows.filter((row) => row.s.task === TASK.CONTROL && row.usable);
  const platforms = Array.from(new Set(controlRows.map((row) => row.s.platform).filter(Boolean)));
  for (const platform of platforms) {
    const rows = controlRows.filter((row) => row.s.platform === platform);
    map.set(platform, {
      hours: hourBuckets(rows, 't_ttfb_ms', 1),
      overall: percentile(collect(rows, 't_ttfb_ms'), 50),
      n: rows.length,
      okAll: agg.rows.filter((row) => row.s.task === TASK.CONTROL && row.s.platform === platform).length,
      clean: agg.rows.filter((row) => row.s.task === TASK.CONTROL && row.s.platform === platform && row.clean).length,
    });
  }
  return map;
}

function sectionBaseline(agg) {
  const baselines = baselineByPlatformHour(agg);
  if (baselines.size === 0) {
    return section('baseline', '4. 网络基线扣除', '', '<p class="empty">（没有 control_empty 样本，无法计算网络基线）</p>');
  }

  const intro = '测量节点在美国，硅基流动和火山方舟的机房在中国大陆，每一次请求都要跨太平洋往返。'
    + '这条链路本身的 RTT 会随时间波动（海缆拥塞、路由变化、对端入口清洗），波动幅度完全可能压过服务端本身的排队差异。'
    + '如果不扣掉它，看到的「某小时变慢」很可能只是当时网络差，跟模型服务无关。'
    + 'control_empty 就是为此存在的：同一时刻、同一域名、同一 TLS 会话参数，发一个几乎不产生计算的请求，'
    + '它的 TTFB 近似「链路 + 接入层」的固定开销。'
    + '<br>本节的减法是 <strong>业务的 reqFinish→首个正文 token（t_ttft_net_ms）的 P50 '
    + '− 对照的 reqFinish→响应头（t_ttfb_ms）的 P50</strong>：'
    + '两侧的计时起点都是「请求体写完」，都不含 DNS/TCP/TLS 握手，相减才是同一段窗口的差。'
    + '（业务侧若用含握手的 t_ttft_ms，差值里会整整多出一次握手，而握手成本按平台差一个数量级——'
    + '美国 runner 到国内机房是几百毫秒，到同在美国的 DeepInfra 只有几十毫秒——'
    + '「国内平台服务端更慢」就会被凭空放大，而这一节存在的唯一目的恰恰是把链路开销剥出去。）'
    + '两侧都不含握手，也就不必再按 conn_mode / conn_established 分组去配对冷热样本了。';

  const platformRows = Array.from(baselines.entries()).map(([platform, info]) => [
    cell(platform, 'rowhead'),
    numCell(fmtInt(info.okAll)),
    numCell(fmtInt(info.n)),
    numCell(fmtInt(info.overall)),
  ]);

  // 净耗时热力图：某小时的「不含握手 TTFT」P50 减去同平台同小时的对照 TTFB P50。
  // 两侧都从 reqFinish 起算，相减才是同一段窗口的差；用 t_ttft_ms 会多扣出一次握手。
  const netMap = new Map();
  for (const id of agg.configIds) {
    const platform = configPlatform(id, agg.rows);
    const info = platform ? baselines.get(platform) : null;
    const buckets = hourBuckets(latencyRows(agg, id), 't_ttft_net_ms', 1);
    netMap.set(id, buckets.map((bucket, hour) => {
      const base = info ? info.hours[hour].p50 : null;
      if (!isNum(bucket.p50) || !isNum(base)) return { n: 0, value: null };
      return { n: bucket.n, value: bucket.p50 - base };
    }));
  }

  const summaryRows = [];
  for (const id of agg.configIds) {
    const platform = configPlatform(id, agg.rows);
    const info = platform ? baselines.get(platform) : null;
    for (const task of LATENCY_TASKS) {
      const rows = latencyRows(agg, id).filter((row) => row.s.task === task);
      if (rows.length === 0) continue;
      const ttftNet = percentile(collect(rows, 't_ttft_net_ms'), 50);
      const base = info ? info.overall : null;
      summaryRows.push([
        cell(id, 'rowhead'),
        cell(task),
        numCell(fmtInt(rows.length)),
        numCell(fmtInt(ttftNet)),
        numCell(fmtInt(base)),
        numCell(isNum(ttftNet) && isNum(base) ? fmtInt(ttftNet - base) : '—'),
      ]);
    }
  }

  const body = renderTable(
    ['平台', 'control 样本数', '用于基线的样本数', '基线 TTFB P50 (ms)'],
    platformRows,
    { stickyFirst: true },
  )
    + noteP('这里的基线用的是放宽口径：ok=true、is_retry≠true、时钟正常。没有用 isCleanSample，'
      + '因为 control_empty 请求通常拿不到 usage，reasoning_tokens 是 null 而不是 0，按主口径会被全部剔掉。')
    + '<h3>服务端净耗时（业务 reqFinish→首 token 的 P50 − 对照 reqFinish→响应头 的 P50）</h3>'
    + renderHeatmap(agg.configIds, netMap, { unit: ' ms' })
    + '<h3>全时段汇总</h3>'
    + renderTable(
      [
        'config_id',
        '任务',
        '干净 n',
        { text: 'TTFT净 P50', title: 't_ttft_net_ms：业务请求 reqFinish→首个正文 token，不含握手' },
        { text: '平台基线 TTFB P50', title: 'control_empty 的 t_ttfb_ms：对照请求 reqFinish→响应头，同样不含握手' },
        { text: '净耗时', title: '两者之差。都从 reqFinish 起算，差值里不再含握手' },
      ],
      summaryRows,
      { stickyFirst: true },
    )
    + noteP('三点必须说清楚：一，中位数之差不等于差值的中位数，这个扣除只是一阶近似；'
      + '二，reqFinish 只是「请求体写进了本地内核发送缓冲区」，不是「对端收到了请求体」，'
      + '大图的上行传输仍然落在业务侧这个窗口里，而对照请求的 body 极小、几乎不含上行传输，'
      + '所以扣完之后剩下的仍然混着「上传大图」的耗时（见第 5 节的 t_req_body_ms 分布）；'
      + '三，净耗时出现负数说明该小时的对照样本恰好比业务样本更慢，通常是对照组样本太少造成的，别当成「服务端耗时为负」。');

  return section('baseline', '4. 网络基线扣除', intro, body);
}

function sectionImageDelta(agg) {
  const deltaRows = [];
  for (const id of agg.configIds) {
    const image = latencyRows(agg, id).filter((row) => row.s.task === TASK.IMAGE);
    const text = latencyRows(agg, id).filter((row) => row.s.task === TASK.TEXT);
    if (image.length === 0 && text.length === 0) continue;
    // 用净口径：ΔP50/ΔP95 本来就不太受握手影响（两侧冷热配比一致，偏差相消），
    // 但绝对值不换就会跟第 1 节的净 P50 差出一整次握手，读者会以为两张表自相矛盾。
    const imgTtft = collect(image, 't_ttft_net_ms');
    const txtTtft = collect(text, 't_ttft_net_ms');
    const i50 = percentile(imgTtft, 50);
    const t50 = percentile(txtTtft, 50);
    const i95 = p95(imgTtft);
    const t95 = p95(txtTtft);
    deltaRows.push([
      cell(id, 'rowhead'),
      numCell(fmtInt(image.length)),
      numCell(fmtInt(i50)),
      numCell(fmtInt(i95)),
      numCell(fmtInt(text.length)),
      numCell(fmtInt(t50)),
      numCell(fmtInt(t95)),
      numCell(isNum(i50) && isNum(t50) ? fmtSignedInt(i50 - t50) : '—'),
      numCell(isNum(i95) && isNum(t95) ? fmtSignedInt(i95 - t95) : '—'),
    ]);
  }

  const sizeRows = [];
  for (const id of agg.configIds) {
    for (const task of LATENCY_TASKS) {
      const rows = latencyRows(agg, id).filter((row) => row.s.task === task);
      if (rows.length === 0) continue;
      sizeRows.push([
        cell(id, 'rowhead'),
        cell(task),
        numCell(fmtInt(rows.length)),
        numCell(fmtBytes(percentile(collect(rows, 'request_body_bytes'), 50))),
        numCell(fmtBytes(percentile(collect(rows, 'image_b64_bytes'), 50))),
        numCell(fmtInt(percentile(collect(rows, 'prompt_tokens'), 50))),
      ]);
    }
  }

  const bodyRows = [];
  for (const id of agg.configIds) {
    for (const task of LATENCY_TASKS) {
      const rows = latencyRows(agg, id).filter((row) => row.s.task === task);
      const values = collect(rows, 't_req_body_ms');
      if (values.length === 0) continue;
      const tiny = values.filter((value) => value <= 2).length;
      bodyRows.push([
        cell(id, 'rowhead'),
        cell(task),
        numCell(fmtInt(values.length)),
        numCell(fmtNum(percentile(values, 50), 1)),
        numCell(fmtNum(percentile(values, 90), 1)),
        numCell(fmtNum(p95(values), 1)),
        numCell(fmtNum(maxOf(values), 1)),
        numCell(fmtPct(tiny / values.length)),
      ]);
    }
  }

  const intro = '图片任务比纯文本慢多少？这个差值里混着两件完全不同的事：'
    + '把几百 KB 的 base64 推过太平洋（上行传输），和模型多算几千个视觉 token（prefill）。'
    + '两者的优化手段完全不同——前者靠压图和就近接入，后者只能换模型或降分辨率——所以必须分开看。';

  const body = noteP(NET_TTFT_NOTE)
    + renderTable(
      [
        'config_id',
        'image n',
        { text: 'image TTFT净 P50', title: 't_ttft_net_ms：reqFinish→首个正文 token，不含握手' },
        { text: 'image TTFT净 P95', title: 't_ttft_net_ms 的 P95，同样不含握手' },
        'text n',
        { text: 'text TTFT净 P50', title: 't_ttft_net_ms：reqFinish→首个正文 token，不含握手' },
        { text: 'text TTFT净 P95', title: 't_ttft_net_ms 的 P95，同样不含握手' },
        { text: 'ΔP50', title: 'image 减 text。两侧冷热配比一致，这个差值本来就基本不受握手影响' },
        { text: 'ΔP95', title: 'image 减 text，同样是净口径' },
      ],
      deltaRows,
      { stickyFirst: true },
    )
    + noteP('Δ 的量级不依赖口径：image 与 text 的冷热配比相同，握手在相减时大体抵消，结论方向和数量级都不变。'
      + '但「两个分布的 P50 之差」不等于「差的 P50」，含握手的那两个分布各自是双峰的，'
      + '所以换成净口径后 Δ 还是会小幅移动——净口径下两侧都没有双峰，这一版的 Δ 才是该信的那个。'
      + '换口径的另一个理由是让绝对值跟第 1 节的 TTFT净 对得上，不然两张表看起来会自相矛盾。')
    + noteP('注意上行传输仍然落在净口径这个窗口里：reqFinish 只是「请求体写进了本地内核发送缓冲区」，'
      + '大图真正推过太平洋的时间在那之后，仍算在 TTFT净 里。所以「上传 vs prefill」这个拆分依旧成立。')
    + '<h3>请求体积与输入 token（中位数）</h3>'
    + renderTable(
      ['config_id', '任务', 'n', 'request_body_bytes', 'image_b64_bytes', 'prompt_tokens'],
      sizeRows,
      { stickyFirst: true },
    )
    + noteP('如果 image 与 text 的 prompt_tokens 差得不多、但请求体大了两个数量级，那这段延迟主要是上传；'
      + '反过来 prompt_tokens 翻了几十倍，慢就慢在 prefill。')
    + '<h3>t_req_body_ms 分布</h3>'
    + renderTable(
      ['config_id', '任务', 'n', 'P50', 'P90', 'P95', '最大值', '≤2ms 占比'],
      bodyRows,
      { stickyFirst: true },
    )
    + noteP('关于 t_req_body_ms 必须诚实：它测的是「请求体写进了内核 socket 发送缓冲区」，不是「对端收到了请求体」。'
      + 'body 小于缓冲区时 write 立刻返回，这个值几乎恒为 0~2ms，没有任何信息量——上面那列「≤2ms 占比」就是用来暴露这一点的。'
      + '只有大图撑爆缓冲区、触发 TCP 背压时，它才近似等于上行传输耗时。占比接近 100% 的行，请直接忽略它的 P50。');

  return section('image-delta', '5. 图片带来的增量', intro, body);
}

function sectionConnMode(agg) {
  // 全篇唯一保留 t_ttft_ms（含 DNS/TCP/TLS）的一节：这里要看的恰恰就是握手本身值多少毫秒。
  // 换成 t_ttft_net_ms 会把冷热差抹平到只剩噪声，这一节也就没有存在意义了。
  const rows = [];
  for (const id of agg.configIds) {
    const base = latencyRows(agg, id);
    const cold = base.filter((row) => row.s.conn_mode === CONN_MODE.COLD);
    const warm = base.filter((row) => row.s.conn_mode === CONN_MODE.WARM);
    if (cold.length === 0 && warm.length === 0) continue;
    // conn_mode 是意图，conn_established 才是证据：warm 组里第一次请求必然要建连接。
    const warmReused = warm.filter((row) => row.s.conn_established === false);
    const warmFresh = warm.filter((row) => row.s.conn_established === true);
    const coldTtft = percentile(collect(cold, 't_ttft_ms'), 50);
    const reusedTtft = percentile(collect(warmReused, 't_ttft_ms'), 50);
    const coldTls = percentile(collect(cold, 't_tls_ms'), 50);

    rows.push([
      cell(id, 'rowhead'),
      numCell(fmtInt(cold.length)),
      numCell(cold.length ? fmtPct(cold.filter((row) => row.s.conn_established === true).length / cold.length) : '—'),
      numCell(fmtInt(coldTtft)),
      numCell(fmtInt(p95(collect(cold, 't_ttft_ms')))),
      numCell(fmtInt(coldTls)),
      numCell(fmtInt(warm.length)),
      numCell(warm.length ? fmtPct(warmFresh.length / warm.length) : '—'),
      numCell(fmtInt(warmReused.length)),
      numCell(fmtInt(reusedTtft)),
      numCell(fmtInt(p95(collect(warmReused, 't_ttft_ms')))),
      numCell(isNum(coldTtft) && isNum(reusedTtft) ? fmtSignedInt(coldTtft - reusedTtft) : '—'),
    ]);
  }

  const headers = [
    'config_id',
    'cold n', 'cold 实际建连占比', 'cold TTFT P50', 'cold TTFT P95', 'cold TLS P50',
    'warm n', 'warm 里实际建连占比', 'warm 复用 n', 'warm 复用 TTFT P50', 'warm 复用 TTFT P95',
    'ΔTTFT(冷−热复用)',
  ];

  const body = noteP('口径提醒：本节的 TTFT 是含握手的 t_ttft_ms（从请求开始算起，含 DNS/TCP/TLS），'
    + '与其余各节（第 1–5、7 节）用的 t_ttft_net_ms 不同，这是全篇唯一一处例外。'
    + '别的节要比的是服务端，握手是噪声，必须扣掉；这一节要量的就是握手本身——'
    + '「冷连接比热连接慢多少」这个问题，答案几乎全部来自那一次握手，'
    + '换成不含握手的口径，下面这张表的 ΔTTFT 会塌成噪声，整节也就没意义了。'
    + '所以这里刻意不统一口径，但两处的数字不能直接互相套用。')
    + renderTable(headers, rows, { stickyFirst: true })
    + noteP('conn_mode 只是「意图」，conn_established 才是「证据」：warm 组里第一次请求必然要新建连接，'
      + '把它算进热连接会把握手开销摊进热数据里、缩小冷热差距。所以热连接的数字只取 conn_established=false 的样本，'
      + '而「warm 里实际建连占比」这一列就是用来看这批数据被污染了多少。')
    + noteP('cold 那一侧的「实际建连占比」正常应该接近 100%；明显偏低说明连接被意外复用了，冷连接组也不干净。'
      + '冷连接对应手机冷启动或切网后的第一次请求，是用户感知最强的一段，不应该被 warmup 藏掉。');

  return section('conn-mode', '6. 冷热连接对比（含握手口径）',
    '这一节量的是握手本身：冷连接要走完 DNS+TCP+TLS 才能发第一个字节，热连接直接复用。'
    + '前面几节把这段开销扣掉是为了比服务端，这里不扣，是为了看它到底值多少毫秒。', body);
}

function sectionArkFast(agg) {
  const rows = (agg.byConfig.get('ark-mini-fast') || []);
  if (rows.length === 0) {
    return section('ark-fast', '7. 火山低延迟专项', '', '<p class="empty">（没有 ark-mini-fast 的样本）</p>');
  }

  const usable = rows.filter((row) => row.usable && LATENCY_TASKS.includes(row.s.task));
  const tierGroups = new Map();
  for (const row of usable) {
    const tier = row.s.service_tier_actual || '（未返回）';
    if (!tierGroups.has(tier)) tierGroups.set(tier, []);
    tierGroups.get(tier).push(row);
  }
  const tierRows = Array.from(tierGroups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tier, group]) => [
      cell(tier, 'rowhead'),
      numCell(fmtInt(group.length)),
      numCell(fmtPct(group.length / usable.length)),
      // 净口径：各档冷热配比一致，握手在档位之间相减时大体抵消，结论不变；
      // 但绝对值不换就会跟第 1 节的净 P50 差出一整次握手，两张表看起来会自相矛盾。
      numCell(fmtInt(percentile(collect(group, 't_ttft_net_ms'), 50))),
      numCell(fmtInt(p95(collect(group, 't_ttft_net_ms')))),
    ]);

  // 降级率只在两个档位字段都拿到的样本里算，否则分母被「没返回 tier」的样本稀释。
  const decidable = rows.filter((row) => row.s.service_tier_requested && row.s.service_tier_actual);
  const degradedCount = decidable.filter((row) => row.s.degraded === true).length;
  const rate = decidable.length > 0 ? degradedCount / decidable.length : null;

  const warning = isNum(rate) && rate > 0.2
    ? banner('err', `降级率 ${fmtPct(rate)}：超过 20%。fast 配额很可能不足，`
      + '这批样本里有相当一部分根本没跑在低延迟档上，「fast 比 default 快多少」的对比结论不成立——'
      + '要么先扩配额再重跑，要么只用 service_tier_actual=fast 的那部分样本作结论并接受它的选择性偏差。')
    : banner('ok', `降级率 ${isNum(rate) ? fmtPct(rate) : '—'}：在可接受范围内。`);

  const fastGroup = tierGroups.get('fast') || [];
  const defaultRows = (agg.byConfig.get('ark-mini-default') || [])
    .filter((row) => row.usable && LATENCY_TASKS.includes(row.s.task));
  const fastP50 = percentile(collect(fastGroup, 't_ttft_net_ms'), 50);
  const defaultP50 = percentile(collect(defaultRows, 't_ttft_net_ms'), 50);
  const compare = isNum(fastP50) && isNum(defaultP50)
    ? noteP(`仅看实际生效的 fast 样本（n=${fastGroup.length}）：TTFT净 P50 ${fmtInt(fastP50)} ms，`
      + `对照 ark-mini-default（n=${defaultRows.length}）${fmtInt(defaultP50)} ms，差值 ${fmtSignedInt(fastP50 - defaultP50)} ms。`
      + '注意这是在剔除了降级样本之后比的，代价是低延迟档的单价是常规档的 2 倍。')
    : '';

  const body = warning
    + noteP(NET_TTFT_NOTE)
    + renderTable(
      [
        'service_tier_actual',
        '样本数',
        '占比',
        { text: 'TTFT净 P50', title: 't_ttft_net_ms：reqFinish→首个正文 token，不含握手' },
        { text: 'TTFT净 P95', title: 't_ttft_net_ms 的 P95，同样不含握手' },
      ],
      tierRows,
      { stickyFirst: true },
    )
    + noteP(`降级判定样本 ${decidable.length} 条，其中 degraded=true 共 ${degradedCount} 条。`
      + '本节用的是放宽口径（ok + 非重试 + 时钟正常），因为主口径会把 degraded=true 的样本整批剔掉，'
      + '而这一节要看的恰恰就是它们。')
    + compare;

  return section('ark-fast', '7. 火山低延迟专项', '请求里写了 service_tier=fast，不代表真的跑在 fast 档上。'
    + '配额不够时平台会静默降级，只有响应体顶层的 service_tier_actual 能看出来。降级率是这一节的核心数字。', body);
}

function sectionFailures(agg) {
  const classes = Array.from(new Set(
    agg.rows.filter((row) => row.s.ok !== true).map((row) => row.s.error_class || 'unknown'),
  ));
  const known = Object.values(ERROR_CLASS).filter((name) => classes.includes(name));
  const extra = classes.filter((name) => !known.includes(name)).sort();
  const ordered = known.concat(extra);

  let matrix = '<p class="empty">（时间范围内没有失败样本）</p>';
  if (ordered.length > 0) {
    const rows = agg.configIds.map((id) => {
      const configRows = agg.byConfig.get(id) || [];
      const line = [cell(id, 'rowhead')];
      let total = 0;
      for (const name of ordered) {
        const count = configRows.filter((row) => row.s.ok !== true && (row.s.error_class || 'unknown') === name).length;
        total += count;
        line.push(numCell(count === 0 ? '·' : fmtInt(count), count > 0 ? 'bad' : 'zero'));
      }
      line.push(numCell(fmtInt(total)));
      line.push(numCell(configRows.length ? fmtPct(total / configRows.length) : '—'));
      return line;
    });
    matrix = renderTable(
      ['config_id'].concat(ordered).concat(['失败合计', '失败率']),
      rows,
      { stickyFirst: true },
    );
  }

  // 错误信息样例：同一 error_class 只留最新一条，避免刷屏。
  const samplesByClass = new Map();
  for (const row of agg.rows) {
    if (row.s.ok === true) continue;
    const name = row.s.error_class || 'unknown';
    const existing = samplesByClass.get(name);
    if (!existing || (isNum(row.ts) && isNum(existing.ts) && row.ts > existing.ts)) {
      samplesByClass.set(name, row);
    }
  }
  const messageRows = Array.from(samplesByClass.entries()).map(([name, row]) => [
    cell(name, 'rowhead'),
    cell(row.s.config_id),
    cell(isNum(row.s.http_status) ? row.s.http_status : '—'),
    cell(row.s.ts_wall_utc || '—'),
    cell(row.s.error_message || '—', 'msg'),
  ]);

  const body = matrix
    + noteP('429 是「被限流」不是「慢」，timeout_* 才是链路或服务端的问题，两者的处置手段完全不同，所以分列统计。')
    + '<h3>失败时间分布</h3>'
    + renderFailureScatter(agg)
    + '<h3>各类错误的最新一条样例</h3>'
    + renderTable(['error_class', 'config_id', 'http_status', 'ts_wall_utc', 'error_message（已截断脱敏）'], messageRows, { stickyFirst: true });

  return section('failures', '8. 失败与错误构成', '延迟分位数只用成功样本算，所以失败必须单独看：一个 P50 很漂亮但 5% 请求超时的服务，用户体验比 P50 慢一倍但从不失败的服务更差。', body);
}

function sectionCost(agg) {
  // 按「配置 × 任务」拆开：image 请求的输入 token 是 text 的好几倍，
  // 把两者混在一行里算中位数只会得到一个在两个峰之间乱跳的数字。
  const byCurrency = new Map();
  for (const id of agg.configIds) {
    const rows = agg.byConfig.get(id) || [];
    const currencies = Array.from(new Set(rows.map((row) => row.s.currency).filter(Boolean)));
    for (const currency of currencies) {
      const scoped = rows.filter((row) => row.s.currency === currency);
      if (!byCurrency.has(currency)) byCurrency.set(currency, []);
      const entries = [];
      const tasks = Array.from(new Set(scoped.map((row) => row.s.task).filter(Boolean)));
      for (const task of tasks.concat(['（合计）'])) {
        const subset = task === '（合计）' ? scoped : scoped.filter((row) => row.s.task === task);
        const costs = collect(subset, 'cost_total');
        const total = sumOf(costs);
        entries.push({
          id,
          task,
          n: subset.length,
          priced: costs.length,
          total,
          per1k: costs.length > 0 && isNum(total) ? (total / costs.length) * 1000 : null,
          promptMedian: task === '（合计）' ? null : percentile(collect(subset, 'prompt_tokens'), 50),
          completionMedian: task === '（合计）' ? null : percentile(collect(subset, 'completion_tokens'), 50),
        });
      }
      byCurrency.get(currency).push(...entries);
    }
  }

  if (byCurrency.size === 0) {
    return section('cost', '9. 成本对比', '', '<p class="empty">（没有带成本的样本）</p>');
  }

  let body = '';
  for (const [currency, list] of byCurrency.entries()) {
    const rows = list.map((item) => {
      const mark = costMark(item.id);
      const config = getConfig(item.id);
      const confidence = config && config.pricing ? config.pricing.confidence : '—';
      const isTotal = item.task === '（合计）';
      return [
        cell(item.id, 'rowhead'),
        cell(item.task, isTotal ? 'rowhead' : ''),
        numCell(fmtInt(item.n)),
        numCell(fmtInt(item.priced)),
        rawCell(escapeHtml(fmtCost(item.total)) + mark, 'num'),
        rawCell(escapeHtml(fmtCost(item.per1k)) + mark, 'num'),
        numCell(isTotal ? '' : fmtInt(item.promptMedian)),
        numCell(isTotal ? '' : fmtInt(item.completionMedian)),
        cell(confidence, confidence === 'unverified' ? 'warncell' : ''),
      ];
    });
    body += `<h3>${escapeHtml(currency)}</h3>`
      + renderTable(
        ['config_id', '任务', '样本数', '有成本的样本', `总成本 (${currency})`, `每千次请求 (${currency})`, 'prompt_tokens 中位', 'completion_tokens 中位', '单价可信度'],
        rows,
        { stickyFirst: true },
      );
  }

  body += noteP('CNY 与 USD 分开列，刻意不做汇率换算：汇率是一个没人核对过、还会随时间漂移的变量，'
    + '把它塞进来会让「哪家便宜」这个结论依赖一个报表作者随手填的数字。要跨币种比较，请自己在决策时点用当时的汇率算一次。')
    + noteP('「每千次请求」是按本基准的采样请求外推的：这里的 prompt_tokens / completion_tokens 由固定的测试提示词和 max_tokens='
      + '上限决定，跟真实业务流量的分布不同；「（合计）」行还隐含了本基准的任务配比。真实业务里图片请求占多少，'
      + '直接决定实际账单，所以要估预算请用对应任务那一行乘以你自己的配比，不要抄合计行。')
    + noteP(`定价快照日期：${PRICE_SNAPSHOT_DATE}。跑完长测后请重新核对官方单价——一周里调过价的话，这里的合计就是跨价格版本相加的结果。`);

  return section('cost', '9. 成本对比', '', body);
}

function sectionRaw(agg, meta) {
  const dayMap = new Map();
  for (const row of agg.rows) {
    if (!row.date) continue;
    if (!dayMap.has(row.date)) dayMap.set(row.date, []);
    dayMap.get(row.date).push(row);
  }
  const dayRows = Array.from(dayMap.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, rows]) => {
      const ok = rows.filter((row) => row.s.ok === true).length;
      const clean = rows.filter((row) => row.clean).length;
      const rounds = new Set(rows.map((row) => row.s.round_id).filter(Boolean)).size;
      return [
        cell(date, 'rowhead'),
        numCell(fmtInt(rounds)),
        numCell(fmtInt(rows.length)),
        numCell(fmtInt(ok)),
        numCell(fmtInt(clean)),
        numCell(rows.length ? fmtPct(ok / rows.length) : '—'),
      ];
    });

  const drift = collect(agg.rows, 'schedule_drift_ms');
  const spanStart = agg.tsMin === null ? null : shanghaiParts(new Date(agg.tsMin).toISOString());
  const spanEnd = agg.tsMax === null ? null : shanghaiParts(new Date(agg.tsMax).toISOString());
  const spanDays = isNum(agg.tsMin) && isNum(agg.tsMax)
    ? (agg.tsMax - agg.tsMin) / 86400000
    : null;

  const summaryRows = [
    ['JSONL 文件数（扫描到）', fmtInt(meta.fileCount)],
    ['JSONL 文件数（有数据进入本报表）', fmtInt(meta.contributingCount)],
    ['解析失败的行数', fmtInt(meta.badLines)],
    ['因 --since 跳过的样本数', fmtInt(meta.skippedBySince)],
    ['时间跨度起（上海时）', spanStart ? `${spanStart.date} ${spanStart.hour}时` : '—'],
    ['时间跨度止（上海时）', spanEnd ? `${spanEnd.date} ${spanEnd.hour}时` : '—'],
    ['跨度（天）', fmtNum(spanDays, 2)],
    ['轮次数（distinct round_id）', fmtInt(new Set(agg.rows.map((row) => row.s.round_id).filter(Boolean)).size)],
    ['run 数（distinct run_id）', fmtInt(new Set(agg.rows.map((row) => row.s.run_id).filter(Boolean)).size)],
    ['schedule_drift_ms P50 / P95 / 最大', `${fmtInt(percentile(drift, 50))} / ${fmtInt(p95(drift))} / ${fmtInt(maxOf(drift))}`],
  ].map(([key, value]) => [cell(key), numCell(value)]);

  const body = renderTable(['项', '值'], summaryRows)
    + '<h3>每天样本数（按上海时日期）</h3>'
    + renderTable(['日期', '轮次', '样本数', '成功数', '干净数', '成功率'], dayRows, { stickyFirst: true })
    + noteP('schedule_drift_ms 是「计划触发时刻 → 实际开始时刻」的差。GitHub Actions 的 cron 在整点前后经常排队几分钟，'
      + '抖动大到跨小时时，样本会落进相邻的小时桶里——这会把热力图的边界抹平，让小时级规律看起来比实际更缓和。');

  return section('raw', '10. 原始数据摘要', '', body);
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const STYLE = `
:root{
  --bg:#f6f7f9; --panel:#ffffff; --fg:#1b2028; --muted:#5b6673; --line:#dde2e8;
  --accent:#2b5fa8; --ok-fg:#12603a; --ok-bg:#e3f5ea; --warn-fg:#7a4f00; --warn-bg:#fff3d6;
  --err-fg:#a01a13; --err-bg:#fde9e7; --zero:#a8b0ba;
  --heat-rgb:21 101 192; --heat-hot-fg:#ffffff; --sparse:#c6ccd4;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#10141a; --panel:#171d25; --fg:#e5eaf1; --muted:#98a3b2; --line:#29323d;
    --accent:#7fb0f5; --ok-fg:#79d9a4; --ok-bg:#12301f; --warn-fg:#f2c85c; --warn-bg:#33280d;
    --err-fg:#ff9a90; --err-bg:#3a1a17; --zero:#4a5462;
    --heat-rgb:118 176 255; --heat-hot-fg:#08111c; --sparse:#39424f;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:15px;line-height:1.6}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 80px}
header.top{padding:24px 0 8px;border-bottom:1px solid var(--line);margin-bottom:16px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:18px;margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid var(--accent);display:inline-block}
h3{font-size:15px;margin:22px 0 8px;color:var(--muted)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
p{margin:8px 0}
.sub{color:var(--muted);font-size:13px}
.intro{font-size:14px;color:var(--fg);background:rgb(var(--heat-rgb) / 0.07);border-left:3px solid var(--accent);
  padding:10px 12px;border-radius:0 6px 6px 0;margin-bottom:12px}
.note{font-size:13px;color:var(--muted);margin:8px 0}
.empty{font-size:13px;color:var(--muted);font-style:italic}
.banner{padding:10px 12px;border-radius:6px;font-size:14px;margin:8px 0}
.banner.err{background:var(--err-bg);color:var(--err-fg);font-weight:600}
.banner.warn{background:var(--warn-bg);color:var(--warn-fg)}
.banner.ok{background:var(--ok-bg);color:var(--ok-fg)}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 150px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--bg)}
.cardv{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.cardk{font-size:12px;color:var(--muted)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--panel)}
th,td{border-bottom:1px solid var(--line);padding:6px 9px;text-align:left;white-space:nowrap}
th{background:var(--bg);color:var(--muted);font-weight:600;position:sticky;top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.rowhead{font-weight:600}
td.sticky{position:sticky;left:0;background:var(--panel);z-index:1}
td.bad{color:var(--err-fg);font-weight:600}
td.warncell{color:var(--warn-fg)}
td.zero{color:var(--zero)}
td.msg{white-space:normal;max-width:520px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
table.compact td,table.compact th{padding:4px 8px}
table.heat td.hm{padding:0;text-align:center;min-width:34px}
.hmv{display:block;padding:6px 2px;font-size:11px;font-variant-numeric:tabular-nums;
  background:rgb(var(--heat-rgb) / calc(0.06 + var(--t) * 0.88))}
.hmv.hot{color:var(--heat-hot-fg)}
table.heat td.sparse{background:repeating-linear-gradient(45deg,transparent,transparent 4px,var(--sparse) 4px,var(--sparse) 6px)}
.sparseLabel{display:block;padding:6px 2px;font-size:10px;color:var(--muted)}
.void{display:block;padding:6px 2px;color:var(--zero)}
.heatlegend{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px;margin:4px 0 12px}
.heatlegend .swatch{width:26px;height:12px;display:inline-block;border:1px solid var(--line);
  background:rgb(var(--heat-rgb) / calc(0.06 + var(--t) * 0.88))}
.legendsep{margin-left:10px}
.muted{color:var(--muted)}
.chart{display:block;width:100%;min-width:620px;height:auto}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .grid.faint{stroke:var(--line);stroke-width:1;opacity:.45}
.chart .axisline{stroke:var(--muted);stroke-width:1}
.chart text.axis{fill:var(--muted);font-size:11px}
.sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:6px}
td.swcell{width:36px}
.linesample{display:inline-block;width:26px;height:0;border-top:2px solid var(--muted);vertical-align:4px;margin-right:6px}
.linesample.dashed{border-top-style:dashed}
.legendrow{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin:6px 0}
.qmark{color:var(--warn-fg);font-weight:700;cursor:help}
nav.toc{font-size:13px;margin:10px 0 0}
nav.toc a{color:var(--accent);margin-right:12px;display:inline-block;text-decoration:none}
nav.toc a:hover{text-decoration:underline}
footer{margin-top:24px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
footer li{margin:4px 0}
@media (max-width:640px){
  .wrap{padding:12px 10px 60px}
  body{font-size:14px}
  section{padding:12px 10px}
}
`;

const TOC = [
  ['credibility', '0 数据可信度'],
  ['overview', '1 总览'],
  ['heatmap', '2 小时热力图'],
  ['hourly-lines', '3 分位数曲线'],
  ['baseline', '4 网络基线扣除'],
  ['image-delta', '5 图片增量'],
  ['conn-mode', '6 冷热连接（含握手）'],
  ['ark-fast', '7 火山低延迟'],
  ['failures', '8 失败构成'],
  ['cost', '9 成本'],
  ['raw', '10 原始数据'],
];

function renderFooter(meta) {
  const items = [
    `分位数：最近秩法（sorted[Math.ceil(p/100*n)-1]），不做插值。n &lt; ${MIN_N_P95} 时不报 P95，显示「—」。`,
    '空值：任何为 null 的字段一律跳过，不参与平均、求和或分位数。「—」代表没测到，不代表 0。',
    'TTFT 口径：第 1–5、7 节一律用 t_ttft_net_ms（请求体写完 → 首个正文 token，不含 DNS/TCP/TLS），'
      + '冷热连接因此可比、不出双峰；第 6 节刻意用含握手的 t_ttft_ms，因为那一节量的就是握手，是全篇唯一例外。'
      + '第 4 节的对照侧 t_ttfb_ms 同样从请求体写完起算，两侧起点一致才能相减。'
      + '总览表另给了一列含握手的 TTFT P50 作对照。',
    '归一化 E2E（e2e_norm_128_ms = TTFT净 + TPOT×128）的基底也是不含握手的 TTFT净，与各节的 TTFT净 同口径，'
      + '只有 t_ttft_net_ms 缺失的老样本才回退到含握手的 TTFT。'
      + 'E2E（t_e2e_ms）按定义仍从请求开始时刻起算、含握手，是唯一带握手的延迟列。',
    't_ttft_net_ms 是后加的列：在它之前采集的 JSONL 没有这个字段，那些样本会被第 1–5、7 节按 null 跳过。'
      + '这种样本的条数与占比由第 0 节告警，超过一半时是红色横幅。',
    `时区：所有按小时/按天的分组都用 ${TZ}（Intl 换算），ts_wall_utc 本身是 UTC。`,
    '干净样本：schema.js 的 isCleanSample()——成功、非失败重试（is_retry≠true）、未命中缓存、未降级、reasoning_tokens=0、时钟未漂移。',
    '放宽口径（只用于第 4 节网络基线与第 7 节降级专项）：成功 + 非失败重试 + 时钟未漂移，页面上已逐处标注。',
    '同一 burst 内的重复采样都算正当样本、全部计入；但它们只隔几秒、彼此相关，请求级分位数的有效样本量小于 n。总览表另给了一列 burst 中位数口径的 P50 作交叉验证。',
    '冷热连接：只按 conn_mode 分组会把 warm 组里真正新建连接的那些请求混进来，所以热连接的数字只取 conn_established=false 的样本。',
    `热力图颜色按每张图内部的最小/最大值线性归一，跨图不可比。格子样本数 &lt; ${MIN_N_CELL} 画灰色斜线。`,
    `定价快照：${escapeHtml(PRICE_SNAPSHOT_DATE)}；CNY 与 USD 不做汇率换算。`,
    `生成时间：${escapeHtml(meta.generatedAt)}；数据目录：${escapeHtml(meta.resultsDir)}${meta.since ? `；--since ${escapeHtml(meta.since)}` : ''}。`,
  ];
  return `<footer><strong>方法学</strong><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul></footer>`;
}

function buildReport(samples, options) {
  const meta = Object.assign(
    {
      generatedAt: new Date().toISOString(),
      resultsDir: 'results',
      since: null,
      fileCount: 0,
      contributingCount: 0,
      badLines: 0,
      skippedBySince: 0,
    },
    options || {},
  );

  const agg = aggregate(samples || []);

  const head = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>LLM 延迟基准报表</title>'
    + `<style>${STYLE}</style></head><body><div class="wrap">`;

  const spanStart = agg.tsMin === null ? null : shanghaiParts(new Date(agg.tsMin).toISOString());
  const spanEnd = agg.tsMax === null ? null : shanghaiParts(new Date(agg.tsMax).toISOString());
  const header = '<header class="top"><h1>LLM 延迟基准报表</h1>'
    + `<p class="sub">样本 ${escapeHtml(fmtInt(agg.total))} 条 · 干净样本 ${escapeHtml(fmtInt(agg.clean.length))} 条 · `
    + `时间跨度 ${escapeHtml(spanStart ? spanStart.date : '—')} → ${escapeHtml(spanEnd ? spanEnd.date : '—')}（上海时） · `
    + `生成于 ${escapeHtml(meta.generatedAt)}</p>`
    + `<nav class="toc">${TOC.map(([id, label]) => `<a href="#${id}">${escapeHtml(label)}</a>`).join('')}</nav>`
    + '</header>';

  if (agg.total === 0) {
    return head + header
      + section('credibility', '0. 数据可信度', '',
        banner('err', `在 ${meta.resultsDir} 下没有读到任何采样记录${meta.since ? `（--since ${meta.since} 之后）` : ''}。先跑 node src/run-round.js 采一轮再来。`))
      + renderFooter(meta)
      + '</div></body></html>';
  }

  const body = [
    sectionCredibility(agg, meta),
    sectionOverview(agg),
    sectionHeatmap(agg),
    sectionHourlyLines(agg),
    sectionBaseline(agg),
    sectionImageDelta(agg),
    sectionConnMode(agg),
    sectionArkFast(agg),
    sectionFailures(agg),
    sectionCost(agg),
    sectionRaw(agg, meta),
  ].join('');

  return head + header + body + renderFooter(meta) + '</div></body></html>';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: 'report.html', results: 'results', since: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const key = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : null;
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      return argv[i];
    };
    if (key === '--out' || key === '-o') args.out = takeValue();
    else if (key === '--results' || key === '-r') args.results = takeValue();
    else if (key === '--since') args.since = takeValue();
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (args.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error('--since 必须是 YYYY-MM-DD');
  }
  if (!args.out || !args.results) throw new Error('--out 与 --results 不能为空');
  return args;
}

const USAGE = [
  '用法: node src/report.js [选项]',
  '',
  '  --out <file>        输出 HTML 路径（默认 report.html）',
  '  --results <dir>     采样结果目录（默认 results，递归扫 *.jsonl）',
  '  --since YYYY-MM-DD  只统计该 UTC 日期（含）之后的样本',
  '  -h, --help          显示本帮助',
].join('\n');

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exit(1);
    return;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const resultsDir = path.resolve(process.cwd(), args.results);
  const files = findJsonlFiles(resultsDir);
  const loaded = loadSamples(files, args.since);
  const outPath = path.resolve(process.cwd(), args.out);

  const html = buildReport(loaded.samples, {
    generatedAt: new Date().toISOString(),
    resultsDir,
    since: args.since,
    fileCount: files.length,
    contributingCount: loaded.contributing.length,
    badLines: loaded.badLines,
    skippedBySince: loaded.skippedBySince,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  process.stdout.write(
    `报表已生成：${outPath}\n`
    + `  数据目录 ${resultsDir}\n`
    + `  JSONL 文件 ${files.length} 个，样本 ${loaded.samples.length} 条`
    + (loaded.badLines > 0 ? `，解析失败 ${loaded.badLines} 行` : '')
    + (loaded.skippedBySince > 0 ? `，因 --since 跳过 ${loaded.skippedBySince} 条` : '')
    + '\n',
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  aggregate,
  percentile,
  median,
  p95,
  maxOf,
  sumOf,
  collect,
  burstMedians,
  hourBuckets,
  shanghaiHour,
  shanghaiParts,
  escapeHtml,
  isTimingUsable,
  findJsonlFiles,
  loadSamples,
  parseArgs,
  niceTicks,
  renderHeatmap,
  renderHourLineChart,
  renderTable,
};
