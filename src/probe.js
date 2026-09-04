'use strict';

const { getProvider } = require('./providers');
const { timedPost } = require('./lib/http-timing');
const { blankSample, deriveMetrics, ERROR_CLASS, TASK } = require('./lib/schema');
const { computeCost, PRICE_SNAPSHOT_DATE, MAX_TOKENS, TIMEOUTS } = require('./config');
const { buildMessages } = require('./payloads');

/** 空载对照只需要模型吐两个字符，给 16 就够；给多了会让这组基线本身变慢。 */
const CONTROL_MAX_TOKENS = 16;

/**
 * 跑一次采样，返回一条完整的记录。
 *
 * 无论成功失败都返回一条记录——只落成功样本会造成幸存者偏差：
 * 把最慢的那些都删掉，看起来反而更快了。
 */
async function probe(options) {
  const {
    config,
    apiKey,
    task,
    connMode,
    agent,
    promptPack,
    promptHash,
    nonce,
    image,
    runContext,
    egress,
    roundId,
    burstId,
    attemptIndex,
    scheduleDriftMs,
  } = options;

  const provider = getProvider(config.platform);
  const isControl = task === TASK.CONTROL;
  const maxTokens = isControl ? CONTROL_MAX_TOKENS : MAX_TOKENS;

  const messages = buildMessages({ task, pack: promptPack, nonce, image });

  const request = provider.buildRequest({
    config,
    apiKey,
    messages,
    maxTokens,
    // 对照组不加 response_format：它只要求模型回两个字符，
    // 强制 JSON 会改变解码路径，让基线不再是「最轻的一次往返」。
    includeResponseFormat: !isControl,
  });

  // ⚠️ 必须在计时开始之前序列化完。JSON.stringify 一个几百 KB 的 base64 图片
  // 要几毫秒到几十毫秒，放在 t0 之后做就会被算进「网络时间」。
  const bodyBuffer = Buffer.from(JSON.stringify(request.body), 'utf8');

  const sample = blankSample();
  Object.assign(sample, {
    run_id: runContext.runId,
    round_id: roundId,
    burst_id: burstId,
    attempt_index: attemptIndex,
    config_id: config.id,
    platform: config.platform,
    task,
    conn_mode: connMode,
    ts_wall_utc: new Date().toISOString(),
    schedule_drift_ms: scheduleDriftMs,

    model_requested: config.model,
    request_body_bytes: bodyBuffer.length,
    image_fixture: image ? image.fileName : null,
    image_bytes: image ? image.bytes : null,
    image_b64_bytes: image ? image.b64Bytes : null,
    // 三家默认都按 high 处理，我们没有显式传 detail，所以记成 default 而不是编一个 'high'。
    image_detail: image ? 'default' : null,
    prompt_pack: promptPack.name,
    prompt_hash: promptHash,
    prompt_chars: messages.system.length,
    max_tokens_requested: maxTokens,
    nonce,

    service_tier_requested: config.serviceTier || null,
    provider_requested: config.providerOnly ? config.providerOnly.join(',') : null,

    node_label: runContext.nodeLabel,
    egress_ip: egress.ip,
    egress_geo: egress.geo,
    runner_os: runContext.runnerOs,

    currency: config.pricing ? config.pricing.currency : null,
    price_snapshot_date: PRICE_SNAPSHOT_DATE,
  });

  const response = await timedPost({
    url: request.url,
    headers: request.headers,
    body: bodyBuffer,
    agent,
    stream: true,
    timeouts: TIMEOUTS,
  });

  Object.assign(sample, response.timing);
  sample.tls_version = response.tlsVersion;

  if (response.http) {
    sample.http_status = response.http.status;
    sample.http_version = response.http.httpVersion;
  }

  if (!response.ok) {
    sample.ok = false;
    sample.error_class = response.error ? response.error.class : ERROR_CLASS.ABORTED;
    sample.error_message = sanitizeError(response.error ? response.error.message : null);
    return deriveMetrics(sample);
  }

  const extracted = provider.extractResult(response);
  const sse = response.sse;

  sample.model_returned = extracted.modelReturned;
  sample.upstream_id = extracted.upstreamId;
  sample.service_tier_actual = extracted.serviceTierActual;
  sample.provider_selected = extracted.providerSelected;
  sample.or_attempt = extracted.orAttempt;

  if (sse) {
    sample.t_ttft_ms = sse.t_ttft_ms;
    sample.t_ttfrt_ms = sse.t_ttfrt_ms;
    sample.completion_chunks = sse.chunks;
    sample.content_chars = sse.contentChars;
    sample.finish_reason = sse.finishReason;
  }

  const usage = extracted.usage;
  if (usage) {
    sample.prompt_tokens = usage.promptTokens;
    sample.completion_tokens = usage.completionTokens;
    sample.total_tokens = usage.totalTokens;
    sample.reasoning_tokens = usage.reasoningTokens;
    sample.cached_tokens = usage.cachedTokens;

    sample.cost_total = typeof usage.cost === 'number'
      ? usage.cost // OpenRouter 直接给实际扣费，比按单价反推准确
      : computeCost(config.pricing, usage.promptTokens, usage.completionTokens);
  }

  // reasoning_tokens 拿不到（平台不报这个字段）与「确认是 0」是两回事，不能混。
  // 拿不到时用「流里一个思考 token 都没出现」作为退化证据，仍然记 0；
  // 连流都没解析出来就保持 null，让 isCleanSample 把这条排除掉。
  if (sample.reasoning_tokens === null && sse) {
    sample.reasoning_tokens = sse.t_ttfrt_ms === null && sse.reasoningChars === 0 ? 0 : null;
  }

  // HTTP 200 不等于这次推理成功：OpenAI 兼容的流会在 200 的 body 里发 {"error":{...}}
  // 或 finish_reason:"error" 来报推理阶段的失败。这类响应结束得很快，
  // 当成功样本收进去会系统性拉低 P50——错得隐蔽，方向还刚好是「看起来更快」。
  if (sse && sse.streamError) {
    sample.ok = false;
    sample.error_class = ERROR_CLASS.HTTP_5XX;
    sample.error_message = sanitizeError(`SSE 流内报错：${sse.streamError}`);
    return deriveMetrics(sample);
  }

  // 只有实际拿到了流内容才算成功。HTTP 200 但一个 token 都没出（例如上游立刻断流），
  // 记成 parse 失败而不是一条「极快」的样本。
  const gotContent = Boolean(sse && sse.contentChars > 0);
  if (!gotContent) {
    sample.ok = false;
    sample.error_class = ERROR_CLASS.PARSE;
    sample.error_message = `响应 200 但未解析到任何正文内容（chunks=${sse ? sse.chunks : 0}）`;
    return deriveMetrics(sample);
  }

  sample.ok = true;
  sample.error_class = ERROR_CLASS.OK;
  return deriveMetrics(sample);
}

/**
 * 错误信息脱敏。上游报错正文里可能带回请求内容，
 * 而这个仓库是公开的、results/ 会被 commit 上去。
 */
function sanitizeError(message) {
  if (!message) return null;
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/***')
    .slice(0, 300);
}

module.exports = { probe, sanitizeError, CONTROL_MAX_TOKENS };
