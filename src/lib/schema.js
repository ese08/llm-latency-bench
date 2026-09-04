'use strict';

/**
 * 一条采样记录的**唯一权威定义**。所有 provider、报表、分析脚本都以这里为准。
 *
 * 设计约束（来自方法论调研，改动前请先读 README 的「已知陷阱」）：
 * - 所有耗时字段单位一律 **毫秒（浮点）**，来源必须是单调钟 process.hrtime.bigint()。
 *   ts_wall_utc 只用来打标签，绝不参与任何差值计算（一周长跑必然遇到 NTP 校时）。
 * - 未知值一律 null，**绝不写 0**。0 是一个有意义的测量结果（例如 reasoning_tokens=0
 *   表示「确认关掉了思考」），跟「没测到」是两回事。
 * - 失败样本同样要落一整行，靠 ok / error_class 区分。只统计成功样本会造成幸存者偏差
 *   （把最慢的都删了，看起来更快）。
 */

const SCHEMA_VERSION = 1;

/**
 * 失败分类。延迟分位数只用 ok 的样本算；这些类别各自单独计数，
 * 并列出一张可用率表。429 是「被限流」不是「慢」，必须跟超时分开。
 */
const ERROR_CLASS = {
  OK: 'ok',
  DNS: 'dns',                           // 域名解析失败
  CONNECT: 'connect',                   // TCP 连不上（含 ECONNREFUSED / ECONNRESET）
  TLS: 'tls',                           // TLS 握手失败
  TIMEOUT_CONNECT: 'timeout_connect',   // 连接阶段超时
  TIMEOUT_TTFB: 'timeout_ttfb',         // 请求发完了但迟迟等不到响应头
  TIMEOUT_TOTAL: 'timeout_total',       // 总耗时超时
  HTTP_4XX: 'http_4xx',
  HTTP_429: 'http_429',                 // 限流，单列
  HTTP_5XX: 'http_5xx',
  PROVIDER_UNAVAILABLE: 'provider_unavailable', // OpenRouter 锁死供应商后的 404
  PARSE: 'parse',                       // 响应拿到了但解不出预期结构
  ABORTED: 'aborted',
};

/** 任务类型。control_empty 是关键对照组，用来把网络基线从服务端处理里剥出来。 */
const TASK = {
  IMAGE: 'image_ingredients',
  TEXT: 'text_ingredients',
  CONTROL: 'control_empty',
};

/** 连接模式。cold 代表手机端冷启动/切网，warm 代表 Netlify 常驻容器。两者都要测。 */
const CONN_MODE = {
  COLD: 'cold',
  WARM: 'warm',
};

/**
 * 一条完整记录的字段清单。写成显式列表而不是靠 Object.keys 推断，
 * 是为了保证 JSONL 每行列顺序稳定、缺字段能被发现。
 */
