'use strict';

const ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.siliconflow.cn/v1/models';

/**
 * 硅基流动（国内站）。OpenAI 兼容。
 *
 * 平台特有的两点：
 * 1. 关思考走请求体**顶层**的 enable_thinking:false。官方 API 参考把它列为顶层可选参数；
 *    文档里出现的 extra_body 只是 OpenAI Python SDK 用来注入非标准顶层字段的机制，
 *    在 HTTP 线格式上等价于顶层字段。生产代码 structure-ingredients.js 也是展开到顶层的。
 * 2. stream_options.include_usage 没有出现在官方 API 参考里，只是 OpenAI 兼容惯例。
 *    我们照发，但绝不假定它一定生效——usage 拿不到时 usage 相关字段保持 null，
 *    由报表标出「该平台流式下拿不到 token 数」，而不是编一个数出来。
 */
function buildRequest({ config, apiKey, messages, maxTokens, includeResponseFormat }) {
  const body = {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.1,
    max_tokens: maxTokens,
    enable_thinking: false,
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.userContent },
    ],
  };

  if (includeResponseFormat) {
    body.response_format = { type: 'json_object' };
  }

  return {
    url: ENDPOINT,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body,
  };
}

/**
 * 从流式结果里抽取平台字段。
 * usage 的 cached_tokens 有两种写法（OpenAI 风格的嵌套字段和 DeepSeek 风格的平铺字段），
 * 两个都认，取到哪个算哪个。
 */
function extractResult({ sse }) {
  const usage = (sse && sse.usage) || null;
  const firstEvent = sse && sse.events && sse.events[0];

  return {
    modelReturned: firstEvent ? firstEvent.model || null : null,
    upstreamId: firstEvent ? firstEvent.id || null : null,
    usage: normalizeUsage(usage),
    serviceTierActual: null,
    providerSelected: null,
    orAttempt: null,
  };
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const details = usage.completion_tokens_details || {};
  const promptDetails = usage.prompt_tokens_details || {};

  const cached = pickNumber(promptDetails.cached_tokens, usage.prompt_cache_hit_tokens);

  return {
    promptTokens: pickNumber(usage.prompt_tokens),
    completionTokens: pickNumber(usage.completion_tokens),
    totalTokens: pickNumber(usage.total_tokens),
    reasoningTokens: pickNumber(details.reasoning_tokens),
    cachedTokens: cached,
    cost: null,
  };
}

/**
 * 只接受真正的数字。
 * 不能用 Number(x) 判空：Number(null) 和 Number('') 都是 0，会把「没这个字段」
 * 写成一个看起来合理的 0，后续统计全被污染。
 */
function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

module.exports = { buildRequest, extractResult, ENDPOINT, MODELS_ENDPOINT, pickNumber };
