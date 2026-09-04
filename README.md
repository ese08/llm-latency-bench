# LLM API 跨时段延迟压测

连续跑一周以上，每 15 分钟采样一次，回答两个问题：

1. **「工作时段大家用得多，API 就变慢」是真的吗？** ——按小时看延迟分布，而不是凭感觉。
2. **该不该换服务商？** ——同一套请求、同一批图片、同一时刻，横向对比 5 个配置的延迟与成本。

被测配置：

| id | 平台 | 模型 | 说明 |
|---|---|---|---|
| `sf-qwen35-9b` | 硅基流动 | `Qwen/Qwen3.5-9B` | 「大厨秘诀」当前生产在用的 |
| `sf-qwen35-4b` | 硅基流动 | `Qwen/Qwen3.5-4B` | 更小的同代模型 |
| `ark-mini-default` | 火山方舟 | `doubao-seed-2-0-mini-260428` | 常规档（`service_tier=default`） |
| `ark-mini-fast` | 火山方舟 | 同上 | 低延迟档（`service_tier=fast`，单价是常规的 2 倍） |
| `or-deepinfra-9b` | OpenRouter | `qwen/qwen3.5-9b` @ `deepinfra/bf16` | 锁死 DeepInfra，禁 fallback |

---

## ⚠️ 先读这一段：这批数据能证明什么，不能证明什么

采集点是 **GitHub Actions 的托管 runner（Azure，美国）**。而硅基流动（`api.siliconflow.cn`）和
火山方舟（`ark.cn-beijing.volces.com`）都在中国大陆。

所以从这里量到的「硅基流动变慢了」，包含两部分：**跨太平洋链路的抖动** + **服务端真的变慢**。
火山引擎自己的文档就把海外访问定性为「延时高、网络波动」，并为此单卖跨境专线。

这不是致命缺陷，但决定了结论的措辞：

- ✅ **能回答**：「我现在的 Netlify 生产环境（AWS 俄亥俄）调这几个 API，用户实际要等多久，
  一天中哪个时段最难受。」——因为生产环境走的就是同一条跨太平洋链路。
- ✅ **能回答**：「同一时刻、同一条链路上，五个配置谁快谁慢、谁贵谁便宜。」
  ——网络噪声对同一时刻的所有配置是共同的，横向对比仍然成立。
- ⚠️ **只能部分回答**：「模型服务本身在国内高峰期是不是变慢了。」
  程序为此设计了 **`control_empty` 空载对照组**：每轮都对同一个域名发一次几乎不带 body、
  几乎不产生推理的请求，用它的 TTFB 当网络基线，报表会展示「扣掉基线后的服务端净耗时」。
  这能剥掉大部分链路噪声，但剥不干净。
- ❌ **不能回答**：「国内用户直连这些 API 有多快。」要回答这个，采集点必须放在境内。

**如果哪天想把结论升级成「国内视角」**：买一台最便宜的境内/香港轻量服务器（约 ¥40~70/年首购），
把 `NODE_LABEL` 设成别的值（例如 `cn-bj`），用 crontab 跑同一份 `src/run-round.js`，
结果并到同一个 `results/` 目录。报表天然按 `node_label` 分组，两个节点的数据可以并排看，
差值就是跨境链路的代价。代码一行都不用改。

另外两条前提：

- **仓库必须是公开的**，否则 GitHub Actions 的免费分钟数不够（每 15 分钟一次 ≈ 每月 3000+ 分钟，
  私有仓库 Free 只有 2000）。公开意味着 `results/` 下的所有采样数据、`fixtures/` 下的所有图片
  都对外可见。API Key 放 repository secrets，不会进仓库。
- **提示词默认不是生产原文**。生产提示词跑在 Netlify Function 里，用户拿不到；把它 commit 进
  公开仓库等于对外发布且难以撤回。默认用的是 token 数对齐的通用提示词——对延迟测量而言
  起作用的是 token 数量、图片大小和输出长度，不是具体措辞。
  想用生产原文，见下面「用生产提示词跑」。

---

## 快速开始