const FIELDS = [
  // ---- 身份 ----
  'schema_version',
  'run_id',            // GitHub Actions 的 run id，本地跑时为 local-<单调序号>
  'round_id',          // 本轮开始时刻的 ISO 串，同一轮所有样本共享
  'burst_id',          // config_id + task + conn_mode + round_id，标识「同一组重复采样」
  'attempt_index',     // burst 内第几次重复（0 起）。三次都是正当样本，报表取该 burst 的中位数
  'is_retry',          // 失败后的重试样本。重试会破坏样本独立性，默认排除出主统计
  'conn_established',  // 本次请求是否真的新建了连接（t_tls_ms 非空）。
                       // conn_mode 是「意图」，这一列才是「证据」——warm 组里第一次请求
                       // 必然要建连接，分析时要靠它把真正复用连接的样本挑出来
  'config_id',
  'platform',          // siliconflow | ark | openrouter
  'task',              // TASK 之一
  'conn_mode',         // CONN_MODE 之一

  // ---- 时间戳 ----
  'ts_wall_utc',       // ISO 8601，只做标签
  'schedule_drift_ms', // 计划触发时刻 → 实际开始时刻。GH Actions 的 cron 抖动必须记下来

  // ---- 分段耗时（ms，单调钟）----
  't_dns_ms',
  't_tcp_ms',
  't_tls_ms',
  't_req_body_ms',     // 请求头写出 → 请求体写完（大 base64 图片才有意义，见 README 陷阱 1）
  't_ttfb_ms',         // 请求体写完 → 收到响应头
  't_ttfrt_ms',        // 请求开始 → 首个 reasoning token（关思考成功时应为 null）
  't_ttft_ms',         // 请求开始 → 首个正文 token（**含** DNS+TCP+TLS 握手）
  't_ttft_net_ms',     // 请求体写完 → 首个正文 token（**不含**握手），见 deriveMetrics 的说明
  't_e2e_ms',          // 请求开始 → 响应流结束
  't_wall_e2e_ms',     // 同一区间的墙钟对照。与 t_e2e_ms 偏离 >20% 的样本判废（休眠/校时）

  // ---- 派生指标 ----
  'tpot_ms',           // (t_e2e_ms - t_ttft_ms) / (completion_tokens - 1)
  'output_tps',        // completion_tokens / ((t_e2e_ms - t_ttft_ms)/1000)
  'e2e_norm_128_ms',   // t_ttft_ms + tpot_ms*128，消除输出长度差异后的可比 E2E
  'chars_per_second',  // content_chars / 生成秒数。跨 tokenizer 的交叉验证指标

  // ---- token 与成本 ----
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'reasoning_tokens',  // 必须为 0，否则说明关思考没生效，该样本不可比
  'cached_tokens',     // >0 说明命中前缀缓存，样本被污染
  'completion_chunks', // SSE chunk 数。chunk 级 ITL 只看抖动，不跨平台比
  'content_chars',
  'finish_reason',
  'cost_total',
  'currency',          // CNY | USD
  'price_snapshot_date',

  // ---- 请求特征 ----
  'model_requested',
  'model_returned',    // 与 requested 不一致要报警（平台悄悄换版本）
  'request_body_bytes',
  'image_fixture',     // 用了哪张图，轮换用
  'image_bytes',
  'image_b64_bytes',
  'image_detail',
  'prompt_pack',       // generic | production，报表里必须标明用的哪套提示词
  'prompt_hash',       // 提示词内容的短哈希，用于确认跨节点跨时段用的是同一套
  'prompt_chars',
  'max_tokens_requested',
  'nonce',             // 破缓存用的随机前缀，放在 system message **最前面**

  // ---- 平台特有 ----
  'service_tier_requested', // ark: fast | default
  'service_tier_actual',    // ark 响应体顶层字段。fast/default/scale，静默降级只能靠它发现
  'degraded',               // ark: requested=fast 但 actual!=fast
  'provider_requested',     // openrouter: deepinfra/bf16
  'provider_selected',      // openrouter: 实际命中的供应商显示名
  'or_attempt',             // openrouter: openrouter_metadata.attempt，>1 说明发生过重试
  'upstream_id',

  // ---- 观测环境（GH Actions 出口不受控，这几列是归因的前提）----
  'node_label',        // 人工标注的采集点名字，如 gha-us
  'egress_ip',
  'egress_geo',        // 形如 "US/Virginia/Ashburn"
  'runner_os',
  'http_version',      // h2 / http/1.1。混比会得出错误结论
  'tls_version',

  // ---- 结果 ----
  'ok',
  'error_class',
  'http_status',
  'error_message',     // 已截断且脱敏，绝不含 Authorization
  'cache_contaminated',
];

/** 所有字段先铺成 null，保证 JSONL 每行结构一致、下游不用做存在性判断。 */
function blankSample() {
  const sample = {};
  for (const field of FIELDS) sample[field] = null;
  sample.schema_version = SCHEMA_VERSION;
  return sample;
}

/**
 * 从 usage + 分段耗时算出派生指标。
 *
 * 刻意用类型判断而不是 Number() 判空：Number(null) 和 Number('') 都是 0，
 * 会把「没测到」写成一个看起来合理的 0，污染整张表。
 */
