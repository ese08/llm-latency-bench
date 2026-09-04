'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 请求载荷的构造：提示词、图片、以及破缓存用的 nonce。
 *
 * ── 提示词为什么默认不是生产原文 ──
 * 这个仓库要设为公开才能白嫖 GitHub Actions 的免费分钟数，而生产提示词是跑在
 * Netlify Function 里的服务端资产，用户从前端拿不到。把它 commit 进公开仓库
 * 等于对外发布，且会被搜索引擎索引、难以撤回。
 *
 * 所以默认用下面这套 **token 数对齐的通用提示词**：对延迟测量而言真正起作用的是
 * token 数量、图片大小和输出长度，不是具体措辞。
 *
 * 如果你确实想用生产原文跑（结果会更贴近线上），把原文 base64 后放进
 * GitHub Secret `PROMPT_PACK_B64`，程序会自动改用它，且原文不会出现在仓库里。
 * 每条样本都记录 prompt_pack 和 prompt_hash，报表会标明这批数据用的是哪套。
 */

const GENERIC_SHARED_RULES = [
  // 「json」这个小写词是刻意留的：火山方舟的 json_object 模式硬性要求输入里出现字符串
  // 「json」，否则该模式直接不生效。三家用同一份提示词才可比，所以这个词对所有平台都留着。
  '你只做冰箱食材入库识别。只输出 json，不要 markdown，不要解释，不要寒暄。',
  '收录：能用来做菜的食材——生鲜蔬果、肉类、海鲜、蛋奶豆制品、米面粮油、调味料、干货香料。',
  '不收录：非食物（衣物、餐具、日用品、纸巾、包装袋、电器）；即食零食和深加工食品（薯片、饼干、糖果、巧克力、方便面、面包、蛋糕、饮料、冰淇淋、火腿肠、罐头零食）；餐厅成品菜；保健品和药品；宠物食品。',
  '判断不了就不要猜。没有可收录的食材时必须返回 {"ingredients":[]}。',
  '顶层只能有 ingredients 一个字段；每项只能有 name、category、quantity、unit、storageZone、confidence、note 这 7 个字段。',
  'name：通用中文食材名，去掉品牌、规格、产地、促销词。',
  'category：只能是 蔬菜/水果/肉类/海鲜/蛋奶/主食/调料/其他。',
  'quantity：正数，说不清写 1。',
  'unit：中文单位。说不清时按类推断——蛋类/水果/根茎类用「个」，叶菜和葱姜香菜用「把」，肉类和海鲜用「克」，牛奶豆腐用「盒」，其余用「份」。',
  'storageZone：只能是 ambient/chilled/frozen。粮油、干货、调味料、耐放根茎用 ambient；生鲜蔬果、蛋奶、豆制品、鲜肉鲜鱼用 chilled；冻肉、冻海鲜、速冻食品用 frozen。',
  'confidence：0 到 1 的小数。',
  'note：简短中文说明；confidence 低于 0.6 时必须写明需要人工确认。',
].join('\n');

const GENERIC_PACK = {
  name: 'generic',
  image: [
    GENERIC_SHARED_RULES,
    '输入是一张食材照片。只认画面里真实可见的食材，忽略餐具、桌面、包装外观、品牌 logo、价签、人手、背景和装饰物。',
    '包装食品按里面的食材算，例如一盒牛奶算牛奶、一袋挂面算挂面。',
    '看到的是做好的菜时，可以拆成主要食材，但 confidence 要偏低，并在 note 里说明是熟菜推断。',
  ].join('\n'),
  text: [
    GENERIC_SHARED_RULES,
    '输入是用户口述、转写并确认过的中文文字，可能一次提到多种食材，例如「一个西红柿，两个土豆」。',
    '每种食材单独一项；同一种食材重复提到就合并数量，不要重复输出。',
    '口语数量按常识换算：一斤=500克，半斤=250克，两=50克。',
    '忽略语气词、寒暄和与食材无关的话；整段都跟食材无关时返回 {"ingredients":[]}。',
  ].join('\n'),
};

/** 文本任务的固定用户输入。够长到能跑出几个食材，又不至于让输出长度失控。 */
const TEXT_USER_INPUT = '我今天买了两个西红柿，三个土豆，一把小青菜，半斤五花肉，还有一盒牛奶和一袋挂面。';

const IMAGE_USER_INPUT = '请识别这张图片里可以入库的食材。';

/**
 * 空载对照请求的载荷。
 *
 * 这是整套测试里最重要的一组：它跟正式请求打同一个域名、走同一条链路，
 * 但几乎不带 body、也不产生多少推理。用它的 TTFB 做基线，
 * 才能把「跨太平洋链路的往返」从「服务端真的变慢了」里减出来。
 * 从 GitHub Actions 这种境外节点测国内 API 时，这一组不是可选项。
 */