```bash
node --version   # 需要 >= 20
```

### 1. 准备图片素材

图片任务要用**跟生产同规格**的照片：长边 1280px、JPEG q82（与 `image-compressor.js` 一致）。
需要 8 张轮换——光靠提示词里的随机串破不掉多模态请求里图片部分可能命中的缓存。

```bash
npm install            # 只为装 sharp，仅本地用，CI 运行时零依赖
```

把你自己的食材照片放进 `fixtures/raw/`（这个目录已被 gitignore），然后：

```bash
npm run fixtures
```

手头没照片时的兜底（能跑通链路，但模型会返回空结果、输出 token 偏少，**不能和真实照片的数据混着比**）：

```bash
npm run fixtures:synthetic
```

⚠️ 仓库是公开的。别放含人脸、住址、身份证、快递单、含真实姓名电话的小票的照片。

### 2. 火山方舟控制台：开通低延迟

`ark-mini-fast` 这个配置需要你先手动操作，否则**请求不会报错，只会静默降级成常规档**，
测出来的「fast 和常规一样快」是假结论：

1. 打开 <https://console.volcengine.com/ark/region:cn-beijing/openManagement>
2. 开通 `doubao-seed-2-0-mini` 的模型服务
3. 打开该模型「低延迟」列的开关
4. 顺手记下低延迟的默认 TPM 配额（文档没公开这个数值，只能在控制台看）

代价要知道：开了低延迟就**无法同时开启「安心体验模式」，也无法「配置推理限额」**——
等于放弃平台侧的两道自动停服保护。程序里有请求数上限兜底，但账单要自己盯。

（免费额度不受影响：免费额度和安心体验模式是两回事，未开通模型服务时就能用免费额度，
开通后仍优先消耗剩余免费额度。）

### 3. 本地跑一次前置校验

```bash
export SILICONFLOW_API_KEY=...
export ARK_API_KEY=...
export OPENROUTER_API_KEY=...
npm run preflight
```

**这一步不能跳。** 有一批问题只能用真实请求回答，读文档推不出来：

| 待验证 | 为什么存疑 |
|---|---|
| `Qwen/Qwen3.5-9B` 在不在 `api.siliconflow.cn` 上 | 国际站 `.com` 有完整模型页，但国内站 `.cn` 的定价页、模型页三处都查不到含 9B 的型号。而生产代码调的正是 `.cn` |
| `Qwen/Qwen3.5-4B` 在不在 | 官方模型页返回 404，定价页也没有。preflight 会用 `/v1/models` 给出确定答案 |
| 硅基的 `stream_options.include_usage` 支不支持 | 它不在硅基官方 API 参考里，只是 OpenAI 兼容惯例。拿不到 usage 就算不出 TPOT 和成本 |
| 多模态 + `response_format:json_object` 会不会被拒 | 硅基的 JSON 模式指南明确把 VL 模型排除在外，而 Qwen3.5 是原生多模态 |
| 三家的「关思考」是否真生效 | 唯一硬证据是 `reasoning_tokens === 0`。三家写法完全不同且都容易写错 |
| 火山 `service_tier:fast` 是否被静默降级 | 配额不足时不报错，只降级。判据是响应体的 `service_tier` 字段 |
| OpenRouter 有没有真锁在 DeepInfra | 靠 `openrouter_metadata` 里 `selected:true` 那项确认 |
| DeepInfra 那个端点收不收图片 | OpenRouter 的模态支持是**模型级**声明，不按端点公布 |

preflight 有硬失败就 `exit 1`，报告写在 `results/preflight-fail-*.json`；全部通过时写的是 `results/preflight-ok-*.json`。CI 只认 `-ok-` 那个名字来判断「已校验过、可以直接采样」。
**别带着 fail 去跑一周长测——那只会烧掉额度换回一批不可用的数据。**

### 4. 本地跑一轮采样

```bash
npm run round
```

### 5. 上 GitHub

```bash
git init && git add -A && git commit -m "init"
gh repo create llm-latency-bench --public --source=. --push
```

