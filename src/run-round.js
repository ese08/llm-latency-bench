'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { probe } = require('./probe');
const { PLAN, enabledConfigs } = require('./config');
const { TASK, CONN_MODE, isCleanSample } = require('./lib/schema');
const { makeColdAgent, makeWarmAgent } = require('./lib/http-timing');
const { buildRunContext, detectEgress, computeScheduleDrift } = require('./lib/env');
const {
  loadPromptPack,
  shortHash,
  makeNonce,
  listFixtures,
  loadImageFixture,
  pickFixture,
} = require('./payloads');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const RESULTS_DIR = path.join(ROOT, 'results');

const ROUND_BUCKET_MS = 15 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 冷热连接按轮次交替。
 *
 * GitHub Actions 每次运行都是全新进程，没有跨轮状态，所以从墙钟的 15 分钟桶推导——
 * 确定性、无状态、两种模式各占一半。
 *
 * 不用「先打一个 warmup 请求再开始计时」来统一成热连接：冷启动那一段恰好是
 * 手机端用户感知最强的部分，把它藏掉就测不出用户真正等的时间。
 */
function currentRoundBucket(nowMs) {
  return Math.floor(nowMs / ROUND_BUCKET_MS);
}

function pickConnMode(bucket) {
  return bucket % 2 === 0 ? CONN_MODE.COLD : CONN_MODE.WARM;
}

function safeFileStamp(isoString) {
  // Windows 文件名不允许冒号，results/ 要能在本地和 CI 上都写得出来。
  return isoString.replace(/[:.]/g, '-');
}

async function runBurst(context) {
  const { config, task, connMode, warmAgent, appendSample } = context;
  const samples = [];

  for (let attemptIndex = 0; attemptIndex < PLAN.repeatsPerBurst; attemptIndex += 1) {
    // 冷连接每次都换一个 agent：只关 keepAlive 不够，还要关 TLS 会话复用，
    // 否则第二次即使新建 TCP 也会跳过完整握手，t_tls_ms 系统性偏低一个 RTT。
    const agent = connMode === CONN_MODE.COLD ? makeColdAgent() : warmAgent;

    let sample;
    try {
      sample = await probe(Object.assign({}, context, {
        agent,
        attemptIndex,
        // 每次采样换一个 nonce，且它会被拼在 system message 最前面。
        // 前缀缓存是从开头逐 token 匹配的，放结尾完全无效。
        nonce: makeNonce(),
      }));
      sample.is_retry = false;
    } finally {
      if (connMode === CONN_MODE.COLD) agent.destroy();
    }

    // 每条样本立刻落盘，不攒到最后。
    // 一轮要发 45 个请求、跑 5~8 分钟，中途进程崩溃或 job 被超时掐断都是现实场景；
    // 攒到最后一次性写的话，这两种情况都会丢掉整轮数据——而「全面超时」的那一轮
    // 恰恰是最该留下的证据。
    appendSample(sample);
    samples.push(sample);

    if (attemptIndex < PLAN.repeatsPerBurst - 1) {
      // burst 内也要拉开间隔：脉冲式流量在火山的斜率保护下比均匀流量更容易被降级。
      await sleep(PLAN.intraBurstDelayMs);
    }
  }

  return samples;
}