const CONTROL_USER_INPUT = '回复 ok';
const CONTROL_SYSTEM = '只输出两个字符：ok';

function loadPromptPack() {
  const encoded = process.env.PROMPT_PACK_B64;
  if (!encoded) return GENERIC_PACK;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof parsed.image !== 'string' || typeof parsed.text !== 'string') {
      throw new Error('PROMPT_PACK_B64 必须解出含 image 与 text 两个字符串字段的 JSON');
    }
    // 火山方舟的 json_object 模式硬性要求输入里出现字符串「json」，否则该模式直接不生效
    // 且**不报错**——模型会返回自由文本，看起来像是「这个平台质量差」。
    // 换提示词最容易踩这一条，所以在这里挡住，而不是等一周之后才发现。
    for (const key of ['image', 'text']) {
      if (!parsed[key].includes('json')) {
        throw new Error(
          `PROMPT_PACK_B64 的 ${key} 提示词里必须出现小写的「json」这个词。`
          + '火山方舟的 json_object 模式要求输入含该字符串，否则会静默失效。',
        );
      }
    }
    return { name: 'production', image: parsed.image, text: parsed.text };
  } catch (error) {
    // 提示词解析失败绝不能静默回落——那会让整批数据的 prompt_pack 标记失真。
    throw new Error(`PROMPT_PACK_B64 解析失败：${error.message}`);
  }
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 破前缀缓存用的随机串。
 *
 * ⚠️ 必须放在 system message 的**最前面**。前缀缓存是从开头逐 token 匹配的，
 * 放在结尾完全没用——"a b c d" 和 "a b c x" 仍然共享 "a b c" 前缀而命中。
 * 而且不要只靠这个：每条样本都要回读 cached_tokens，非零就标记污染。
 */
function makeNonce(randomBytes) {
  return `#${(randomBytes || crypto.randomBytes(8)).toString('hex')}`;
}

function listFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir)
    .filter((name) => /\.jpe?g$/i.test(name))
    .sort();
}

/**
 * 读一张图并转成 data URL。
 *
 * base64 编码必须在计时起点之前做完：对一张几百 KB 的图，编码本身要几毫秒到几十毫秒，
 * 在 t0 之后做就会被算进「网络时间」。
 */
function loadImageFixture(fixturesDir, fileName) {
  const filePath = path.join(fixturesDir, fileName);
  const bytes = fs.readFileSync(filePath);
  const base64 = bytes.toString('base64');
  return {
    fileName,
    bytes: bytes.length,
    b64Bytes: base64.length,
    dataUrl: `data:image/jpeg;base64,${base64}`,
  };
}

/**
 * 按轮次轮换图片。
 *
 * 光靠 nonce 破前缀缓存对多模态请求不够保险——图片部分的 token 也可能被缓存。
 * 轮换真实图片是更硬的手段。
 *
 * ⚠️ 选图的种子必须与「轮次桶」解耦，不能写成 fixtures[bucket % N]。
 * bucket 同时决定 connMode（bucket % 2），而每小时正好 4 个 bucket；只要 N 是偶数，
 * 下标奇偶就恒等于 bucket 奇偶，于是「冷连接永远只用奇数号图、热连接永远只用偶数号图」，
 * 偶数小时只用前半批、奇数小时只用后半批。这三者完全共线，事后按 image_fixture 分层
 * 也分不开——没有任何一个格子可以做对照。
 * 换 N 为奇数只能解决一半问题（还要与每小时 4 个桶互质），所以直接用 roundId 的哈希取模：
 * 对任意 N 都与 bucket 奇偶和小时无关。
 */
function pickFixture(fixtures, seed) {
  if (fixtures.length === 0) return null;
  const digest = crypto.createHash('sha256').update(String(seed), 'utf8').digest();
  return fixtures[digest.readUInt32BE(0) % fixtures.length];
}

/** 构造一次采样的 messages。nonce 一律拼在 system 最前面。 */
function buildMessages({ task, pack, nonce, image }) {
  if (task === 'control_empty') {
    return {
      system: `${nonce}\n${CONTROL_SYSTEM}`,
      userContent: [{ type: 'text', text: CONTROL_USER_INPUT }],
    };
  }

  if (task === 'text_ingredients') {
    return {
      system: `${nonce}\n${pack.text}`,
      userContent: [{ type: 'text', text: TEXT_USER_INPUT }],
    };
  }

  return {
    system: `${nonce}\n${pack.image}`,
    userContent: [
      { type: 'text', text: IMAGE_USER_INPUT },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ],
  };
}

module.exports = {
  GENERIC_PACK,
  TEXT_USER_INPUT,
  IMAGE_USER_INPUT,
  CONTROL_USER_INPUT,
  loadPromptPack,
  shortHash,
  makeNonce,
  listFixtures,
  loadImageFixture,
  pickFixture,
  buildMessages,
};