然后在仓库 Settings → Secrets and variables → Actions 里加：
`SILICONFLOW_API_KEY`、`ARK_API_KEY`、`OPENROUTER_API_KEY`（可选 `PROMPT_PACK_B64`）。

采样工作流会自动按 cron 跑起来。手动触发一次确认没问题：Actions → probe → Run workflow。

### 6. 出报表

```bash
npm run report      # 生成 report.html，本地打开
```

CI 里也有一个每天跑的 report 工作流，报表作为 artifact 上传。

---

## 用生产提示词跑

默认用通用提示词。想让结果更贴近线上：

```bash
node -e "console.log(Buffer.from(JSON.stringify({image:'<photo_ingredients 原文>',text:'<voice_ingredients 原文>'})).toString('base64'))"
```

把输出放进 GitHub Secret `PROMPT_PACK_B64`。原文不会出现在仓库里。

⚠️ 两点：
- 提示词里**必须包含小写的 `json`** 这个词，否则火山方舟的 `json_object` 模式直接不生效。
- 每条样本都记录 `prompt_pack` 和 `prompt_hash`。中途换提示词会让新旧数据不可比，
  报表检测到一批数据里混了两种 pack 会红字警告。

---

## 已知陷阱（都已经写进代码，改动前请先读）

**关思考三家写法完全不同，写错了整批数据作废**

| 平台 | 正确写法 | 常见错误 |
|---|---|---|
| 硅基流动 | 请求体顶层 `enable_thinking: false` | 嵌进 `extra_body`（那是 Python SDK 的机制，HTTP 上等价于顶层） |
| 火山方舟 | 顶层 `thinking: {type: "disabled"}` | 不传——mini 默认是**开**的；传 `auto`——mini 不支持 |
| OpenRouter | `reasoning: {effort: "none"}` | `reasoning:{exclude:true}` / `include_reasoning:false` ——**这是假关闭**，模型照样思考、照样计时、照样计费 |

每条样本都断言 `reasoning_tokens === 0`。`null`（拿不到）也算不合格——没法证明关掉了的样本不可比。

**缓存会系统性压低延迟，而且随机后缀放结尾没用**
前缀缓存从开头逐 token 匹配，`"a b c d"` 和 `"a b c x"` 仍共享 `"a b c"` 前缀而命中。
所以 nonce 拼在 system message **最前面**，图片按轮次轮换，并且每条都回读 `cached_tokens`，
非零就标 `cache_contaminated` 剔出主统计。

**火山的 fast 不生效时不报错，只静默降级**
配额不足、斜率超限（每分钟增长超 20%）、突发流量保护都会让请求悄悄走常规档，
错误码表里没有任何 fast 专属错误。唯一判据是响应体顶层的 `service_tier`（`fast`/`default`/`scale`）。
报表会按实际档位分组，降级率 > 20% 时红字提示对比结论不成立。
另外 `service_status.model_fallback` 说的是**模型**降级（换了别的模型），不是档位降级，别拿它当判据。

**OpenRouter 锁供应商必须两个参数一起写**
`allow_fallbacks` 默认是 `true`，只写 `provider.only` 仍可能在 DeepInfra 故障时送到别处。
`order` 是优先级不是白名单。slug 要用带后缀的 `deepinfra/bf16`，裸 `deepinfra` 会匹配该供应商全部变体。
另外：`stream_options.include_usage` 在 OpenRouter 已废弃且无效（usage 自动返回），
跟火山**正好相反**，别照抄。缓存命中的响应不带 `openrouter_metadata`，这不是失败，要单独归类。

**两个 TTFT 列，别混着看**

| 列 | 起点 | 用途 |
|---|---|---|
| `t_ttft_ms` | 请求发起（**含** DNS+TCP+TLS 握手） | 用户实际等待的时间。只在「冷热连接对比」那一节用 |
| `t_ttft_net_ms` | 请求体写完（**不含**握手） | 报表其余各节的主指标 |

为什么主指标要剥掉握手，有两个各自独立的理由：

