'use strict';

const { pickNumber } = require('./siliconflow');

const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const MODELS_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/models';

/**
 * 火山方舟（豆包）。OpenAI 兼容，但有四个必须照顾到的差异：
 *
 * 1. 思考默认是**开**的。doubao-seed-2-0-mini 支持 enabled/disabled（不支持 auto），
 *    不显式关掉的话每次都走深度思考，延迟和 token 都会暴涨，跨时段曲线会被
 *    思维链长度的随机波动完全淹没。写法是顶层 thinking:{type:'disabled'}。
 *
 * 2. service_tier 默认是 auto，不是 default。想要一条干净的「常规」基线必须显式传
 *    'default'，否则账号若有 TPM 保障包，实际档位会变成 scale。
 *
 * 3. **低延迟不生效时不报错，只静默降级。** 配额不足、斜率超限、突发流量保护都会让
 *    service_tier:'fast' 的请求悄悄走常规通道，错误码表里没有任何 fast 专属错误。
 *    唯一的判据是响应体顶层的 service_tier 字段（fast / default / scale）。
 *    不读这个字段，fast 组的数据里就会混进一堆被降级的样本，得出「fast 没用」的错误结论。
 *
 * 4. frequency_penalty / presence_penalty 在 doubao-seed-1.8 及后续系列是**不支持**字段，
 *    结构化输出文档还两次警告不要与它们同用。很多 OpenAI 兼容客户端会默认塞
 *    frequency_penalty:0——这里绝不能出现这两个字段。
 */
function buildRequest({ config, apiKey, messages, maxTokens, includeResponseFormat }) {
  const body = {
    model: config.model,
    stream: true,
    // 火山流式默认不返回 usage（返回 null），必须显式开。
    stream_options: { include_usage: true },
    temperature: 0.1,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    service_tier: config.serviceTier || 'default',
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.userContent },
    ],
  };

  // json_object 模式硬性要求输入里出现字符串「json」，否则该模式直接不生效。
  // 提示词里刻意留了小写的「json」，这里只做断言，不悄悄改提示词。
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
 * service_tier 在流式响应的哪一帧出现，官方文档没写明。
 * 所以从头到尾扫所有事件，取第一个非空值，而不是只看首帧。
 */
function extractResult({ sse }) {
  const events = (sse && sse.events) || [];
  const firstEvent = events[0] || null;

  let serviceTierActual = null;
  let modelFallback = null;
  for (const event of events) {
    if (!serviceTierActual && typeof event.service_tier === 'string') {
      serviceTierActual = event.service_tier;
    }
    if (!modelFallback && event.service_status && event.service_status.model_fallback) {
      modelFallback = event.service_status.model_fallback;
    }
  }

  return {
    modelReturned: firstEvent ? firstEvent.model || null : null,
    upstreamId: firstEvent ? firstEvent.id || null : null,
    usage: normalizeUsage(sse && sse.usage),
    serviceTierActual,
    // model_fallback 描述的是**模型**降级（换了别的模型），不是 fast→default 的档位降级。
    // 单独带出来供报表核对，绝不能拿它当档位判据。
    modelFallback,
    providerSelected: null,
    orAttempt: null,
  };
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const completionDetails = usage.completion_tokens_details || {};
  const promptDetails = usage.prompt_tokens_details || {};

  return {
    promptTokens: pickNumber(usage.prompt_tokens),
    completionTokens: pickNumber(usage.completion_tokens),
    totalTokens: pickNumber(usage.total_tokens),
    reasoningTokens: pickNumber(completionDetails.reasoning_tokens),
    cachedTokens: pickNumber(promptDetails.cached_tokens),
    cost: null,
  };
}

module.exports = { buildRequest, extractResult, ENDPOINT, MODELS_ENDPOINT };
