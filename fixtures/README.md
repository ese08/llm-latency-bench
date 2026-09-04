# fixtures —— 压测用的图片素材

`image_ingredients` 任务每次请求都要带一张图。这个目录放的就是那批图，
文件名固定为 `ingredients-01.jpg` … `ingredients-08.jpg`，采样时按轮次轮换。

---

## ⚠️ 先读这一条：这个仓库是公开的

仓库设为 public 才能白嫖 GitHub Actions 的免费分钟数。
**放进 `fixtures/` 并 commit 的照片，任何人都能看到、能下载，而且 git 历史里删不干净。**

不要放：

- 有人脸的照片（自己的、家人的、朋友的都不行）
- 能看出住址的画面：门牌、楼道、窗外街景、快递单、外卖单
- 身份证、银行卡、护照、车牌
- 含真实姓名 / 电话 / 地址的购物小票
- 手机相册里顺手挑的、你没逐张看过的照片

想测小票场景就重新拍一张：用超市小票，先用不透明胶带贴掉门店电话、会员号、卡号后四位、
支付流水号，或者干脆自己打印一张假小票。**宁可换一张，也不要「应该没事吧」。**

生成前后各看一遍：`tools/prepare-fixtures.mjs` 跑完会提醒你逐张确认，别跳过。

原图放 `fixtures/raw/`，这个子目录已经在 `.gitignore` 里，不会进仓库。

---

## 两条路

### 路线 A（推荐）：用你自己的食材照片

```bash
npm install                         # sharp 已在 devDependencies 里，CI 运行时不装
mkdir -p fixtures/raw               # 把 8 张左右的食材照片丢进去
npm run fixtures                    # 等价于 node tools/prepare-fixtures.mjs
```

脚本会把每张照片按 EXIF 方向摆正、长边压到 1280px、编成 JPEG q82、去掉全部元数据，
输出成 `ingredients-01.jpg` … `ingredients-08.jpg`，并打印一张表：
像素尺寸、字节数、base64 后字节数、火山与 Qwen 各自的图片 token 估算值。

拍照建议：

- 拍冰箱内景、砧板上的一堆菜、超市购物袋倒出来的样子——越接近真实使用场景越好。
- 一张图里放多种食材（5~10 种），跟生产环境的输入分布一致，也能让输出长度稳定些。
- **横竖构图尽量统一**（例如全部横拍 4:3）。图片 token 数是按像素面积算的，
  竖图和横图混着放会让不同轮次的 `prompt_tokens` 上下跳，给数据白添一层噪声。
- 别用截图、纯白背景摆拍或美食杂志图：这类画面 JPEG 压得太狠，
  压出来只有几十 KB，上传耗时会比真实照片小一个量级。

要带参数时直接调脚本（npm run 传 flag 得多写一个 `--`）：

```bash
node tools/prepare-fixtures.mjs --raw fixtures/raw --out fixtures --count 8
```

脚本每次会先删掉上一批 `ingredients-NN.jpg` 再重新生成——留着旧文件会让轮换里
混进上一批素材，静默污染数据。原图在 `raw/` 里，随时能重来。

### 路线 B（兜底）：先用合成图跑通链路

手头没有合适的照片，又想马上验证 preflight / probe / run-round 能不能跑：

```bash
npm install
npm run fixtures:synthetic          # 等价于 node tools/make-synthetic-fixtures.mjs
```

会用固定种子的伪随机噪声 + 色块合成 8 张 1280×960 的 JPEG，规格与路线 A 完全一致，
每张约 290KB（base64 后约 390KB），跟真实食材照片同一量级；
图片 token 估算：火山约 697、Qwen 约 1610。

体积全靠噪声撑着——纯色块的 JPEG 只有几十 KB，上传耗时会比真实照片小一个量级。
如果跑出来的体积偏离 200~400KB，脚本会直接给出该用的 `--noise` 值。

**合成图的数据不能当结论用：**

- 模型认不出任何食材，会返回空的 `ingredients` 数组。
- 于是 `completion_tokens` 明显少于真实照片，`t_e2e_ms`、`tpot_ms`、`output_tps`、
  `cost_total` 全都偏低。**绝不能跟真实照片的数据放在一张表里比。**
- 可信的只有上传与 prefill 那一段：`request_body_bytes`、`t_req_body_ms`、`t_ttfb_ms`，
  因为它们只取决于图片体积和图片 token 数。

如果 `fixtures/` 里已经有真实照片，脚本会拒绝覆盖，除非你显式加 `--force`。

正式开跑长测之前，请换成路线 A。

---

## 为什么要 8 张轮换

平台侧的前缀缓存会让「第二次一样的请求」快得不真实。
提示词里那个 nonce 只能破掉**文本前缀**的缓存；多模态请求里图片那部分的
token 是否被单独缓存，各家实现不透明、也不承诺。

轮换真实图片是更硬的手段：每轮换一张图，图片 token 本身就是全新的，
不依赖任何厂商的缓存实现细节。8 张够让同一张图在一天里重复不了几次，
又不至于让素材之间的差异（体积、token 数）大到掩盖时段差异。

保险起见，每条样本还会回读 `cached_tokens`，非零就标 `cache_contaminated`，
在报表里剔出主统计。

## 为什么规格必须跟生产一致

生产环境（大厨秘诀 `image-compressor.js`）上传前会把图压成：

| 参数 | 值 |
| --- | --- |
| 长边 | 1280px（只缩不放） |
| 格式 | JPEG |
| 质量 | 0.82 |
| 方向 | 按 EXIF 摆正 |
| 元数据 | 全部去掉 |

这批压测图必须一模一样，否则：

- 图片体积不同 → `request_body_bytes` 和 `t_req_body_ms` 不可比。
  跨太平洋链路上，几百 KB 的请求体要多花好几个 RTT 才发得完，这段耗时对结论影响很大。
- 像素尺寸不同 → 图片 token 数不同 → `prompt_tokens`、prefill 耗时和成本全都不可比。

两个脚本都写死了这套规格。命令行虽然能用 `--quality` / `--max-edge` / `--width`
临时改，但改了会打印警告——那是给调试用的，不是给正式数据用的。

## 中途不要换素材或换规格

图片一换，`image_bytes`、`image_b64_bytes` 和图片 token 数就跟着变，
换之前和换之后的 `image_ingredients` 数据**不可直接比较**。

这套测试要连续跑一周以上，目的是看「工作时段是不是真的变慢」——
如果周三换了素材，周三前后的差异到底是时段造成的还是素材造成的，就分不清了。

真的必须换（例如发现某张图泄露了隐私），那就：

1. 先换，并在 commit message 里写清楚换了什么、为什么换、从哪一轮开始生效。
2. 分析时按换素材的时间点切成两段，各自单独看趋势，不要跨段比绝对值。
3. 优先看 `control_empty` 和 `text_ingredients` 这两个不受图片影响的任务，
   它们能跨越换素材的时间点连续比较。

## 采样时怎么用这些文件

`src/payloads.js` 读取本目录下所有 `.jpg` / `.jpeg`，按**文件名排序**，
再按轮次取模轮换。所以：

- 命名必须保持 `ingredients-NN.jpg` 的两位补零格式，排序才稳定。
- 目录里不要放别的 jpg（临时图、参考图），会被一并当成素材。
- `raw/` 是子目录，不会被当成素材文件。
- 每条样本记录用了哪张图（`image_fixture`）、多大（`image_bytes` / `image_b64_bytes`），
  报表可以据此确认轮换真的生效了。