1. **不剥就没法做网络基线扣除。** 对照组的 `t_ttfb_ms` 本来就是从「请求体写完」起算的，
   拿含握手的 `t_ttft_ms` 去减它，差值里会整整多出一次握手——而那一节存在的唯一目的
   就是把链路开销剥出去。更糟的是这个偏差**按平台差一个数量级**：美国 runner 到国内机房
   的握手是几百毫秒，到同在美国的 DeepInfra 只有几十毫秒，于是「国内平台服务端更慢」
   会被凭空放大，而这恰恰是要拿来做换服务商决策的那个数字。
2. **不剥的话冷热样本是双峰的。** 冷热各占一半轮次，两组相差整整一次 TLS 握手，
   混在同一个池子里算出的 P50 正好落在双峰的分界点上——那个数既不代表冷也不代表热。

换算是个恒等式，不需要额外采集：
`t_ttft_net_ms = t_ttft_ms − (t_dns_ms + t_tcp_ms + t_tls_ms) − t_req_body_ms`
（热连接时前三段为 null 记 0，而 `t_req_body_ms` 本身就是从请求发起算起的）。

**图片轮换的种子不能用轮次桶**
`bucket` 同时决定了 `conn_mode`（`bucket % 2`），而每小时正好 4 个 bucket。
只要素材张数是偶数，`fixtures[bucket % N]` 的下标奇偶就恒等于 bucket 奇偶——
结果是「冷连接永远只用奇数号图、热连接永远只用偶数号图」，偶数小时只用前半批、
奇数小时只用后半批。图片 token 数按像素面积算，两批素材只要平均复杂度有差异，
按小时的热力图就会出现逐小时交替的条纹，那是素材分组不是时段规律，**而且事后无法分离**
（没有任何一个格子可以做对照）。所以选图用的是 `roundId` 的哈希取模，对任意张数都与
bucket 奇偶和小时无关。

**`t_req_body_ms` 这一列要小心解读**
它只代表「请求体全部写进了内核 socket 缓冲区」，不代表服务端收到了。
body 小于发送缓冲（常见 64KB~1MB）时这个值几乎恒为 0~2ms、没有意义，
只有大图触发 TCP 背压时才近似上行耗时。真要看「图片上传成本」，请看报表里
「image 任务 TTFT − text 任务 TTFT」的差值，以及对 `request_body_bytes` 做的回归。

**失败样本必须落盘**
只统计成功样本 = 幸存者偏差（把最慢的都删了，看起来更快）。
延迟分位数只用 `isCleanSample()` 的样本；可用率和错误构成用全部样本。两张表口径不同，报表会注明。
DeepInfra 那个端点 `uptime_last_1d` 只有 95.86%（五家最低），锁死 + 禁 fallback 必然撞 404。

**耗时一律用单调钟**
`process.hrtime.bigint()`。`Date.now()` 只打时间戳标签——一周长跑必然遇到 NTP 校时。
每条样本同时记墙钟对照 `t_wall_e2e_ms`，与单调钟偏离超 20% 的直接判废。

**采样时刻要抖动**
cron 已经错开到 `7,22,37,52` 分（GitHub 官方说整点是高负载时段，schedule 会被延迟甚至丢触发），
程序内部还会再随机等 0~60 秒。固定整点发请求会撞上全网定时任务，测出的「高峰」是整点效应。

**分时段统计必须按 `ts_wall_utc` 分桶，不能按 cron 的名义时刻**
这条最容易搞错，而且搞错的方向恰好会**伪造出**本实验要找的那个结论。
GitHub 的 schedule 在高负载时段（正是整点附近）会被拖延，如果按「本该是 14:07 那一轮」归类，
一个实际 14:35 才发出的请求会被算进 14:00 这个格子——于是「某些时段变慢」就被人为制造出来了。
报表全程按每条样本自己的 `ts_wall_utc` 分桶（换算到 Asia/Shanghai），不用计划时刻。