async function runRound() {
  const startMs = Date.now();
  const runContext = buildRunContext();
  const scheduleDriftMs = computeScheduleDrift(startMs);
  const bucket = currentRoundBucket(startMs);
  const connMode = pickConnMode(bucket);

  const configs = enabledConfigs(process.env);
  if (configs.length === 0) {
    throw new Error('没有任何平台的 API Key，无法采样。请检查 SILICONFLOW_API_KEY / ARK_API_KEY / OPENROUTER_API_KEY。');
  }

  // 固定间隔发请求会撞上全网大量整点定时任务，测出的「高峰」是整点效应而不是真实规律。
  const jitterMs = crypto.randomInt(0, PLAN.jitterMaxMs);
  console.log(`[round] 抖动等待 ${(jitterMs / 1000).toFixed(1)}s（避开整点效应）`);
  await sleep(jitterMs);

  const roundId = new Date().toISOString();
  const promptPack = loadPromptPack();
  const promptHash = shortHash(`${promptPack.image}\n${promptPack.text}`);
  const egress = await detectEgress();

  const fixtures = listFixtures(FIXTURES_DIR);
  // 同一轮里所有配置用**同一张**图片，跨配置才可比；图片按轮次轮换，用来破多模态缓存。
  //
  // ⚠️ 选图不能用 bucket 取模。bucket 同时决定了 connMode（bucket % 2），而每小时正好 4 个
  // bucket，所以只要素材张数是偶数，fixtures[bucket % N] 的下标奇偶就恒等于 bucket 奇偶——
  // 结果是「冷连接永远只用奇数号图、热连接永远只用偶数号图」，而且偶数小时只用前半批、
  // 奇数小时只用后半批。图片 token 数按像素面积算，两批素材只要平均复杂度有差异，
  // 按小时的热力图就会出现逐小时交替的条纹，那是素材分组不是时段规律，且事后无法分离。
  // 改用 roundId 的哈希取模：对任意素材张数都与 bucket 奇偶、与小时无关。
  const fixtureName = pickFixture(fixtures, roundId);
  const image = fixtureName ? loadImageFixture(FIXTURES_DIR, fixtureName) : null;

  console.log(`[round] ${roundId} conn=${connMode} configs=${configs.length} `
    + `image=${fixtureName || '(无素材，跳过图片任务)'} egress=${egress.ip || '未知'}`);

  // 采样文件在发第一个请求之前就建好，之后逐条追加。
  const outPath = prepareOutFile(roundId, runContext.runId);
  const samples = [];
  const appendSample = (sample) => {
    fs.appendFileSync(outPath, `${JSON.stringify(sample)}\n`, 'utf8');
  };

  for (const config of configs) {
    // 热连接模式下整个配置共用一个 agent。第一次请求（最便宜的对照组）负责建连接，
    // 后续请求才是真正复用的——分析时靠 conn_established 这一列区分，而不是靠 conn_mode 假定。
    const warmAgent = connMode === CONN_MODE.WARM ? makeWarmAgent() : null;

    try {
      for (const task of PLAN.tasks) {
        if (task === TASK.IMAGE && (!config.supportsImage || !image)) continue;

        const burstId = `${roundId}|${config.id}|${task}|${connMode}`;
        const burstSamples = await runBurst({
          config,
          apiKey: process.env[config.envKey],
          task,
          connMode,
          warmAgent,
          promptPack,
          promptHash,
          image: task === TASK.IMAGE ? image : null,
          runContext,
          egress,
          roundId,
          burstId,
          scheduleDriftMs,
          appendSample,
        });

        samples.push(...burstSamples);
        logBurst(config, task, burstSamples);

        await sleep(PLAN.interConfigDelayMs);
      }
    } finally {
      if (warmAgent) warmAgent.destroy();
    }
  }

  const clean = samples.filter(isCleanSample).length;
  const failed = samples.filter((sample) => sample.ok !== true).length;

  console.log(`[round] 完成：${samples.length} 条样本（干净 ${clean} / 失败 ${failed}）→ ${path.relative(ROOT, outPath)}`);
  console.log(`[round] 耗时 ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

  return { samples, outPath };
}

function logBurst(config, task, samples) {
  const ttfts = samples
    .filter((sample) => typeof sample.t_ttft_ms === 'number')
    .map((sample) => Math.round(sample.t_ttft_ms));
  const errors = samples.filter((sample) => sample.ok !== true).map((sample) => sample.error_class);
  const degraded = samples.filter((sample) => sample.degraded === true).length;

  const parts = [`  ${config.id} / ${task}`, `TTFT=[${ttfts.join(', ') || '—'}]ms`];
  if (errors.length) parts.push(`失败=${errors.join(',')}`);
  if (degraded) parts.push(`⚠ 被降级 ${degraded} 次`);
  console.log(parts.join('  '));
}

/**
 * 在发第一个请求之前就把输出文件建好，后续每条样本立刻追加。
 *
 * 文件名带 round ISO 和 run_id，两个并发的 run 绝不会写同一路径，
 * 所以内容永远不会冲突，push 撞车时只要同步到最新远端再提交即可。
 *
 * 用追加而不是最后一次性写：JSONL 一行一条，被掐断时已落盘的每一行仍然是完整有效的样本。
 */
function prepareOutFile(roundId, runId) {
  const day = roundId.slice(0, 10);
  const dir = path.join(RESULTS_DIR, day);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = `round-${safeFileStamp(roundId)}-${runId}.jsonl`;
  const outPath = path.join(dir, fileName);
  fs.writeFileSync(outPath, '', 'utf8');
  return outPath;
}

if (require.main === module) {
  runRound().catch((error) => {
    console.error(`[round] 失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runRound, currentRoundBucket, pickConnMode, safeFileStamp };
