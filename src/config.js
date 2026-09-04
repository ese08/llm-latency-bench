'use strict';

const { CONN_MODE, TASK } = require('./lib/schema');

/**
 * 被测配置矩阵与定价快照。
 *
 * 定价随时会变。price_snapshot_date 是每条样本的必填列，报表按它分组；
 * 一周数据里如果中途调价而报表用的是单一价格，成本结论就是错的。
 * 跑完一轮长测后请重新核对一遍单价再算总成本。
 */

const PRICE_SNAPSHOT_DATE = '2026-09-04';

/**
 * 每个配置的 max_tokens 统一压到 256。
 *
 * 理由：max_tokens 只是上限、并不能真正固定输出长度（模型可能提前 stop，
 * 公有云 API 也不提供 vLLM 那种 --ignore-eos），所以主指标用的是与输出长度
 * 无关的 TTFT / TPOT；把上限压小只是为了控制成本和降低「某次多写几十个字」
 * 对 E2E 的干扰。任何 finish_reason='length' 的样本会在报表里单独标注。
 */
const MAX_TOKENS = 256;

/** 火山方舟按输入长度分档。我们的请求都远小于 32k，但仍按官方档位实现，避免以后改大了算错。 */
const ARK_MINI_TIERS_NORMAL = [
  { maxInputTokens: 32 * 1024, inPerM: 0.2, outPerM: 2.0 },
  { maxInputTokens: 128 * 1024, inPerM: 0.4, outPerM: 4.0 },
  { maxInputTokens: Infinity, inPerM: 0.8, outPerM: 8.0 },
];

/** 低延迟档位对 doubao-seed-2-0-mini 是常规的整 2 倍（逐档核对过，其它模型不是这个倍数）。 */
const ARK_MINI_TIERS_FAST = ARK_MINI_TIERS_NORMAL.map((tier) => ({
  maxInputTokens: tier.maxInputTokens,
  inPerM: tier.inPerM * 2,
  outPerM: tier.outPerM * 2,
}));

/**
 * 配置矩阵。
 *
 * pricing.confidence 说明这条价格有多可靠：
 *   confirmed  = 官方定价页逐档核对过
 *   unverified = 查不到官方数字，成本列会算但报表会打问号
 * 别把 unverified 的成本数字当决策依据。
 */
const CONFIGS = [
  {
    id: 'sf-qwen35-9b',
    label: '硅基·Qwen3.5-9B（当前生产）',
    platform: 'siliconflow',
    model: 'Qwen/Qwen3.5-9B',
    envKey: 'SILICONFLOW_API_KEY',
    supportsImage: true,
    pricing: {
      kind: 'flat',
      currency: 'USD',
      inPerM: 0.10,
      outPerM: 0.15,
      confidence: 'confirmed',
      note: '国际站 siliconflow.com 定价页。国内站 .cn 的人民币单价未查到 9B 条目，见 README。',
    },
  },
  {
    id: 'sf-qwen35-4b',
    label: '硅基·Qwen3.5-4B',
    platform: 'siliconflow',
    model: 'Qwen/Qwen3.5-4B',
    envKey: 'SILICONFLOW_API_KEY',
    supportsImage: true,
    pricing: {
      kind: 'flat',
      currency: 'USD',
      inPerM: null,
      outPerM: null,
      confidence: 'unverified',
      note: '未在官方定价页查到该型号。preflight 会用 /v1/models 确认它是否真的可用；'
        + '单价请在控制台确认后填进来，否则该配置的 cost_total 恒为 null。',
    },
  },
  {
    id: 'ark-mini-default',
    label: '豆包·2.0-mini·常规',
    platform: 'ark',
    model: 'doubao-seed-2-0-mini-260428',
    envKey: 'ARK_API_KEY',
    supportsImage: true,
    // 显式传 default 而不是留默认值：默认是 auto，账号若有 TPM 保障包会走 scale 档，
    // 那样这条基线就不是「常规」了。
    serviceTier: 'default',
    pricing: {
      kind: 'tiered',
      currency: 'CNY',
      tiers: ARK_MINI_TIERS_NORMAL,
      confidence: 'confirmed',
      note: '官方模型价格页，2026-09-03 更新。',
    },
  },
  {
    id: 'ark-mini-fast',
    label: '豆包·2.0-mini·低延迟',
    platform: 'ark',
    model: 'doubao-seed-2-0-mini-260428',
    envKey: 'ARK_API_KEY',
    supportsImage: true,
    serviceTier: 'fast',
    pricing: {
      kind: 'tiered',
      currency: 'CNY',
      tiers: ARK_MINI_TIERS_FAST,
      confidence: 'confirmed',
      note: '低延迟单价 = 常规的 2 倍（对 mini 而言；pro 是 3 倍，别泛化）。',
    },
  },
  {
    id: 'or-deepinfra-9b',
    label: 'OpenRouter·Qwen3.5-9B@DeepInfra',
    platform: 'openrouter',
    model: 'qwen/qwen3.5-9b',
    envKey: 'OPENROUTER_API_KEY',
    supportsImage: true,
    // 带后缀的完整 slug 才精确命中截图里那个端点；裸 "deepinfra" 会匹配该供应商全部变体。
    providerOnly: ['deepinfra/bf16'],
    pricing: {
      kind: 'flat',
      currency: 'USD',
      inPerM: 0.10,
      outPerM: 0.15,
      confidence: 'confirmed',
      note: 'endpoints 接口返回的 deepinfra/bf16 单价。OpenRouter 的 usage.cost 会直接给出'
        + '实际扣费，可用时优先用它，这里的单价只作校验。',
    },
  },
];

