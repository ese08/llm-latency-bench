'use strict';

const os = require('node:os');
const https = require('node:https');

/**
 * 采集点的环境信息。
 *
 * 这几个字段不是可有可无的元数据，而是**归因的前提**。GitHub Actions 托管 runner 的
 * 出口机房和 IP 每次运行都可能不同，官方也不保证地域。不把出口 IP 记下来，
 * 两次运行之间的延迟差异就无法区分是「服务端变慢」还是「这次换了个更远的机房」。
 */

const IP_LOOKUP_TIMEOUT_MS = 8000;

/**
 * 查出口 IP 与归属地。
 *
 * 用两个互不相干的服务做兜底：任何一个挂了都不该让整轮采样失败——
 * 拿不到就留 null，报表会把这批样本标成「出口未知」，而不是编一个值。
 */
const IP_SERVICES = [
  {
    url: 'https://api.ipify.org?format=json',
    parse: (json) => ({ ip: json.ip || null, geo: null }),
  },
  {
    url: 'https://ipinfo.io/json',
    parse: (json) => ({
      ip: json.ip || null,
      geo: [json.country, json.region, json.city].filter(Boolean).join('/') || null,
    }),
  },
];

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (raw.length < 64 * 1024) raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function detectEgress() {
  const result = { ip: null, geo: null };

  for (const service of IP_SERVICES) {
    const json = await fetchJson(service.url, IP_LOOKUP_TIMEOUT_MS);
    if (!json) continue;
    const parsed = service.parse(json);
    if (parsed.ip && !result.ip) result.ip = parsed.ip;
    if (parsed.geo && !result.geo) result.geo = parsed.geo;
    if (result.ip && result.geo) break;
  }

  return result;
}

/**
 * 一轮采样共享的运行上下文。
 *
 * run_id 优先用 GitHub Actions 的 run id + attempt——同一个 run 重跑时 attempt 会变，
 * 不加它两次重跑的样本会被当成同一批。
 */
function buildRunContext() {
  const githubRunId = process.env.GITHUB_RUN_ID;
  const githubAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';

  return {
    runId: githubRunId ? `gha-${githubRunId}-${githubAttempt}` : `local-${process.pid}`,
    nodeLabel: process.env.NODE_LABEL || (githubRunId ? 'gha-us' : 'local'),
    runnerOs: process.env.RUNNER_OS
      ? `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH || os.arch()}`
      : `${os.type()}/${os.arch()}`,
    nodeVersion: process.version,
  };
}

/**
 * cron 抖动。GitHub Actions 的 schedule 会延迟、高负载时甚至丢触发，
 * 所以分析必须用「实际开始时刻」而不是「计划时刻」，并把这个差值一起记下来——
 * 否则「那 40 分钟没数据」会被误读成正常。
 */
function computeScheduleDrift(actualStartMs) {
  const scheduledFor = process.env.SCHEDULED_FOR;
  if (!scheduledFor) return null;
  const scheduledMs = Date.parse(scheduledFor);
  if (!Number.isFinite(scheduledMs)) return null;
  return actualStartMs - scheduledMs;
}

module.exports = { detectEgress, buildRunContext, computeScheduleDrift };