**`schedule_drift_ms` 的含义比字段名窄**
它记的是「GitHub 创建本次 run 的时刻 → 探针发出第一个请求」，
包含 runner 排队、检出、装 Node、起跑抖动。
它**不包含 cron 调度器自身的延迟**（名义时刻 → run 被创建），
而按官方说法整点高负载被拖的恰恰是这一段。所以这一列会系统性低估真实抖动，
**它不是 cron 延迟的度量**。真正的调度器延迟每轮写在 job summary 里，供人工核对。
（为什么不直接算：从 run 内部拿不到名义时刻，只能靠 cron 分钟位反推，
而延迟一旦 ≥ 15 分钟就会按 15 分钟整数倍向下混叠，把「迟到 16 分钟」算成「迟到 1 分钟」，
且输出永远是个看起来很正常的数字，没有任何标记能区分真假。宁可不要这个数。）

**GitHub 会丢掉定时 run**
官方明说高负载时部分排队的任务可能被直接丢弃。数据里会出现整轮缺失。
算可用率时**不能把缺失的轮次当成失败**——那是 GitHub 的问题，不是被测平台的。
要对账的话，按「预期轮次数 vs 实际 `round_id` 去重计数」自己核一遍。

**火山低频调用的反向风险**
错误码表里有 `429 ServerOverloaded`，官方注明「常出现在……刚开始调用长时间未使用的推理接入点」。
每 15 分钟一次恰好落在这个场景，冷启动样本会偏慢。冷热连接分组（`conn_mode` + `conn_established`）
就是为了能把它识别出来。

---

## 文件

```
src/
  config.js            被测配置矩阵、定价快照、采样计划、超时
  payloads.js          提示词、图片素材、破缓存的 nonce
  probe.js             跑一次采样 → 一条记录
  run-round.js         跑一轮（配置 × 任务 × 3 次重复）→ JSONL
  preflight.js         前置校验：把只能靠真实请求回答的问题一次问清
  report.js            读 results/**/*.jsonl → 自包含静态 HTML 报表
  lib/
    schema.js          ⭐ 采样记录的唯一权威定义。改字段从这里改
    http-timing.js     逐段计时的 HTTPS POST（DNS/TCP/TLS/上行/TTFB/TTFT）
    env.js             采集点环境：出口 IP、runner 信息、cron 抖动
  providers/
    siliconflow.js     顶层 enable_thinking
    ark.js             thinking.disabled + service_tier + 静默降级检测
    openrouter.js      reasoning.effort=none + 供应商锁定 + 命中确认
tools/
  prepare-fixtures.mjs        把你的照片转成生产同规格
  make-synthetic-fixtures.mjs 没照片时的兜底
.github/workflows/
  probe.yml            每 15 分钟采样，结果 commit 回仓库
  report.yml           每天生成报表
results/               JSONL 采样数据（会 commit，公开可见）
fixtures/              压测用图片（会 commit，公开可见）
fixtures/raw/          你的原图（已 gitignore）
```

字段含义见 `src/lib/schema.js` 里 `FIELDS` 的逐行注释——那是唯一权威来源，
报表和分析脚本都以它为准。

---

## 成本

一周（每 15 分钟 × 3 次重复 × 5 配置 × 3 种任务）约 2 万次请求：

| 平台 | 估算 |
|---|---|
| 硅基流动 ×2 | 约 $0.9（约 ¥6） |
| 火山方舟 常规 | 约 ¥2 |
| 火山方舟 低延迟 | 约 ¥3（单价是常规的 2 倍） |
| OpenRouter@DeepInfra | 约 $0.5（约 ¥3.5） |
| **合计** | **约 ¥15~30** |

GitHub Actions 公开仓库不消耗分钟额度。

价格随时会变。每条样本都带 `price_snapshot_date`，报表按它分组；长测跑完后请重新核对单价再算总成本。
`sf-qwen35-4b` 的单价查不到官方数字，配置里标了 `confidence: 'unverified'`，
成本列会是 `null`——查到之后填进 `src/config.js` 即可。

## 一周后

commit 历史会多出约 700 条采样提交。跑完想收尾的话：把 `probe.yml` 的 `schedule` 注释掉，
或者直接在 Actions 页面 Disable 掉那个工作流。数据留在 `results/` 里，报表随时能重出。
