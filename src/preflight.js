'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const { probe } = require('./probe');
const { CONFIGS, enabledConfigs } = require('./config');
const { TASK, CONN_MODE } = require('./lib/schema');
const { makeColdAgent } = require('./lib/http-timing');
const { buildRunContext, detectEgress } = require('./lib/env');
const {
  loadPromptPack,
  shortHash,
  makeNonce,
  listFixtures,
  loadImageFixture,
} = require('./payloads');
const siliconflow = require('./providers/siliconflow');
const ark = require('./providers/ark');
const openrouter = require('./providers/openrouter');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const RESULTS_DIR = path.join(ROOT, 'results');

/**
 * 前置校验。
 *
 * 存在的理由：这套测试有一批**只能用真实请求回答**的未知数，靠读文档推不出来。
 * 在跑一周长测之前把它们一次性问清楚，比事后发现整批数据不可用要便宜得多：
 *
 *  - Qwen/Qwen3.5-9B 和 Qwen3.5-4B 到底在不在 api.siliconflow.cn 上
 *    （官方定价页和模型页都查不到这两个型号，但国际站有 9B）
 *  - 硅基流动的 stream_options.include_usage 有没有被支持（官方 API 参考里没有这个参数）
 *  - 多模态请求叠加 response_format:json_object 会不会被拒（JSON 模式指南把 VL 模型排除在外）
 *  - 三家的「关思考」写法是不是真的生效（唯一硬证据是 reasoning_tokens === 0）
 *  - 火山的 service_tier:'fast' 有没有被静默降级（配额不足时不报错，只降级）
 *  - OpenRouter 有没有真的锁在 DeepInfra 上，以及该端点收不收图片
 *
 * 任一 fail 都会让退出码非 0。warn 不阻断，但会写进报告。
 */

const HTTP_TIMEOUT_MS = 20000;

function httpGetJson(url, headers) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: Object.assign({ Accept: 'application/json' }, headers) }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (raw.length < 4 * 1024 * 1024) raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw: raw.slice(0, 300) });
        }
      });
    });
    req.on('error', (error) => resolve({ status: 0, json: null, raw: error.message }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: 0, json: null, raw: 'timeout' });
    });
  });
}

function check(name, status, detail) {
  return { name, status, detail };
}

/** 拉平台的模型清单，确认配置里写的 model 真实存在。 */
async function checkModelCatalog(platform, endpoint, apiKey, wantedModels) {
  const results = [];
  const response = await httpGetJson(endpoint, { Authorization: `Bearer ${apiKey}` });

  if (response.status !== 200 || !response.json) {
    results.push(check(
      `${platform}/模型清单`,
      'warn',
      `拉取失败（HTTP ${response.status}）：${response.raw || '无正文'}。`
      + '拿不到清单不阻断，后面的真实请求会给出更硬的答案。',
    ));
    return results;
  }

  const ids = Array.isArray(response.json.data)
    ? response.json.data.map((entry) => entry && entry.id).filter(Boolean)
    : [];

  results.push(check(`${platform}/模型清单`, 'pass', `共 ${ids.length} 个模型`));

  for (const model of wantedModels) {
    if (ids.includes(model)) {
      results.push(check(`${platform}/${model} 存在`, 'pass', '在 /v1/models 清单里'));
    } else {
      const similar = ids.filter((id) => id.toLowerCase().includes(model.split('/').pop().toLowerCase().slice(0, 6)));
      results.push(check(
        `${platform}/${model} 存在`,
        'fail',
        `不在 /v1/models 清单里。相近型号：${similar.slice(0, 8).join(', ') || '无'}`,
      ));
    }
  }

  return results;
}

