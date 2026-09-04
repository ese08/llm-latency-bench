'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const { ERROR_CLASS } = require('./schema');

/**
 * 逐段计时的 HTTPS POST。
 *
 * 为什么用原生 node:https 而不是 fetch/undici：
 * undici 的连接类事件（beforeConnect / connected）是**按连接**发布的，连接池复用时
 * 无法把某次握手归因到某个具体请求，而且它不单独拆出 DNS 阶段。socket 的
 * lookup / connect / secureConnect 三个事件天然就是按连接的，配合「冷连接每次新建 agent」
 * 的用法，归因是确定的。
 *
 * 计时全程用 process.hrtime.bigint()（单调钟）。Date.now() 只在最外层取一次墙钟对照，
 * 用来在事后识别「进程跨越了系统休眠或 NTP 校时」的废样本。
 */

const NS_PER_MS = 1e6;

function nowNs() {
  return process.hrtime.bigint();
}

function msSince(startNs, endNs) {
  if (startNs === null || endNs === null) return null;
  return Number(endNs - startNs) / NS_PER_MS;
}

/**
 * 冷连接必须同时关掉 keep-alive 和 TLS 会话复用。
 * 只关 keepAlive 是不够的：TLS session resumption 即使新建 TCP 也能省掉完整握手，
 * 测出来的 t_tls_ms 会偏低一个 RTT。
 */
function makeColdAgent() {
  return new https.Agent({
    keepAlive: false,
    maxCachedSessions: 0,
    maxSockets: 1,
  });
}

function makeWarmAgent() {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
  });
}

/**
 * 从 OpenAI 兼容的 SSE 流里提取计时打点与内容。
 *
 * 三家平台的 delta 形状一致，差别只在思维链字段名：硅基/火山用 reasoning_content，
 * OpenRouter 用 reasoning。两个都认，任一非空都记为「首个思考 token」——
 * 关思考没生效时 t_ttfrt_ms 会非 null，这是主要的断言手段之一。
 */
function createSseParser(t0) {
  const state = {
    buffer: '',
    chunks: 0,
    content: '',
    reasoningChars: 0,
    usage: null,
    finishReason: null,
    firstContentNs: null,
    firstReasoningNs: null,
    firstEventNs: null,
    events: [],
    done: false,
    // OpenAI 兼容的 SSE 会在 HTTP 200 的流里发 {"error":{...}} 或 finish_reason:"error"
    // 来报告推理阶段的失败。不检查它的话，这类响应会被当成一条「很快就结束」的成功样本，
    // 系统性拉低 P50——错得既隐蔽又刚好朝着「看起来更快」的方向。
    streamError: null,
  };

  function feed(text) {
    state.buffer += text;
    // SSE 事件以空行分隔。留下最后一段不完整的等下一块。
    const parts = state.buffer.split('\n\n');
    state.buffer = parts.pop();

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          state.done = true;
          continue;
        }

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // 半个 JSON，跳过；完整的会在后续块里重新出现
        }

        const at = nowNs();
        if (state.firstEventNs === null) state.firstEventNs = at;
        state.chunks += 1;
        state.events.push(event);

        // usage 只在最后一帧出现（且需要平台侧开关），后到的覆盖先到的
        if (event.usage) state.usage = event.usage;

        if (event.error && !state.streamError) {
          state.streamError = typeof event.error === 'string'
            ? event.error
            : (event.error.message || JSON.stringify(event.error));
        }

        const delta = event.choices && event.choices[0] && event.choices[0].delta;
        const finish = event.choices && event.choices[0] && event.choices[0].finish_reason;
        if (finish) state.finishReason = finish;
        if (finish === 'error' && !state.streamError) {
          state.streamError = 'finish_reason=error';
        }
        if (!delta) continue;

        const reasoning = delta.reasoning_content || delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          if (state.firstReasoningNs === null) state.firstReasoningNs = at;
          state.reasoningChars += reasoning.length;
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (state.firstContentNs === null) state.firstContentNs = at;
          state.content += delta.content;
        }
      }
    }
  }

  return {
    feed,
    result() {
      return {
        chunks: state.chunks,
        content: state.content,
        contentChars: state.content.length,
        reasoningChars: state.reasoningChars,
        usage: state.usage,
        finishReason: state.finishReason,
        events: state.events,
        sawDone: state.done,
        streamError: state.streamError,
        t_ttft_ms: msSince(t0, state.firstContentNs),
        t_ttfrt_ms: msSince(t0, state.firstReasoningNs),
      };
    },
  };
}

function classifyNetworkError(err, phase) {
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return ERROR_CLASS.DNS;
  if (code === 'CERT_HAS_EXPIRED' || String(code || '').includes('TLS') || String(code || '').includes('SSL')) {
    return ERROR_CLASS.TLS;
  }
  if (phase === 'connect') return ERROR_CLASS.CONNECT;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return ERROR_CLASS.CONNECT;
  }
  return ERROR_CLASS.CONNECT;
}

function classifyHttpStatus(status) {
  if (status === 429) return ERROR_CLASS.HTTP_429;
  if (status >= 500) return ERROR_CLASS.HTTP_5XX;
  if (status >= 400) return ERROR_CLASS.HTTP_4XX;
  return ERROR_CLASS.OK;
}

