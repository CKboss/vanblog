/**
 * 🔴 markdown 渲染的**黄金输出（golden）守卫** —— 本仓库此前**没有任何**守卫钉住
 * 「markdown 渲染出来的 HTML 长什么样」，而这正是依赖升级（markdown-it / katex 插件 /
 * highlight.js / markdown-it-task-lists）最容易**悄悄**改变的东西，也是站长「每次迭代都要
 * 保证功能正常」那条裁定的直接落点。
 *
 * 语料：`src/__fixtures__/markdown-golden/*.md`（**54 例**，全部是本仓库自造的合成用例。
 * 🔴 **不含任何真实文章正文** —— 站长库里的文章是私有内容，绝不能进 git；
 *    建立本守卫时确实用 8 篇真实文章做过差分（结论见下），但那 8 篇只留在
 *    git-ignored 的 `vanblog_dev/tmp/w1-corpus/`，**没有**拷进这里。
 *
 * 覆盖面：katex（行内 / 块级 / `$$` 后带前导空格 / `$ … $` 两侧带空格 / 转义 / 与 markdown
 * 混排 / 中文混排 / 伪公式 / 未闭合 / 多块混排）、代码块（语言标注 / CJK / 嵌套围栏 /
 * mermaid / 未知语言 / 波浪线围栏 / 缩进式）、表格（含对齐缺失）、内联 HTML、块级 HTML、
 * HTML 实体、HTML 注释、`<!-- more -->`（含出现在代码块里的情形）、链接/图片/自动链接/
 * 引用式链接/相对链接、强调与删除线（含 intra_word）、有序/无序/任务/松散列表、嵌套引用、
 * 超长行与超长单词、emoji（`:smile:` 与原生）、setext 标题、三种分隔线、硬换行、front matter、
 * 定义列表与脚注形状，以及 **13 例危险 HTML**。
 *
 * ## 判据
 * 每个语料渲染三种输出（`renderMarkdown` / `getDescription` / `renderInline`），各自的
 * **sha256 必须逐字一致**。⚠️ 渲染是确定性的（同一份语料连渲两次逐字节相同，已实测），
 * 输出里不含时间戳、随机 id 或 `process.env` ⇒ 哈希是安全的判据。
 *
 * ## 🔴 红了怎么办（**必读，否则这条守卫会退化成橡皮图章**）
 * 它钉的是**现状**，不是**正确**。所以红了之后**不许直接重新生成哈希了事**，必须：
 *   1. 看清**哪些用例**变了、**变成了什么**（失败信息会打印实际输出的前 400 字符）；
 *   2. 逐条判定该差异是「上游修的 bug」「有意的行为变化」还是「我们改坏了」；
 *   3. 🔴 **13 例危险 HTML（`sec-*`）要按安全标准单独判定**，判据不是「与旧输出相同」，
 *      而是「是否仍然不被放行/不被执行」——⚠️ 如果升级前后都输出了 `<script>`，那
 *      「逐字相同」反而是坏消息（说明这一层本来就没防住，而差分对比会把它伪装成「无回归」）；
 *   4. 全部差异都确认是有意的之后，才手工更新 `GOLDEN`，并把「为什么这些差异可接受」写进提交信息。
 *      ⚠️ 故意**没有**提供 `--update` 式的自动改写（`W1_GOLDEN_UPDATE=1` 只打印清单、不改文件）。
 *
 * ⚠️ **2026-09-21 已经重新生成过一次哈希**：本守卫建立后几分钟，另一个并发改动修掉了 `highlight`
 * 分支里一个**既有笔误**（`style="background: #f3f3f3; padding: 8px;>` 少了收尾引号，从本文件创建
 * 那次提交 `5e08dbf7` 起就在，影响面只有 RSS）。🔴 **本守卫立刻红在恰好 7 个「含围栏代码块」的
 * 用例上**（`code-cjk` / `code-lang` / `code-nested-fence` / `code-tilde` / `math-mixed` /
 * `more-in-code` / `sec-html-in-code`），而那正是这个笔误唯一影响的形状 —— 也就是说，**它在写好的
 * 当天就抓到了一次真实的渲染变化，而这件事此前十五个月没有任何测试发现**。确认该变化是有意的修复
 * 之后才重新生成哈希（重新生成后又核对过：51 例里 44 例 sha 不变、变的就是上述 7 例）。
 *
 * ## 本守卫建立时（2026-09-21，W1 依赖升级窗口）实测到的差异
 * 升级内容：markdown-it **13.0.2 → 14.3.2**；katex 插件 `@traptitech/markdown-it-katex` 3.6.0
 * → **`@mdit/plugin-katex` 1.0.1**（其 katex 依赖 **0.16.47 → 0.17.0**）。
 * 差分语料 59 例（51 合成 + 8 篇真实文章，真实文章只用于差分、未入库）：
 *   · **markdown-it 13→14 单独升级：59/59 逐字节相同**（插件保持不变时）；
 *   · **插件替换：57/59 相同**，2 例不同且都只差 **1 字节**；`getDescription` 与 `renderInline`
 *     两种输出 **59/59 全同**；渲染器选项（html/breaks/linkify/typographer）一个没变。
 * 已把差异**完全归因**到两处（都在块级公式上，且都不影响可见渲染）：
 *   1. 外层容器写法：`<p class="katex-block ">` → `<p class='katex-block'>`（**−1 字节**，少个尾随空格）。
 *      ⚠️ 全仓对 `katex-block` 这个类名的字面依赖是 **0 处**（grep 过 ts/tsx/css/less/scss/js/jsx/md），
 *      katex 自己的样式表用的是 `.katex` / `.katex-display`，两者都没变 ⇒ 惰性差异。
 *   2. `<annotation encoding="application/x-tex">` 里的**前导空白**：源文写 `$$  \\frac{…} $$` 时，
 *      旧插件会**裁掉** `$$` 后的两个空格，新插件**原样保留**（**+2 字节**）。这只影响 MathML 的
 *      annotation（承载原始 TeX，供复制/无障碍用），**不影响 `.katex-html` 的可见渲染**，
 *      而且「保留作者原文」更忠实。语料里的 `math-block-leading-space` / `math-mixed-blocks` 就是钉它的。
 *   ⇒ 净效果：每个「`$$` 后带前导空格」的块级公式 **+1 字节**，其余块级公式 **−1 字节**。
 *      实测两篇含公式的真实文章：一篇（行内公式，2 处）**逐字节相同**；另一篇（4 个块级公式）
 *      **+4 字节**，逐个枚举出 8 个差异区段 = 4×(−1) + 4×(+2)，与上述归因**逐项吻合**，
 *      `katex-mathml` 计数 21→21 不变。⚠️ 「字节数对得上」不等于「差异被解释完」——
 *      第 2 条差异正是靠逐个枚举区段才发现的。
 *   · 另：katex **0.16.47 与 0.17.0 对同一批公式产出的 HTML 逐字节相同（8/8）**，所以前台仍然加载
 *     自己的 `katex@0.16` 样式表是安全的；RSS 模板里写死的 `katex@0.16.9` CDN 链接也仍然正确。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MarkdownProvider } from 'src/provider/markdown/markdown.provider';

const FIXTURE_DIR = path.join(__dirname, '../../__fixtures__/markdown-golden');
const UPDATE = process.env.W1_GOLDEN_UPDATE === '1';

// 黄金 sha256：用例名 → 三种输出。由**真实 MarkdownProvider** 渲染后计算（不是手写的）。
const GOLDEN: Record<string, Record<string, string>> = {
 "blockquote-nested": {
  "desc": "a56e8c3294de97d454d3ca0d44559b3d16205615afb9d5f8662fe31c55410417",
  "html": "c40ea38a86ff5b17ff4690fae9488c304dc3f4cface0c13ad6e7651116351602",
  "inline": "efb097d04615a99a84b1beb6dc187b3df0e1fbc2183397dd8f72b624c29b8f6c"
 },
 "code-cjk": {
  "desc": "4d63ece32b505b7632616110b3847f0607d349275991863bdce42431a248a354",
  "html": "dd14c77e99ddf05dab0c723318b36d52bc3e66d0cade46fbc7267869cf32770b",
  "inline": "1790d9844c0407d57369d5f2d319e2bb4a9305f14925db8b1b1dd523e9bbf5f3"
 },
 "code-indented": {
  "desc": "c0d13b8662027dbcd60ce5e370bc00f622be8fd2b1a924584aeb3c2fb49e77dd",
  "html": "bfd57cbcc12d11019ecd4f8022640b222a6b69b675498197c13b68feaea606db",
  "inline": "acef1a92830fdd0b8dff95bc73c77bde9bd263b0aabd84de08215ad163264ea9"
 },
 "code-lang": {
  "desc": "02e000f006b771bf16c97cc2c4788cbc437849b0125a73e940e1e926c9f2785b",
  "html": "94886522452d99212e9b598f1132942000fd214d8f179892c0d7e1ba8b7c407e",
  "inline": "da2c0b3c092b4735a687d01525905329e369480aa59ccac93dfafc0ee4195cb7"
 },
 "code-mermaid": {
  "desc": "5f64c2af451c9dd0f62c76476fb52bdc5631d1fa1530d353d4fa8c0dce09a4d6",
  "html": "ce7efc25398b31c79e4cbef169b3284a1291302322ea65aaeac58f5abc8d3a4b",
  "inline": "e564fee50e8af2fb1c29cd4f19faba73fccf46b9c695e48a99a48987579efdd8"
 },
 "code-nested-fence": {
  "desc": "8495e9bc59b6ff75b60902c95928186721ad74a55251b1529693d8e9c870fc8d",
  "html": "573df76be89a93cc237dfe7c3e4a9e36804e51abbe6ef37658e4e5a5d28903ea",
  "inline": "f324db4543a2c8574e7ba344823c6891be646f9221fd2a23ade8ad4096c3dbb4"
 },
 "code-tilde": {
  "desc": "002c3a1cd566be346a31186b3eede0ed29a7804df555b83f2389166f2c37b0f1",
  "html": "4fa6150635935be0f07649708051475aba805c824bb17af265c0cec069a4c5f6",
  "inline": "f86f6c117d5094d3ecc8cd3cf8a508db1a8ffd78285a625a46470b89bd75019b"
 },
 "code-unknown-lang": {
  "desc": "ea7e5da35587fc23bf8e0d56e8690ad48869ed385dc33f9bf64d3f3823ff6913",
  "html": "7cf386ad22d0d1aa8ec0a34bc89db4bff43dce7c936b1805a5f800516cf663b1",
  "inline": "14605c2cc6029dc991ca1c7b5ed1ae6af7399e8101cb14ea50c0215ebb658d5a"
 },
 "definition-ish": {
  "desc": "8d511d259460dfa8a1e8bf1e6ec2997c50f3e3eddc505aa1873ea2c418974383",
  "html": "f7b902d4f4fb8ee48aa39d940f71d2159cae0455830b07ad121690d126c1de9e",
  "inline": "62ffceccc7a917c5e6718e9201c6df8488310a3e76c78333adb5306561b49c33"
 },
 "emoji": {
  "desc": "fc5577d10d61424b131b5c949f3b6a77a33b0d3152cc41467716a9ff5a1a17d6",
  "html": "d60c2f005f2aba65b4a3994111a78e4853a7c2e8b85fb3a71a442b83506afee2",
  "inline": "a1075a2feaeb78eae67e4ee94b784018a26b08209ca58c52fae57a836ce48582"
 },
 "emphasis": {
  "desc": "3d5357e24bb958084542b4b290b66c8ab12ba8f91bf4b95c728982cc1d86d3dc",
  "html": "2e749dfebb0bf7773f720bb520e951cf37ebafc9262b70187f6d1b684012c46a",
  "inline": "7d61ecea873307b0be3adb42d9a5b2ac0e6898a46f9efad6dcf96ab900fd90f0"
 },
 "footnote-ish": {
  "desc": "2c339ca62fd23ac0ddfaba3fcaff25a98c67eae99430aadf9b0749a3788dabeb",
  "html": "7ea43ad9f7b800a0f7ad33d6a165d73bb3f77867d8e71101480826b7e0bcba60",
  "inline": "3c899c8cdfa46dfecdb9e929991dce4723dd9c9aee743985620121f12eb9ec02"
 },
 "frontmatter": {
  "desc": "d4092b944c507e0674eb8516c902b626a51ef10e367da6b57e0dc97549d3f555",
  "html": "3e849d0083c1458f86077c93b8772f18f69034db0b24ca5f3f9bdb70df9b46a4",
  "inline": "d6d093731c60d26c07cfa0d36f214e2accebf88c91a0f2fa16b72cba20210a34"
 },
 "hard-breaks": {
  "desc": "74fd3bca48c6a1e936a4c52fe077398695c53c384d065496e345dff421b9d2be",
  "html": "451ea3824f21700728f478fd15e8643da5ec75f9559f152b7688d29b5e9897f8",
  "inline": "139c0ea04bf3c80e58eed9328e893c7207469fca289fe9df731d84573630635e"
 },
 "heading-setext": {
  "desc": "18dd172e300280557799c6fd0bbad7a7c5e8faa55c55f843c6149e3fb043d9df",
  "html": "35bd95a673ddd62aa7fb0b64366ff530dbff90e1238f384c7eefbd3a746f019a",
  "inline": "266b18e90a7901b84a49a883e4d076ad5f0a133a7ddb64bc084afb2790f732da"
 },
 "hr-variants": {
  "desc": "2f6978703b53494637f35b4e00ffc13adaef578a618ad8db1092fd597a252840",
  "html": "e5482c783d5d403e06808169bcde448a22e0922b5c65a2a87fe31a086263cc9e",
  "inline": "c89d28c14d162aae7e6a5ffb008c8653c28ef23ed29311a5933c1c1688b32e63"
 },
 "html-block": {
  "desc": "116fa07a8004fdff8748e6a205bd98003a30da7908cb7a174be602b4f9cbf863",
  "html": "116fa07a8004fdff8748e6a205bd98003a30da7908cb7a174be602b4f9cbf863",
  "inline": "3a469014f4afac3054d3d2054e0da0051ff7a313d4dbbbe2e17490339dc617bc"
 },
 "html-comment": {
  "desc": "4a12bca9c032dda625efa5835e8e63b59aa8d619e9a6881ea55c2d28ee4f36d9",
  "html": "58b943a47613e12afee2c8fb600b7718961e3d964b273f333d9ff3f10f74822d",
  "inline": "2b43852a2875c9a79ee1301f2866d4ffa41ca99406cec61f5ae50912705a8431"
 },
 "html-entities": {
  "desc": "aa311ffbe089162b78d6e81255e3530f29c9dbf780f49adf33161ef110705815",
  "html": "517994e7480dd2236226fe25254f0343bbd10a2b79d2f1d14f6306d12481c71a",
  "inline": "498694535728933054d1740c57cc03dad6988a8417a9ecc1d1d34c2bc5ef11e1"
 },
 "html-inline": {
  "desc": "0cdb1f742b6684074f45fa1ab3291ca6f99f4ecc3194a1f01be8c06016dfc0c1",
  "html": "414f39b88930b5789fe7d0dcb1f6ae0f2ff416d61cc60bc9736870531984b2c0",
  "inline": "676c126b96d5b13fa30655deb5ecc104561888f4aa1806ddaeec7a220cadafe0"
 },
 "link-relative": {
  "desc": "d07128cd94b68d48253a08950f113df952ae092ba15a4742f688e59edc3fc9da",
  "html": "f86adc2e8b6583808531ea4dca24ecdd75d7cc9553185d11c3345cd5fab146f4",
  "inline": "6038c7d183cddb9ec63e75cbca007b631d3592285ecada288d79820501558e9f"
 },
 "links": {
  "desc": "814a3348279d19611802bc86744e97e34789cf2070a78d14c4677b72f4f8f7d5",
  "html": "95c86f91a262673ab80e64a3384d9f5afd90f01f2fe920af117c2e51c41a3358",
  "inline": "8c640612af295220a7ef1de6424d8b5244ab20ea4acfab1a2a9cac0e1aa86957"
 },
 "list-loose": {
  "desc": "0aa23519bb6b4163a27ed459ade1c8262f20a4faad5f5fb66b6fc10e6acdd145",
  "html": "89689d34c66e29f62a75480aa74dfe1be4c6d5a21cf59affcbc7a0f9fa35a195",
  "inline": "a9eb630270e23703dfbd13ffe2f9f5cb89e8a19a38da759a5dfc168c93ef3c48"
 },
 "lists": {
  "desc": "f4f709cd4f0b35bc309d569227dd32682b7ef170b28210586b0adfa0fb31dea6",
  "html": "e06c1047ecefa6c4301b6035a1904561704550627b740bec22a05a222c408d11",
  "inline": "b43a6f6215370a7313490a2ed12f245443fbf1c280573067c3572a67db6db9f2"
 },
 "long-line": {
  "desc": "6aa7c786894c212d88300d191064487b6e9d79f70d8781e817e9bf051f67a78f",
  "html": "8bccf9e728a4f8be7940c268ed34e6334985010773f80f2dbad9d3486ddcf996",
  "inline": "079a3ebaaa679917d3620c999afa84dd0dad3eb4ccb33c52bd9e165b3f2bb721"
 },
 "long-word": {
  "desc": "c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5",
  "html": "a667f51521bdb3eeece9f205140ca71a44dbb22e381dc7ba4705b1fe204221fe",
  "inline": "a8eff21f594f5798d51e71dee91ee433bb09b1e43540c27a28ba193c9b0ea7ca"
 },
 "math-block": {
  "desc": "e661d72eac951385d43b96bc1a5e77bb7e46c632d5ac0bcac2441bb9c58c7049",
  "html": "fad04b84a6dd7663d3e71fd348251e7f1ed3ad8f90f5fb7abfd14e463b75840b",
  "inline": "84c1350de6b1c021ffcfedd2276beb18f96abc84a35a892e0b8741834993fdb8"
 },
 "math-block-leading-space": {
  "desc": "e9af864a5abc6270aa1034a923e5abfc201f44d30d56dd0ab537ccc149ce2e50",
  "html": "f24255ef2317c54822c0c3b62580c67daa836773414f47427d85840f09adf1ab",
  "inline": "0fa6df57d87068bf7ed677f64afc6a6e8f5d88af4b814816f4fde5327f99c98e"
 },
 "math-cjk": {
  "desc": "4795d43048efae31f6095a37ab0a4678b690ce7c61bccff2b8b2d17729a003b4",
  "html": "e92f4a54e5d5954be822f7d0f834916bb30e9d43ea60792cca72db919c509988",
  "inline": "475623ecbf1c225fd82e751dbc2ee73ce4e5d8cada442cbd7af597f3e40386cc"
 },
 "math-dollar-noformula": {
  "desc": "df94019f6c8ade12a4f93ebea902341068396abc497f7c491c1b702cb7027f47",
  "html": "f29905b28f95e4b2a9dd8db82ea69e2fd8b182ebb5b8bf62c55a022936c64996",
  "inline": "9b29d78a3641e14a77a7cb3fb17fa28b8fbd7dd7dafb432b45dd16f39b09dd7b"
 },
 "math-escape": {
  "desc": "a23a9259b66fee23bc94650feca53223c0f407bfee1c04fc31925791644c77f0",
  "html": "8ebee5721ffc3ae325cc7f5197df46eb227a298d337d2966e18ebd4ebbd0ba4e",
  "inline": "672298b99783e7031f0a07732b29ced7f2d5722f81dea0519d7a3e954fa09839"
 },
 "math-inline": {
  "desc": "fdd6e8741bdfa864da0d6d7ef6aaf270a350184aa2cd6b3ca335ee06b40aad03",
  "html": "54011bc714f1e0cfe9cf2c618fb7a6867993fd61735d3e3da0c1e8497ee0180f",
  "inline": "a29bf7fe534837797446f781726f0d4e67ef7733b2cf90b16d94d20f6b47a122"
 },
 "math-mixed": {
  "desc": "18ff09a6690acb598f7dddb8b85e24c0b41abc4820325a50e8c6eefef1488746",
  "html": "277b7f31760651fbe0bd6f64a4ccd441567a4bbd54c5d770bae39a66ae3a7a23",
  "inline": "85076d3d3a29090b54e518974087b0b225f0d10a3819b9cd9fff34c12d8f327b"
 },
 "math-mixed-blocks": {
  "desc": "8a640e2f4acc420781be30078f4f47d240065a995f8e231e474eecb0079aa323",
  "html": "900b5dfd2d5f2a70509711645b1ed3c5d6ffee8cea2fcae8a8a9ee4770b65654",
  "inline": "17dd337626cf619b6099a1ae0f96b642f4ccfe630716e09f30b2a6098181137e"
 },
 "math-space-padded-inline": {
  "desc": "aab8e1aed0afb8c5ac0bc419cafef8b533453ca95a663f4970a7170cccea03d9",
  "html": "e619f0ffdccb25d172f1d3dbc682338e00f343f203628869f8e104ad5172c9f5",
  "inline": "6705f756155c0d3ccb02ccf2f0dac237f53667de40a0c54e9ce510e2d2ff97c1"
 },
 "math-unclosed": {
  "desc": "134fc2ca12e6e1611be4539584f70d2e7769492c08e451a72e440af07d630667",
  "html": "7663fe7deccdc68369f55726efd981f5fbd8469e8f7dc18b8a88d99b310b0ef3",
  "inline": "0449e329d1e16b278e760e2d2c9c7970a20cdc1c50d70a417bea0bfaae376ea8"
 },
 "more-in-code": {
  "desc": "cd8f833f8b39d13abfe4e1dfe12f191b0bf0952a5632a014d166442a9d9b8ade",
  "html": "43a6ce138e4fe29ecbd6ae3e3e9059bf1f9f4d05f898bd655246407b3f0b7acf",
  "inline": "e3d7b1855a5524ac8c45316bdaeb8233f4fc59cfe98a4946978d1768d12fd660"
 },
 "more-marker": {
  "desc": "7ac1cd6565ae762e7dc50f2a6976756a2ad7c6228a56a685421e402136304ec8",
  "html": "3b231a73f0beae8a4ac3b0ee523cfca38ea260d8abcff4c21a682884030e0429",
  "inline": "3e40186ed7deb8fec205518ad9879272809e049eef0c4eeaba9db90f28cd352b"
 },
 "sec-autolink-js": {
  "desc": "046587dac59ced3c766de9f70c88110035ab52d4641a96e4ce8ffe61c60c2488",
  "html": "2b8926ff813889bc517eedbf6eefd60059c91103609448977c23815ad0a3f5f0",
  "inline": "e04922ccefacaa883b1f1cccc86e12fce24903d7e8dda47842cd5909e625854d"
 },
 "sec-data-url": {
  "desc": "7cf52730d2f6658ec337a8ea7bffb36cdc2c9420d1b67480fe3574900a704d17",
  "html": "5782afe74304c345fc078c5d653a2a5b5358590527889d2d69fc7dc7ef9c3d38",
  "inline": "077a2356904a6c953633c343db04e3bb166949b41bc10f111039f2b209c95ce1"
 },
 "sec-html-in-code": {
  "desc": "0d3cf6328f7159f5f9ef856b6b7b3abe5978115d68276b76791795bc742d427f",
  "html": "782c06ad17bb9d891f5dbc6b1be24bd9693279d89b9cb83abcae7c92790f6ba8",
  "inline": "80a138c38ffaf2b303066ff909cdfd9a0ab3eb4d6bffb734f22fd762193dae12"
 },
 "sec-iframe-object": {
  "desc": "b08fc03056ab7de8d206d88d77621074499ca3393c37f41abcbc3abf4d6f5858",
  "html": "b08fc03056ab7de8d206d88d77621074499ca3393c37f41abcbc3abf4d6f5858",
  "inline": "9a2cc0e50904370c1530dba006c732fdc48f05e74c0790a2b3471d480a18a378"
 },
 "sec-img-onerror-md": {
  "desc": "1e94420f46c993464cac140efa5432473b1185fb2859d6d43d38c34727236151",
  "html": "e4cca01eb0a243c72ad03a6579c97446f36ce52f90181031da67bb81424a0916",
  "inline": "dc671ff274f6f28e553596ab4d5523c9f155611b7617d0548d67688cef6203e6"
 },
 "sec-js-url": {
  "desc": "10424247c6d42f649684e8855a63a56c6eaf3a72102660a56a929a2b3b152d23",
  "html": "b8f6eeb3ad197fbea7fad9c8c39833d334fea6d6215ae8a4e11a12a260c89839",
  "inline": "b471b18d1009a8f44e130da8276b23b2c64fddb8981bcfaa63c64cf020ffcaa2"
 },
 "sec-math-xss": {
  "desc": "02eadc01f465c7b7d8a12a014750a266e3ac4ab9511bec73141c0586e55fbdb9",
  "html": "55618daddcee0413cd81cd039fc4e252062d54ea1883ed92818e5c97950d92d3",
  "inline": "9bc5e2dddd1963c933729fe773301a133cae062b15818bb80de2b6448166e884"
 },
 "sec-onerror": {
  "desc": "e1554589697c8066064eca35c61ed4695f16ad0c6c96ec0424179c8a78d911e6",
  "html": "608e8d5d843a2681a2b6b84a4336d6833cac76769d75db8cbec6d518d22dcd42",
  "inline": "dd29d8772596a2e56d979aee6951c66daf48cecb2bbad7753211f23b9cec94f3"
 },
 "sec-ref-js": {
  "desc": "8b69b9e67a18979abdc29fd36cf354d362fdb225de641c8950ea43eb384758f4",
  "html": "62fa9f8a8b514359256006c06492d67a774eb93dce06323b690a1c31643d96f0",
  "inline": "bbc1c863f7e083cecd113bfd0f20f38b38b84866ce1d2ec296daf68ea7365bbf"
 },
 "sec-script": {
  "desc": "30f756f1e4c25a44bc7494b0e101d6bd0c3cae2672419837ce430e3725f7e2fa",
  "html": "51d91fd4c99b350533eb55686954167a2e140a8b2c5d16c690ab6ee9150d5ad9",
  "inline": "e2e3de96b493e6efb4a5a76e7677ffd61eadcb5b4d4cf166bccf8e945ed98221"
 },
 "sec-script-block": {
  "desc": "6acae4076bf9023a7896ed4446416dfb193be2f5af5e19f464044d6722013820",
  "html": "6acae4076bf9023a7896ed4446416dfb193be2f5af5e19f464044d6722013820",
  "inline": "db9c997aa7e19e8a92caaed4c39764aee303f5e9f76e3c9d9d837e10c900a9e9"
 },
 "sec-style-expression": {
  "desc": "f405b9c911edff3486d3dda0a9d3131249e237de28c0eaef1e40485b16dc37e8",
  "html": "f405b9c911edff3486d3dda0a9d3131249e237de28c0eaef1e40485b16dc37e8",
  "inline": "b08b98d11c92ec2156f3365e074349703e8e44c401b6c817df9b415fb3b4e52f"
 },
 "sec-svg": {
  "desc": "b73df416ef95b44b2e03d6a413b0b889b989b6b7029ba4932e1067d7e0a25c11",
  "html": "40c377e6ff31f4fc0c1882d34d044d8b5ab226265835545f32f4304c1d2e71aa",
  "inline": "906a121261217a32748ee2a6d697fed3d0cc57bf03ee58ada0842632ebc9daf4"
 },
 "table-align-missing": {
  "desc": "069346a3ff631e94c28372a65b7668abbeaf9c07e4c8002353e2874c3ef29d4b",
  "html": "f2aac502c0dac2244aa39117167cd1813895a3ea8fc7271dde687deec2636269",
  "inline": "f9702977420ea3ba07aad983d9692b8313bc814ae7da708b27c0e1ab2e76a6a4"
 },
 "table-basic": {
  "desc": "55718257103014534c01e0edd53a8ae0f0b82ffcd94b3ae3a7551585e0d035ae",
  "html": "3ac88201cb873158d11be422c64532ebac06c60c235ffb99ac0ba846c4c6f8ca",
  "inline": "6d6eec3735aa219a3331efb4a759d334d1aabec14b9b105e8f226fe5154c158c"
 },
 "task-list": {
  "desc": "f1a85c376a7263ceb998032e30c18f22c97aef3a9a3a9e59194fdcf71f568136",
  "html": "7e08e116d174f01ea10a1e6131845b9253227811d592be8eb316682523faa239",
  "inline": "8ac4c5342cafd9d82027c3066def8a0bec3654a67052e4582174e1bf4a375d92"
 }
};

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function readCases(): Array<{ name: string; md: string }> {
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ name: f.replace(/\.md$/, ''), md: fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8') }));
}

describe('markdown 渲染黄金输出（依赖升级的回归网）', () => {
  const provider = new MarkdownProvider();
  const cases = readCases();

  // ⚠️ 反空转：fixture 读不到 / 用例数不对时，「全部一致」会恒真
  it('语料确实被读到（尺子有效性）', () => {
    expect(cases.length).toBe(54);
    expect(cases.every((c) => c.md.length > 0)).toBe(true);
    expect(Object.keys(GOLDEN).length).toBe(54);
    // 危险 HTML 与数学那两族必须在场，否则下面那些断言就是空的
    expect(cases.filter((c) => c.name.startsWith('sec-')).length).toBe(13);
    expect(cases.filter((c) => c.name.startsWith('math-')).length).toBe(10);
  });

  it('每个语料的三种渲染输出都与黄金 sha256 逐字一致', () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const actual: Record<string, string> = {
        html: provider.renderMarkdown(c.md),
        desc: provider.getDescription(c.md) ?? '',
        inline: provider.md.renderInline(c.md),
      };
      const want = GOLDEN[c.name];
      if (!want) { mismatches.push(`${c.name}: 黄金记录里缺这个用例（新增了语料？）`); continue; }
      for (const kind of ['html', 'desc', 'inline'] as const) {
        const got = sha(actual[kind]);
        if (got !== want[kind]) {
          mismatches.push(
            `${c.name}.${kind}: sha 不一致\n  期望 ${want[kind]}\n  实际 ${got}\n` +
              `  实际输出前 400 字符：${JSON.stringify(actual[kind].slice(0, 400))}`,
          );
        }
      }
    }
    if (UPDATE && mismatches.length) {
      // ⚠️ 只打印清单，**不自动改文件**（自动改写会让这条守卫失去意义，见文件头）
      // eslint-disable-next-line no-console
      console.warn(`W1_GOLDEN_UPDATE=1：以下 ${mismatches.length} 处需人工确认后手工更新 GOLDEN`);
    }
    expect(mismatches).toEqual([]);
  });

  it('渲染器选项没有漂移（这四个决定用户可见的渲染行为）', () => {
    const o = (provider.md as any).options;
    expect(o.html).toBe(true);
    expect(o.breaks).toBe(true);
    expect(o.linkify).toBe(false);
    expect(o.typographer).toBe(false);
    expect(typeof o.highlight).toBe('function');
    expect(((provider.md as any).core?.ruler?.__rules__ || []).length).toBeGreaterThan(0);
  });

  /**
   * 🔴 这一组**不是**「升级前后相同」的判据，而是把「服务端这一层的安全姿态」写成显式事实。
   *
   * 事实：`MarkdownProvider` 用 `html: true` 构造 markdown-it，**没有**做任何 sanitize，所以
   * `<script>` / `onerror=` / `<iframe>` / `<svg onload>` / 原始 `<a href="javascript:">` 都会
   * **原样出现在服务端渲染结果里**。
   *
   * ⚠️ 这**不等于**站点有 XSS：文章正文在前台是由 `packages/website` 自己用 bytemd → remark →
   * rehype-raw → **rehype-sanitize**（`utils/markdownSanitize.ts` 的 schema，明确不允许 `<script>`、
   * 事件处理属性与 `javascript:`）重新渲染的；那份 schema 的注释里也写明「只有 article:create/update
   * 的协作者不算可信作者，所以这是一条真实边界」。
   *
   * 🔴 但服务端渲染结果**确实**有一个对外出口：**RSS/Atom**（`provider/rss/rss.provider.ts` 把
   * `renderMarkdown(article.content)` 塞进 feed 的 `content` 与 `description`）。可达性：文章正文由
   * 管理员/协作者撰写（**匿名不可投递**）；评论走 waline 自己的管线、不经过这里。最坏后果：一个恶意
   * 或被盗号的**协作者**发布含 `<script>` 的文章后，RSS 里就带着它，由**订阅方**的渲染器决定是否执行。
   * ⚠️ 这是 W1 窗口当时的既有状况、升级**没有改变它**（13 例 `sec-*` 在升级前后 sha 完全相同）。
   * ⚠️ 如果后来给 RSS 加了消毒（`utils/rssHtmlSanitize.ts`），那属于**有意的安全修复**：
   *    本守卫钉的是 **provider 这一层**的输出，消毒发生在 RSS 那一层，所以这里**不应该**变；
   *    若这里真的红了，说明消毒被加进了 provider，要按文件头的流程逐条确认后再更新哈希。
   */
  it('🔴 显式记录服务端渲染层的安全姿态（html:true ⇒ 原始 HTML 直通；边界在前台 sanitize）', () => {
    // ⚠️ 逐字直通：标签与脚本体都不被转义。（脚本体里的引号只有在被当作 inline 文本时才会变成
    //    &quot;，见 fixture `sec-script.md` 用的是 alert("xss")，其输出确实是 alert(&quot;xss&quot;)。）
    expect(provider.renderMarkdown('文本 <script>alert(1)</script> 结束')).toContain('<script>alert(1)</script>');
    expect(provider.renderMarkdown('<img src=x onerror="alert(1)">')).toContain('onerror="alert(1)"');
    expect(provider.renderMarkdown('<iframe src="https://evil.example"></iframe>')).toContain('<iframe src="https://evil.example">');
    expect(provider.renderMarkdown('<svg onload="alert(1)"></svg>')).toContain('onload="alert(1)"');
    expect(provider.renderMarkdown('<a href="javascript:alert(2)">x</a>')).toContain('href="javascript:alert(2)"');
  });

  it('markdown-it 自带的链接协议校验仍然生效（markdown 语法写的 javascript: 不会变成链接）', () => {
    // ⚠️ 与上一条对照：这是 markdown-it **自带**的 validateLink，只覆盖「用 markdown 链接语法写的」
    //    URL，覆盖不了原始 HTML —— 两条合起来才是这一层的真实姿态。
    const out = provider.renderMarkdown('[点我](javascript:alert(1))');
    expect(out).not.toContain('<a href="javascript:');
    // 反证①：正常 http 链接**会**变成 <a>，证明不是「链接功能整体坏了」
    expect(provider.renderMarkdown('[点我](https://example.com)')).toContain('<a href="https://example.com"');
    // 反证②：输出非空，证明上面的 not.toContain 不是因为「渲染结果恒为空」
    expect(out.length).toBeGreaterThan(0);
  });
});