/** OpenRouter 的端点元数据会变（供应商可能新增/下线变体），跑之前重拉一次做断言。 */
async function checkOpenRouterEndpoint(config) {
  const results = [];
  const response = await httpGetJson(openrouter.ENDPOINTS_META, {});

  if (response.status !== 200 || !response.json) {
    results.push(check('openrouter/端点清单', 'warn', `拉取失败（HTTP ${response.status}）`));
    return results;
  }

  const endpoints = (response.json.data && response.json.data.endpoints) || [];
  const wanted = config.providerOnly[0];
  const match = endpoints.find((entry) => entry && entry.tag === wanted);

  if (!match) {
    results.push(check(
      `openrouter/${wanted} 端点存在`,
      'fail',
      `当前端点列表：${endpoints.map((entry) => entry.tag).join(', ') || '空'}。`
      + '锁死的供应商变体不存在时，请求会直接 404 而不是降级。',
    ));
    return results;
  }

  results.push(check(
    `openrouter/${wanted} 端点存在`,
    'pass',
    `context=${match.context_length} max_completion=${match.max_completion_tokens} `
    + `价格 in=${match.pricing && match.pricing.prompt} out=${match.pricing && match.pricing.completion} `
    + `uptime_1d=${match.uptime_last_1d}`,
  ));

  // max_completion_tokens 比其它供应商低不少（截图端点是 81920，硅基/Parasail 是 235929）。
  // 压测的 max_tokens 只有 256，远低于上限，但配置改大了这里要能提前拦住。
  const { MAX_TOKENS } = require('./config');
  if (typeof match.max_completion_tokens === 'number' && match.max_completion_tokens < MAX_TOKENS) {
    results.push(check(
      'openrouter/max_tokens 兼容',
      'fail',
      `该端点 max_completion_tokens=${match.max_completion_tokens}，小于配置的 ${MAX_TOKENS}`,
    ));
  }

  if (typeof match.uptime_last_1d === 'number' && match.uptime_last_1d < 97) {
    results.push(check(
      'openrouter/端点可用率',
      'warn',
      `uptime_last_1d=${match.uptime_last_1d}%。锁死供应商 + 禁 fallback 意味着这部分会直接变成 404 失败样本，`
      + '报表必须单独出可用率曲线，不能只统计成功样本。',
    ));
  }

  return results;
}