/**
 * body 必须是**调用方预先序列化好的 Buffer**。
 * JSON.stringify 一个几百 KB 的 base64 图片会阻塞事件循环几十毫秒，
 * 在 t0 之后做就会被算进「网络时间」。
 */
async function timedPost({ url, headers, body, agent, stream, timeouts }) {
  const target = new URL(url);
  const limits = Object.assign({ connectMs: 15000, ttfbMs: 60000, totalMs: 120000 }, timeouts || {});

  return new Promise((resolve) => {
    const marks = {
      t0: null,
      lookup: null,
      connect: null,
      secureConnect: null,
      reqFinish: null,
      responseHead: null,
      end: null,
    };
    let phase = 'connect';
    let settled = false;
    let timer = null;
    let tlsVersion = null;
    let remoteAddress = null;

    const wallStart = Date.now();
    marks.t0 = nowNs();

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      marks.end = marks.end || nowNs();

      // 连接就绪时刻：复用连接时三个握手事件都不会触发，此时以 t0 为准。
      const connectReady = marks.secureConnect || marks.connect || marks.t0;

      const timing = {
        t_dns_ms: msSince(marks.t0, marks.lookup),
        t_tcp_ms: marks.connect ? msSince(marks.lookup || marks.t0, marks.connect) : null,
        t_tls_ms: marks.secureConnect ? msSince(marks.connect, marks.secureConnect) : null,
        t_req_body_ms: msSince(connectReady, marks.reqFinish),
        t_ttfb_ms: msSince(marks.reqFinish, marks.responseHead),
        t_e2e_ms: msSince(marks.t0, marks.end),
        t_wall_e2e_ms: Date.now() - wallStart,
      };

      resolve(Object.assign({ timing, tlsVersion, remoteAddress }, payload));
    }

    function fail(errorClass, message) {
      finish({
        ok: false,
        error: { class: errorClass, message: String(message || '').slice(0, 300) },
        http: null,
        sse: null,
        bodyText: null,
      });
    }

    // 分三段超时。总超时要设得足够宽（预期 P99 的 3 倍以上），
    // 否则会直接把分布的尾巴截掉，看起来比真实情况稳定。
    function armTimer(ms, errorClass, label) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { req.destroy(); } catch { /* 已经关了 */ }
        fail(errorClass, `${label} timeout after ${ms}ms`);
      }, ms);
      if (timer.unref) timer.unref();
    }

    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers),
      agent,
    });

    armTimer(limits.connectMs, ERROR_CLASS.TIMEOUT_CONNECT, 'connect');

    req.on('socket', (socket) => {
      // 复用的 socket 不会再触发这三个事件，对应字段保持 null —— 这正是我们想记录的事实。
      socket.on('lookup', () => { marks.lookup = nowNs(); });
      socket.on('connect', () => { marks.connect = nowNs(); });
      socket.on('secureConnect', () => {
        marks.secureConnect = nowNs();
        phase = 'request';
        try {
          tlsVersion = socket.getProtocol ? socket.getProtocol() : null;
          remoteAddress = socket.remoteAddress || null;
        } catch { /* 拿不到就算了，不影响主流程 */ }
        armTimer(limits.ttfbMs, ERROR_CLASS.TIMEOUT_TTFB, 'ttfb');
      });
    });

    req.on('finish', () => {
      marks.reqFinish = nowNs();
      phase = 'ttfb';
      // 连接复用时 secureConnect 不触发，超时窗口在这里补上。
      armTimer(limits.ttfbMs, ERROR_CLASS.TIMEOUT_TTFB, 'ttfb');
    });

    req.on('error', (err) => {
      fail(classifyNetworkError(err, phase), err.message);
    });

    req.on('response', (res) => {
      marks.responseHead = nowNs();
      phase = 'body';
      armTimer(limits.totalMs, ERROR_CLASS.TIMEOUT_TOTAL, 'total');

      const httpVersion = res.httpVersion;
      const status = res.statusCode;
      const resHeaders = res.headers;
      res.setEncoding('utf8');

      const parser = stream && status === 200 ? createSseParser(marks.t0) : null;
      let raw = '';

      res.on('data', (chunk) => {
        if (parser) parser.feed(chunk);
        // 非流式、或流式但出错时，都需要完整正文来解析结构 / 上报错误。
        // 流式成功路径下也保留原文，量不大（max_tokens 被压得很小），
        // 但要防御性截断，避免异常响应把内存吃满。
        if (!parser || status !== 200) {
          if (raw.length < 2 * 1024 * 1024) raw += chunk;
        }
      });

      res.on('end', () => {
        marks.end = nowNs();
        const httpErrorClass = classifyHttpStatus(status);
        finish({
          ok: httpErrorClass === ERROR_CLASS.OK,
          error: httpErrorClass === ERROR_CLASS.OK ? null : { class: httpErrorClass, message: raw.slice(0, 300) },
          http: { status, headers: resHeaders, httpVersion },
          sse: parser ? parser.result() : null,
          bodyText: raw || null,
        });
      });

      res.on('error', (err) => fail(ERROR_CLASS.CONNECT, err.message));
    });

    req.end(body);
  });
}

module.exports = {
  timedPost,
  makeColdAgent,
  makeWarmAgent,
  nowNs,
  msSince,
  classifyHttpStatus,
};
