'use strict';

const { pickNumber } = require('./siliconflow');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const ENDPOINTS_META = 'https://openrouter.ai/api/v1/models/qwen/qwen3.5-9b/endpoints';

/**
 * OpenRouter，锁定单一供应商。
 *
 * 三个非踩不可的坑：
 *
 * 1. **关思考只能用 reasoning:{effort:'none'}。**
 *    reasoning:{exclude:true} 和等价的 include_reasoning:false 的语义是「模型照常思考，
 *    只是不把思考过程返回给你」——不省 token、不省时间。用它做延迟压测会得到完全错误的结论。
 *    另外 reasoning:{enabled:false} 在文档里没有记载为关闭路径，别用。
 *    每条样本都要断言 reasoning_tokens === 0，不能只在开发时验一次。
 *
 * 2. **provider.only 必须配 allow_fallbacks:false。**
 *    allow_fallbacks 默认是 true，只写 only 仍可能在 DeepInfra 故障时把请求送到别处，
 *    数据被静默污染。order 是优先级不是白名单，也不能替代 only。
 *    slug 用带后缀的完整形式 deepinfra/bf16 才精确命中截图那个端点；
 *    裸 deepinfra 会匹配该供应商的全部变体。
 *
 * 3. **命中确认只能靠 openrouter_metadata。**
 *    现行 ChatResult schema 里没有顶层 provider 字段。必须显式发
 *    X-OpenRouter-Metadata: enabled，再读 openrouter_metadata。
 *    注意官方明写「缓存命中的响应永远不带 openrouter_metadata」，
 *    所以「没有 metadata」不等于失败，要单独归类。
 */
function buildRequest({ config, apiKey, messages, maxTokens, includeResponseFormat }) {
  const body = {
    model: config.model,
    stream: true,
    temperature: 0.1,
    max_tokens: maxTokens,
    reasoning: { effort: 'none' },
    provider: {
      only: config.providerOnly,
      allow_fallbacks: false,
    },
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.userContent },
    ],
  };

  if (includeResponseFormat) {
    body.response_format = { type: 'json_object' };
  }

  // stream_options:{include_usage:true} 在 OpenRouter 已废弃且无效果——usage 现在总是自动返回。
  // 跟火山方舟正好相反，别照抄。

  return {
    url: ENDPOINT,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-OpenRouter-Metadata': 'enabled',
    },
    body,
  };
}

function extractResult({ sse }) {
  const events = (sse && sse.events) || [];
  const firstEvent = events[0] || null;

  let metadata = null;
  for (const event of events) {
    if (!metadata && event.openrouter_metadata) metadata = event.openrouter_metadata;
  }

  let providerSelected = null;
  let orAttempt = null;
  if (metadata) {
    orAttempt = pickNumber(metadata.attempt);
    const available = (metadata.endpoints && metadata.endpoints.available) || [];
    const chosen = available.find((entry) => entry && entry.selected === true);
    if (chosen) providerSelected = chosen.provider || null;
  }

  return {
    modelReturned: firstEvent ? firstEvent.model || null : null,
    upstreamId: firstEvent ? firstEvent.id || null : null,
    usage: normalizeUsage(sse && sse.usage),
    serviceTierActual: firstEvent ? firstEvent.service_tier || null : null,
    providerSelected,
    orAttempt,
    // metadata 缺失有两种可能：缓存命中（官方明说缓存命中不带 metadata），
    // 或者请求头没被识别。两者都不代表失败，交给报表单独归类。
    metadataMissing: metadata === null,
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
    // OpenRouter 直接给出本次实际扣的 credits（美元），比按单价反推准确，优先用它。
    cost: pickNumber(usage.cost),
  };
}

module.exports = { buildRequest, extractResult, ENDPOINT, ENDPOINTS_META };