/** 用一次真实请求验证一个配置。这是最硬的证据来源。 */
async function checkConfigLive(config, task, shared) {
  const label = `${config.id}/${task}`;
  const results = [];
  const agent = makeColdAgent();

  let sample;
  try {
    sample = await probe({
      config,
      apiKey: process.env[config.envKey],
      task,
      connMode: CONN_MODE.COLD,
      agent,
      promptPack: shared.promptPack,
      promptHash: shared.promptHash,
      nonce: makeNonce(),
      image: task === TASK.IMAGE ? shared.image : null,
      runContext: shared.runContext,
      egress: shared.egress,
      roundId: shared.roundId,
      burstId: `preflight|${config.id}|${task}`,
      attemptIndex: 0,
      scheduleDriftMs: null,
    });
  } finally {
    agent.destroy();
  }

  if (sample.ok !== true) {
    results.push(check(label, 'fail', `${sample.error_class}（HTTP ${sample.http_status}）：${sample.error_message}`));
    return { results, sample };
  }

  results.push(check(
    label,
    'pass',
    `TTFT=${fmt(sample.t_ttft_ms)}ms E2E=${fmt(sample.t_e2e_ms)}ms `
    + `tokens=${sample.prompt_tokens}/${sample.completion_tokens} http=${sample.http_version} tls=${sample.tls_version}`,
  ));

  // ── 关思考是否真的生效 ──
  // 这是三家写法各不相同、且最容易写错的一处。OpenRouter 尤其危险：
  // reasoning:{exclude:true} 只是不返回思考过程，模型照样思考照样计时。
  if (sample.reasoning_tokens === 0) {
    results.push(check(`${label}/思考已关闭`, 'pass', 'reasoning_tokens=0'));
  } else if (sample.reasoning_tokens === null) {
    results.push(check(
      `${label}/思考已关闭`,
      'warn',
      '拿不到 reasoning_tokens，无法证明思考真的关掉了。这类样本会被 isCleanSample 排除，'
      + '等于该配置采不到有效数据——请先解决 usage 的获取问题。',
    ));
  } else {
    results.push(check(
      `${label}/思考已关闭`,
      'fail',
      `reasoning_tokens=${sample.reasoning_tokens}，关思考没生效。延迟数据会被思维链长度的随机波动淹没。`,
    ));
  }

  // ── usage 拿不拿得到 ──
  if (sample.prompt_tokens === null || sample.completion_tokens === null) {
    results.push(check(
      `${label}/流式 usage`,
      'fail',
      '流式响应里没拿到 usage。TPOT、output_tps 和成本都算不出来。'
      + '硅基流动的 stream_options.include_usage 不在官方 API 参考里，如果是它，需要改用非流式或另想办法。',
    ));
  }

  // ── 火山：fast 有没有被静默降级 ──
  if (config.platform === 'ark') {
    if (!sample.service_tier_actual) {
      results.push(check(
        `${label}/service_tier 可见`,
        'fail',
        '响应里没有 service_tier 字段，无法判断本次走的是 fast 还是常规。'
        + '低延迟不生效时不报错、只静默降级，没有这个字段整个 fast/常规 对比就不成立。',
      ));
    } else if (sample.service_tier_requested === 'fast' && sample.service_tier_actual !== 'fast') {
      results.push(check(
        `${label}/低延迟生效`,
        'fail',
        `请求 fast，实际走了 ${sample.service_tier_actual}。请到控制台「开通管理」页开通该模型服务，`
        + '并打开对应模型的「低延迟」列开关；已开通的话检查低延迟 TPM 配额。',
      ));
    } else {
      results.push(check(`${label}/档位`, 'pass', `service_tier=${sample.service_tier_actual}`));
    }
  }

  // ── OpenRouter：有没有真的锁在 DeepInfra ──
  if (config.platform === 'openrouter') {
    if (sample.provider_selected === null) {
      results.push(check(
        `${label}/供应商确认`,
        'warn',
        '响应里没有 openrouter_metadata。官方明说缓存命中的响应永远不带 metadata，'
        + '所以这不一定是失败；但也意味着这一条无法确认走的是哪个供应商。',
      ));
    } else if (!/deepinfra/i.test(sample.provider_selected)) {
      results.push(check(
        `${label}/供应商确认`,
        'fail',
        `实际命中 ${sample.provider_selected}，不是 DeepInfra。检查 provider.only 与 allow_fallbacks:false。`,
      ));
    } else {
      results.push(check(
        `${label}/供应商确认`,
        'pass',
        `${sample.provider_selected}（attempt=${sample.or_attempt}）`,
      ));
    }

    if (typeof sample.or_attempt === 'number' && sample.or_attempt > 1) {
      results.push(check(
        `${label}/无重试`,
        'warn',
        `attempt=${sample.or_attempt}，本次发生过重试/回退，这类样本不可比。`,
      ));
    }
  }

  // ── 模型版本漂移 ──
  if (sample.model_returned && !sample.model_returned.includes(config.model.split('/').pop().split('-')[0])) {
    results.push(check(
      `${label}/模型一致`,
      'warn',
      `请求 ${config.model}，返回 ${sample.model_returned}。平台可能换了版本，跨时段数据会不可比。`,
    ));
  }

  if (sample.cache_contaminated) {
    results.push(check(
      `${label}/缓存`,
      'warn',
      `cached_tokens=${sample.cached_tokens}，本次命中了前缀缓存。nonce 应该拼在 system 最前面；`
      + '若持续命中，需要加大 nonce 长度或轮换图片。',
    ));
  }

  return { results, sample };
}

function fmt(value) {
  return typeof value === 'number' ? Math.round(value) : '—';
}