function deriveMetrics(sample) {
  const completion = sample.completion_tokens;
  const ttft = sample.t_ttft_ms;
  const e2e = sample.t_e2e_ms;

  const hasGenWindow = typeof ttft === 'number' && typeof e2e === 'number' && e2e > ttft;
  const genMs = hasGenWindow ? e2e - ttft : null;

  // TPOT 的分母是 N-1：第一个 token 已经算进 TTFT 了。
  if (hasGenWindow && typeof completion === 'number' && completion > 1) {
    sample.tpot_ms = genMs / (completion - 1);
    sample.output_tps = completion / (genMs / 1000);
  }

  if (genMs !== null && genMs > 0 && typeof sample.content_chars === 'number') {
    sample.chars_per_second = sample.content_chars / (genMs / 1000);
  }

  sample.cache_contaminated = typeof sample.cached_tokens === 'number' && sample.cached_tokens > 0;
  sample.conn_established = typeof sample.t_tls_ms === 'number';

  /**
   * 把 TTFT 换算到「请求体写完」这个起点，剥掉握手。
   *
   * 为什么必须有这一列：
   * 1. t_ttft_ms 从 t0 起算、含 DNS+TCP+TLS，而 t_ttfb_ms 从请求体写完起算、不含握手。
   *    拿业务的 t_ttft_ms 去减对照组的 t_ttfb_ms 做「网络基线扣除」，
   *    差值里会整整多出一次握手——而那一节存在的唯一目的就是把链路开销剥出去。
   *    更糟的是这个偏差按平台差一个数量级：美国 runner 到国内机房的握手是几百毫秒，
   *    到同在美国的 DeepInfra 只有几十毫秒，于是「国内平台服务端更慢」会被凭空放大。
   * 2. 冷/热连接的 t_ttft_ms 相差整整一次握手，混在同一个池子里算分位数，
   *    P50 正好落在双峰的分界点上。用这一列就没有双峰。
   *
   * 恒等式在两种模式下都精确成立：
   *   冷连接：dns+tcp+tls = t0→secureConnect，t_req_body_ms = secureConnect→reqFinish
   *   热连接：三段为 null（记 0），t_req_body_ms 本身就是 t0→reqFinish
   * 两者相加都等于 t0→reqFinish，减掉即得 reqFinish→首 token。
   */
  const handshakeMs = ['t_dns_ms', 't_tcp_ms', 't_tls_ms']
    .reduce((sum, key) => sum + (typeof sample[key] === 'number' ? sample[key] : 0), 0);
  if (typeof sample.t_ttft_ms === 'number' && typeof sample.t_req_body_ms === 'number') {
    sample.t_ttft_net_ms = sample.t_ttft_ms - handshakeMs - sample.t_req_body_ms;
  }

  // 归一化 E2E 用**净** TTFT。
  // 它的用途是「消除输出长度差异后跨平台/跨时段比较」，如果基底含握手，
  // 它就会跟同一张表里的净 TTFT 一列口径打架、并且同样出现冷热双峰。
  // 想看握手本身请用 t_ttft_ms 与 t_ttft_net_ms 之差，或直接看冷热对比那一节。
  const normBase = typeof sample.t_ttft_net_ms === 'number' ? sample.t_ttft_net_ms : ttft;
  if (typeof sample.tpot_ms === 'number' && typeof normBase === 'number') {
    sample.e2e_norm_128_ms = normBase + sample.tpot_ms * 128;
  }

  if (sample.service_tier_requested && sample.service_tier_actual) {
    sample.degraded = sample.service_tier_requested !== sample.service_tier_actual;
  }

  return sample;
}

/**
 * 判废规则：墙钟与单调钟偏离过大，说明进程跨越了系统休眠或 NTP 大幅校时，
 * 这条样本的所有耗时都不可信。
 */
function isClockSuspect(sample) {
  const mono = sample.t_e2e_ms;
  const wall = sample.t_wall_e2e_ms;
  if (typeof mono !== 'number' || typeof wall !== 'number' || mono <= 0) return false;
  return Math.abs(wall - mono) / mono > 0.2;
}

/**
 * 样本能否进入延迟主统计。任何一条不满足都只进可用率表，不进分位数。
 *
 * reasoning_tokens 必须**恒等于 0**：null 表示「没测到」，那说明我们没法证明思考真的关掉了，
 * 这种样本的延迟不可比。这是三家平台关思考写法各不相同、且都容易写错的直接后果。
 */
function isCleanSample(sample) {
  return sample.ok === true
    && sample.is_retry !== true
    && sample.cache_contaminated === false
    && sample.degraded !== true
    && hasKnownServiceTier(sample)
    && sample.reasoning_tokens === 0
    && !isClockSuspect(sample);
}

/**
 * 请求指定了档位，就必须能证明它真的跑在那个档位上。
 *
 * degraded 只在「requested 与 actual 都拿到了且不相等」时才为 true；actual 缺失时它是 null，
 * 光靠 `degraded !== true` 会把一批**根本无法确认档位**的样本当合格样本放进主统计。
 * 对火山的 fast/常规 对比来说这是致命的——低延迟不生效时是静默降级，
 * 响应体的 service_tier 字段是唯一判据，拿不到它就等于这条样本什么也证明不了。
 */
function hasKnownServiceTier(sample) {
  if (!sample.service_tier_requested) return true;
  return typeof sample.service_tier_actual === 'string' && sample.service_tier_actual !== '';
}

module.exports = {
  SCHEMA_VERSION,
  ERROR_CLASS,
  TASK,
  CONN_MODE,
  FIELDS,
  blankSample,
  deriveMetrics,
  isClockSuspect,
  isCleanSample,
  hasKnownServiceTier,
};