/**
 * 采样计划。
 *
 * 每个「时间点 × 配置 × 任务 × 连接模式」采 3 次取中位数——单次采样噪声极大，
 * 单点数据画不出可信的小时级规律。
 */
const PLAN = {
  repeatsPerBurst: 3,
  /** burst 内两次请求的间隔。太密会被平台的斜率保护判成突增流量。 */
  intraBurstDelayMs: 3000,
  /** 不同配置之间的间隔。串行采样，避免同一事件循环里并发请求互相阻塞污染计时。 */
  interConfigDelayMs: 1500,
  /**
   * 采样时刻抖动。固定整点发请求会撞上全网大量定时任务，
   * 测出的「高峰」是整点效应而不是真实的小时规律。
   */
  jitterMaxMs: 60000,
  tasks: [TASK.CONTROL, TASK.TEXT, TASK.IMAGE],
  /**
   * 连接模式按轮次交替：偶数轮跑冷连接，奇数轮跑热连接。
   * 不用「先打一个 warmup 再计时」把冷启动藏掉——那恰好是用户感知最强的一段。
   */
  connModes: [CONN_MODE.COLD, CONN_MODE.WARM],
};

/** 三段超时。总超时给到 120s，远大于预期 P99，避免直接截断分布的尾巴。 */
const TIMEOUTS = {
  connectMs: 15000,
  ttfbMs: 60000,
  totalMs: 120000,
};

/**
 * 按输入 token 数选价格档并算成本。
 * 任何一个输入缺失就返回 null —— 绝不用 0 冒充「没算出来」。
 */
function computeCost(pricing, promptTokens, completionTokens) {
  if (!pricing) return null;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;

  let inPerM = null;
  let outPerM = null;

  if (pricing.kind === 'flat') {
    inPerM = pricing.inPerM;
    outPerM = pricing.outPerM;
  } else if (pricing.kind === 'tiered') {
    const tier = pricing.tiers.find((candidate) => promptTokens <= candidate.maxInputTokens);
    if (tier) {
      inPerM = tier.inPerM;
      outPerM = tier.outPerM;
    }
  }

  if (typeof inPerM !== 'number' || typeof outPerM !== 'number') return null;
  return (promptTokens * inPerM + completionTokens * outPerM) / 1e6;
}

function getConfig(id) {
  return CONFIGS.find((config) => config.id === id) || null;
}

/** 只返回环境变量里配了密钥的配置。缺哪个平台的 key 就跳过哪个，不让整轮失败。 */
function enabledConfigs(env) {
  return CONFIGS.filter((config) => Boolean(env[config.envKey]));
}

module.exports = {
  PRICE_SNAPSHOT_DATE,
  MAX_TOKENS,
  CONFIGS,
  PLAN,
  TIMEOUTS,
  computeCost,
  getConfig,
  enabledConfigs,
};