async function preflight() {
  const runContext = buildRunContext();
  const promptPack = loadPromptPack();
  const promptHash = shortHash(`${promptPack.image}\n${promptPack.text}`);
  const egress = await detectEgress();
  const fixtures = listFixtures(FIXTURES_DIR);
  const image = fixtures.length ? loadImageFixture(FIXTURES_DIR, fixtures[0]) : null;
  const roundId = new Date().toISOString();

  const shared = { promptPack, promptHash, egress, runContext, roundId, image };
  const all = [];

  console.log(`前置校验开始  节点=${runContext.nodeLabel}  出口=${egress.ip || '未知'} ${egress.geo || ''}`);
  console.log(`提示词=${promptPack.name}(${promptHash})  素材=${fixtures.length} 张\n`);

  if (!image) {
    all.push(check('fixtures', 'warn', 'fixtures/ 下没有 jpg，图片任务会被整轮跳过。见 fixtures/README.md。'));
  }

  const active = enabledConfigs(process.env);
  const missing = CONFIGS.filter((config) => !active.includes(config));
  for (const config of missing) {
    all.push(check(config.id, 'skip', `缺少环境变量 ${config.envKey}`));
  }

  // 先查模型清单：模型压根不存在的话，后面的真实请求只会报一个不好读的 4xx。
  if (process.env.SILICONFLOW_API_KEY) {
    const wanted = active.filter((c) => c.platform === 'siliconflow').map((c) => c.model);
    all.push(...await checkModelCatalog('siliconflow', siliconflow.MODELS_ENDPOINT, process.env.SILICONFLOW_API_KEY, wanted));
  }
  if (process.env.ARK_API_KEY) {
    const wanted = [...new Set(active.filter((c) => c.platform === 'ark').map((c) => c.model))];
    all.push(...await checkModelCatalog('ark', ark.MODELS_ENDPOINT, process.env.ARK_API_KEY, wanted));
  }
  const orConfig = active.find((config) => config.platform === 'openrouter');
  if (orConfig) {
    all.push(...await checkOpenRouterEndpoint(orConfig));
  }

  // 真实请求：文本任务人人都跑；图片任务只在有素材时跑（它同时验证多模态 + json_object 组合）。
  for (const config of active) {
    const textResult = await checkConfigLive(config, TASK.TEXT, shared);
    all.push(...textResult.results);

    if (image && config.supportsImage) {
      const imageResult = await checkConfigLive(config, TASK.IMAGE, shared);
      all.push(...imageResult.results);
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  const icons = { pass: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

  console.log('');
  for (const item of all) {
    counts[item.status] += 1;
    console.log(`${icons[item.status]} ${item.name}\n     ${item.detail}`);
  }

  console.log(`\n汇总：通过 ${counts.pass} / 警告 ${counts.warn} / 失败 ${counts.fail} / 跳过 ${counts.skip}`);

  // 一个配置都没启用，等于什么都没校验。这不是「通过」，是「没得校验」——
  // 必须算硬失败，否则 CI 会把它当成校验过了。
  if (active.length === 0) {
    all.push(check(
      '可用配置',
      'fail',
      '一个平台的 API Key 都没配上，这次校验实际上什么都没验。请检查 '
      + 'SILICONFLOW_API_KEY / ARK_API_KEY / OPENROUTER_API_KEY 是否已设为 repository secret。',
    ));
    counts.fail += 1;
    console.log('❌ 可用配置\n     一个平台的 API Key 都没配上，这次校验实际上什么都没验。');
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // 文件名区分 ok / fail 是有意的：probe.yml 靠「存在 preflight-ok-*.json」判断
  // 是否已经校验过、可以直接采样。如果失败的报告也叫同一个名字，那么首次 CI 跑因为
  // secret 配错而失败之后，这份没用的报告会被 commit 上去，从此**永久跳过** preflight，
  // 而每一轮采样都会以同样的原因失败，且没人再看得到原因。
  const verdict = counts.fail > 0 ? 'fail' : 'ok';
  const outPath = path.join(RESULTS_DIR, `preflight-${verdict}-${roundId.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    at: roundId,
    verdict,
    node_label: runContext.nodeLabel,
    egress,
    prompt_pack: promptPack.name,
    prompt_hash: promptHash,
    fixtures: fixtures.length,
    counts,
    checks: all,
  }, null, 2), 'utf8');

  console.log(`报告已写入 ${path.relative(ROOT, outPath)}`);
  return { checks: all, counts, outPath };
}

if (require.main === module) {
  preflight()
    .then(({ counts }) => {
      if (counts.fail > 0) {
        console.error('\n有硬失败项，长测跑起来只会浪费额度。请先按上面的提示修掉。');
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`前置校验异常：${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { preflight };
