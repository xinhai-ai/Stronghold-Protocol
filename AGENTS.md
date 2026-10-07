# 合并上游时的仓库约定

本文件适用于整个仓库，记录本分支相对上游增加的行为及合并验证要求。合并时保留上游的功能更新，同时维护以下约定；不要用整文件覆盖的方式解决冲突。用户明确调整需求时，以用户指示为准，并同步更新本文。

## 开始合并前

- 检查 `git status`、暂存区和上游差异，保留已有的本机修改。`config/announcements.json` 可能包含正在使用的公告排期，不要覆盖或顺手提交。
- 先识别上游是否修改了前端加载入口、模拟模块导入、静态服务、构建/启动脚本及监控接口；这些是本分支的主要冲突点。
- `public/build/`、`public/vendor/`、素材和依赖是生成文件，不应纳入源码提交。合并 `package.json` 的依赖后使用 npm 更新 `package-lock.json`，保留版本元数据一致。
- 本分支的相关实现起点为 `f164a5e`（Vite 打包、SW 排除构建文件、监控接口拆分）。后续合并以当前代码和测试为准。
- 获取上游引用后核对用户指定的版本标签及提交，不把标签之后的开发提交一并合入。先列出本次保留、排除和需要适配的改动；能按本文和用户指示确定的直接合并、逐段处理冲突，确实无法定夺的规则或行为先问用户。
- 排除一项上游功能时，同时核对其实现、提取/构建工具、清单、文档和测试，不能只移除入口而留下不一致的预期。共享文件中仍保留上游其他功能更新，不以整文件选 ours/theirs 代替逐段合并。
- 合并前复现可能影响验收的测试失败并记录证据。暂存时只纳入本次任务路径；同一文件含已有本地修改时按块暂存，提交后核对原有修改仍保留。

## Vite 构建与源码模式

- `public/index.html` 和 `public/js/` 保持为可直接运行的源码；不要用构建产物覆盖源码。
- `npm run build` 先运行 vendor 准备，再由 `vite.config.js` 输出到 `public/build/`。`base` 为 `/build/`，`publicDir: false`，避免将全部素材和可选字体复制进构建目录。
- `server/index.js` 在存在 `public/build/index.html` 时，用构建 HTML 响应 `/` 和 `/index.html`；没有产物时回退到源码页面。
- `npm run dev` 使用 `--source-client` 强制提供源码页面，即使已经有构建产物。生产源码更新后需要重新构建并重启服务。
- Preact/hooks/htm 应保持同一个 UI 库实例。渲染器、战斗模拟和 Three.js 保持按需加载，不能因为合并或分包配置变化进入首屏静态依赖。
- `vite.config.js` 对 HTML 有适配：移除源码 import map/modulepreload、合并页面 CSS、保留可选 `/fonts/fonts.css`，并让 Pixi/Spine prefetch 与实际注入的哈希脚本一致。上游修改 HTML 标签格式、脚本入口或字体顺序时，检查这些处理是否仍生效，尤其是样式覆盖顺序和启动失败提示。

## 浏览器模拟与动态导入

- `public/js/battle/runner.js` 的默认模拟入口使用明确的 `/sim/…` 导入，便于 Vite 解析并生成延迟加载的模拟包。自定义 `base` 的动态导入保留给工具和测试使用。
- `server/sim/content/index.js` 的技能层级和领域模块，以及 `bands.js`、`bonds.js` 的子模块，使用包含明确路径的加载回调。上游新增模块时同步维护列表及安装顺序。
- 不要恢复成单纯的 `import(path)` 或变量拼接加载列表：原生 ESM 可以运行，但 Vite 可能遗漏依赖。遗漏可能被原有异常隔离捕获而退回通用技能，因此“构建成功”不足以证明模拟完整。
- 保留模块加载失败的日志和异常隔离，不改变服务器原有规则行为。纯技能实现、常量和数据更新尽量直接合并，避免维护另一份浏览器规则。
- `vite.config.js` 将模拟依赖的 `server/data.js` 替换为浏览器数据桥接，桥接从同一份 `simdata.js` 的 `getSimData()` 读取注入数据，不能创建第二份模拟数据状态。
- 构建插件按 AST 移除 `simdata.js` 的 `if (IS_NODE)` 初始化分支，并拒绝打包 `nodeData.js`。上游改变该初始化结构时必须同步适配；不要把 Node 文件系统 API、研究数据回退或服务器数据加载打进浏览器包。
- `public/js/render/app.js` 使用 `new URL(..., import.meta.url)` 为 Pixi/Spine 生成哈希资源地址；Three.js 默认使用可解析的明确导入，自定义 URL 的加载方式保留。
- 合并后运行打包模拟与 Node 原版的结果比对；上游新增重要机制时，扩充有代表性的比对场景。现有几个固定种子不能覆盖全部玩法。

## 本分支游戏规则

- 模式的 `inactiveBondIds` 与开局随机盟约 ban 继续参与干员池过滤：仅当干员的所有盟约都在两者并集中时才 ban 该干员。保留 `drawDisabledBonds()`、干员池和本局禁用干员的现有行为。
- 模式名单不再禁止盟约激活或效果触发；保留下来的干员及装备赋予的盟约照常计数、激活并进入战斗输入。界面将模式名单和随机 ban 都解释为阵容不完整，不标注“该盟约不会激活”；AI 不按模式名单排除盟约，机变候选继续按实际干员池判断。
- 最终攻势及隐秘核心的 Boss 共享血量池：单人 `bloodPoint × 1`，多人 `bloodPoint × 4 × min(存活人数, 4) / 4`，存活人数取每个 Boss 回合开始时的值。模式及全局配置均启用 `aliveScaling`，保留模式优先、人数上限和未传人数按满队计算的行为；普通敌人倍率不变。
- 重新生成数据时维护 `tools/build-data.mjs` 中同样的血量配置，不恢复上游的单人 0.25／多人 1 或模式盟约激活限制。

## 本分支界面与素材取舍

- 0.1.4 合并时确立的取舍继续适用于后续合并，除非用户明确调整：排除上游快捷键实现，保留本仓库可自定义快捷键、默认按键、提示文字及浏览器持久化设置。当前默认 W 查看怪物、S 冻结、R 刷新、C 准备、X 出售、Q 撤退、G 升级、空格暂停/继续；不要恢复上游固定 R/F/D/Space 方案。
- 不合并 3D 棋盘贴图改用 WebP 的提取、加载、文档和测试改动，继续使用 PNG。其他棋盘材质、地形提示及渲染修复可正常合并；保留 `boardArt.js` 对裁切表素材路径的 CDN 改写。
- 标题页保留“关于本服务器”的联系邮箱、反馈入口、本分支仓库链接和纯公益说明。版权与免责声明以对应上游 `NOTICE.md` 为依据，区分自编代码许可证与游戏素材/数据权利，保留非官方、非商业、无担保、不索取游戏账号及权利人联系处理说明；上游声明变化时同步核对文案和链接。
- “关于本服务器”弹窗的正文可上下滚动，标题和关闭按钮保持可见；保留动态视口高度、安全区域、正文 `min-height: 0` 和触屏纵向滚动支持，避免新增文案在移动端被截断。标题页设置入口和资源预载入口均保留。
- 左下角“作战统计”按钮打开可在战斗中查看的小窗，保留本地实时干员伤害/治疗统计、整局累计与当前战斗切换和伤害降序排行；只显示自己的数据，移除玩家筛选及全队统计，观战席不显示统计入口。打开时默认显示“当前战斗”，该选项排在前面；“本局累计”由用户手动点击。同一玩家的同名干员合并展示伤害、治疗、DPS/HPS 和分色横条，当前战斗及本局累计使用相同合并规则。查看队友战场时，统计仍读取自己的战斗，不随观战画面切换。物理/法术/真实/元素 HP 伤害使用分色横条；统计实际扣血与有效治疗，召唤物归入所属干员，不将元素积累、过量治疗或友方伤害计入输出。DPS/HPS 按本机已模拟的自身战斗时间计算，暂停与倍速不改变口径；补帧、后台模拟及重复观战不能漏计或重复累计。统计不上传服务器，保留移动端触控、滚动列表、安全区域及角落按钮换行后的弹窗定位。

- 匹配倒计时显示“匹配剩余”，使用服务器校准时间。新的可兼容真人队伍加入时，按实际组队容量重置同组成员的 AI 补位截止时间，并同步 `match.queue` 和房间 `matching` 状态；满队立即开始。`match.queue.count` 只统计该玩家实际分组的真人数，不使用同模式、同难度的全部排队人数；人数广播、倒计时重置和开局使用相同分组规则。队首未满且未到期时，继续处理后续满员或已到期分组，不阻塞整条队列。其他难度、不可合并队列、容纳不下的队伍、取消匹配和定时轮询不能重置该组倒计时；保留原始 `queuedAt` 作为排队顺序。

- 设置保留浏览器持久化的帧率上限：不限（默认）、30、60、120 FPS。仅限制画面渲染，Pixi 干员/特效与 Three.js 棋盘共享限帧，简化 DOM 战场也遵循上限；战斗模拟、计时、倍速及联网结算保持独立。旧设置或非法值回退为不限；自动画质降级阈值适配主动限帧，不能将稳定的 30 FPS 误判为性能不足。

- 公告在 `config/announcements.json` 中分为 `type: "scroll"`（默认，兼容旧条目）和 `type: "popup"` 两种独立类型，分别选择当前有效内容，可同时展示，等级、过期、撤回和关闭互不影响。滚动公告保留原行为；弹窗公告支持可选 `title`、HTTP(S) 详情 `url` 和 `autoPopup`（默认 false），公告按钮只打开当前有效弹窗公告。自动弹出按浏览器记录最近 100 个已查看版本，刷新、重连和恢复旧公告不重复弹出；标题、正文、链接、自动弹出开关或有效时间变化视为新版本。保留无公告状态、过期/撤回处理，以及可滚动正文、动态视口和安全区域。大厅及房间将在线人数放在原延迟右侧，共用延迟胶囊样式；原在线人数位置改为公告按钮，标题页和设置也保留入口。WebSocket 保留 `announcement` 为滚动公告，新增 `popupAnnouncement`；`/api/announcement` 保持旧滚动接口和内容摘要，`/api/popup-announcement` 独立提供弹窗公告。

## 运行时 CDN 配置

- 页面素材与数据 CDN 地址来自服务器动态生成的 `/js/asset-cdn.js`，分别导出 `ASSETS_CDN` 和 `DATA_CDN`，并非 `/healthz` 或 `/metrics`。磁盘上的 `public/js/asset-cdn.js` 是两者均为空的配置回退。任一 CDN 设置变化都必须改变运行时模块的 ETag。
- Vite 必须将此模块保留为外部的同源绝对 URL。保留 `makeAbsoluteExternalsRelative: false`，避免把 `/js/asset-cdn.js` 当成文件系统路径改写。
- 同一份构建可以通过启动时的 `SP_ASSETS_CDN` 和 `SP_DATA_CDN` 使用不同 CDN。不要在构建时固化环境配置，也不要把磁盘上的空 CDN 配置直接内联。
- 页面数据加载器、浏览器模拟和独立素材加载器直接读取数据 CDN 的静态 JSON；`shared/cdn.js` 的 `dataUrl()` 保留 `/data/local-assets.json` 与 `/data/resource-manifest.json` 的同源例外。显式传入的加载器 `base` / `url` / `dataBase` 仍优先，不能被运行时 CDN 覆盖。Node 的 `/data/` 始终提供本地数据，已移除数据 CDN 的 307 跳转，不要在合并时恢复；保留素材清单 URL 改写，合并后运行 CDN 测试。
- CDN 回源可使用 Nginx 静态文件或 Node 的本地数据响应，配置 JSON 跨域响应头并保持数据版本一致；游戏源站的运行时配置、本地素材清单和动态预载清单继续由 Node 提供。
- `public/js/render/boardArt.js` 读取静态 `tiles.json` 后也要改写 `source` 中的素材路径；仅让裁切表走 CDN 不够，否则 D、common_D、BG 图片会回到源站。保留无 CDN 和已有绝对 URL 的行为，用 `test/render/boardart.test.js` 验证。

## HTTP 缓存、Service Worker 与更新检测

- HTML 保持 `no-cache`；`/build/assets/` 下带内容哈希的 JS/CSS 使用 `public, max-age=31536000, immutable`。运行时配置和非指纹代码不能套用此长期缓存。
- 保留 gzip、ETag/304、HEAD 和原有素材 Range 行为。
- 素材预载 SW 的 scope 为 `/`，但 `/build/` 必须直接放行，不调用 `respondWith()`。即使 Cache Storage 已有旧构建文件，也不能用它响应代码请求。
- `public/js/resources/common.js` 和 `server/resources.js` 均明确排除 `/build/`。原有规则会匹配路径任意位置的 `/assets/`，用于兼容 CDN 前缀；不能因 Vite 也使用 assets 目录而再次误匹配，也不要直接改为只匹配根 `/assets/` 而破坏 CDN。
- SW 保留素材、字体和音频预载功能；`public/resource-sw.js` 及其依赖仍单独提供。修改这些依赖后，部署时须让浏览器更新 SW。
- `buildGuard.js` 启动后及每 60 秒读取 `/healthz.build`；连续两次确认版本变化，非对局时刷新，对局时提示并等待结束。保留失败/超时不刷新的行为。
- `computeBuildTag()` 区分生产构建和源码模式：生产检测构建文件及独立 SW 依赖，源码模式检测原来的源码入口。构建标识在服务器启动时计算，不应在每次健康轮询中重扫文件。
- `emptyOutDir: false` 用于保留旧哈希分包，供尚未刷新的页面继续加载。在线更新先上传新资源，再替换 HTML；不要在线删除整个构建目录。旧文件清理安排在维护停服期间。

## `/healthz` 与 `/metrics`

- `/healthz` 保留 `ok`、`version`、`app`、`uptimeSec`、`build`。
- 以下计数也保留在 `/healthz`：`sockets`、`sessions`、`rooms`、`matches`、`roomMatches`、`standaloneMatches`、`humans`、`bots`、`spectators`、`queued`。不要因精简接口删除这些字段；沿用现有统计含义。
- `/metrics` 返回 JSON，包含健康接口的上述字段，加上详细状态：`persist`、`workers`、`memory`、`staticCache`、`usage`、`socketBuffers`、`announcements`、`websocket`、`assetsCdn`、`dataCdn`、`limits`、`tuning`。
- 详细统计只在请求 `/metrics` 时采集；不要重新放入页面每分钟轮询的 `/healthz`。保持原有字段名、结构和未启用时的 `null` 语义。
- 两个接口均支持 GET/HEAD，保持 `Cache-Control: no-store`，其他方法返回 405。`/metrics` 保持 JSON 接口；若要改为其他监控格式，需要用户明确调整需求。
- 启动脚本、Docker 健康检查、`tools/doctor.mjs` 的端口探测和页面更新检测继续使用 `/healthz`。完整监控数据的读取者及文档指向 `/metrics`；公开统计中不列出客户端地址。

## 构建与发行入口

- 保留 `tools/setup.mjs` 在安装了 Vite 时的构建步骤及 `--check` 的只检查行为；已含构建产物的发行包不依赖 Vite 运行。
- Docker 构建阶段需要开发依赖和 `vite.config.js`，完成前端构建；运行阶段仍只含生产依赖。`.dockerignore` 排除本机生成的 `public/build`，避免带入旧产物。
- `scripts/make-windows-bundle.mjs` 在源仓库构建，再把 `public/build` 一起放进便携包；包内只安装生产依赖。构建失败不能先删除上一次的包。
- CI 保留生产构建检查。上游调整 Node/Vite 版本、vendor 库或构建工具时，核对支持的 Node 版本与锁文件，并验证发行入口。
- 更新资源、重新生成数据或合并上游导致 `data/` 变化后，提醒用户运行 `scripts/copy-data-to-nginx.sh`，同步到 Nginx 实际提供数据的主机目录。当前使用 `srv` 目录时，在仓库根目录执行 `sudo bash scripts/copy-data-to-nginx.sh ./data /opt/1panel/www/sites/wei.linxia.dev/index/srv`；该路径在容器内对应 `/www/sites/wei.linxia.dev/index/srv/`，须与 Nginx 的 `alias` 一致。脚本默认目标为 `index/data`，使用 `srv` 时必须显式传入目标，避免复制到错误目录。
- 复制脚本只同步 `data/`；图片、模型、音频等素材有更新时，还需同步到素材 CDN 的实际目录。提醒用户按缓存策略刷新 CDN 缓存，并确认 CDN 数据与游戏服务器为同一版本。

## Docker 发布与更新提醒

- 用本分支更新后的源码构建镜像并重建容器；仅 restart 旧容器或替换宿主机源码不等于升级，不用上游原始镜像替换本分支实现。Compose/1Panel 的实际服务名、镜像标签和构建上下文以部署配置为准，不假定仓库已有 Compose 文件。
- 保留原有环境变量、端口、网络、挂载和公告排期。发布前保留旧镜像及对应数据/素材清单/CDN 副本，优先在无对局时更新；未配置 Redis 时重建容器会丢失内存房间/对局，配置 Redis 时保留 URL、prefix、持久化卷并优雅停止，不运行 `down -v`。未经验证不承诺跨版本恢复进行中的对局。
- 检查 `/app/public/assets`、`/app/data`、字体及 `/app/config` 的挂载源；旧挂载会覆盖新镜像的文件，镜像升级不代表这些目录已更新。素材、游戏数据、本地清单和哈希表必须相互对应；公告优先挂载整个配置目录并保证容器内 `node` 用户可读取。
- `FETCH_ASSETS=1` 的素材下载失败可能只打印警告而继续构建，必须核对缺失报告和实际文件。公开下载不包含本地客户端提取的官方 3D 棋盘素材，继续提供已有 PNG 素材及匹配的 `local-assets.json`。宿主机镜像源环境变量不会自动传进 Docker 构建，按当前 Dockerfile 核对支持方式。
- 新增素材按实际缺失量补齐；使用 `tools/fetch-assets.mjs` 后核对清单变化，并运行 `node tools/asset-hashes.mjs` 更新哈希。素材和哈希等本机生成文件不纳入源码提交；不能为了通过测试而删掉新功能的清单项，也不能不经审查就提交工具重写的 `data/assets.json`。
- 干净构建的新 Docker 镜像不会自动带上旧镜像的哈希分包，`emptyOutDir: false` 也不能跨镜像保留文件。维护更新时让玩家结束对局后刷新；无停机部署须另行保留旧分包，先发布新资源再切换 HTML，版本检测不能替代这个发布顺序。
- 发布完成后检查容器健康和日志、`/healthz` 的目标版本及新 `build`、`/metrics` 的持久化/Worker/CDN 配置、`/js/asset-cdn.js` 的运行时地址，并提醒手动验证实际 HTTPS 页面、对局、声音、素材预载和 SW 更新。回滚时一起恢复匹配版本的镜像、数据和 CDN，不能只回退代码。
- 用户要求本机专用且不跟踪的升级文档时，使用 `.git/info/exclude` 精确排除该文件，不修改共享 `.gitignore`、不暂存或提交。后续合并不能依赖该文档或未跟踪同步脚本在其他机器必然存在；通用约定写入本文。

## 黄金结果与本分支规则差异

- 保留上游 `tools/golden.mjs`、`test/golden.test.js` 和完整场景集。运行 `npm run golden` 比对全部场景；不能只凭默认快速子集判断完整覆盖。
- 上游基线可能因本分支 Boss 血量、盟约策略等明确差异而失败。先检查变化场景和字段；必要时在独立临时副本中仅还原这些本分支规则，验证其余行为是否与对应上游版本一致，不在当前工作树临时覆盖规则或已有修改。
- 确认差异来源后才运行 `npm run golden:update`，审查并提交受影响基线，同时在 `test/golden/README.md` 记录规则差异和验证依据。不能通过更新全部基线掩盖未知回归，也不能为迎合上游基线恢复用户明确排除的行为。
- 0.1.4 合并参考：`9f0e80c` 合入上游 `9f93096`，当时独立副本仅还原本分支 Boss/盟约规则后全部 133 场景与上游一致；本分支基线变化为 7 个 roster、20 个 Boss/隐秘核心 fields、10 个 matches，bonds 不变。这是历史证据，后续版本须按当次场景和实现重新核实。

## 合并后的验证

依赖有变化时先运行 `npm ci`。在仓库根目录运行：

```sh
npm run build
node --test test/vite.test.js test/metrics.test.js test/build.test.js test/ui/buildGuard.test.js test/cdn.test.js test/resources/common.test.js test/resources/index.test.js test/resources/manifest.test.js test/resources/store.test.js
node --test test/lobby.test.js test/workers.test.js test/memory-lifecycle.test.js test/announcements.test.js test/persist.test.js test/persist-worker.test.js test/windows-bundle.test.js test/doctor.test.js test/version.test.js
npm run golden
node --test
git diff --check
```

- `test/vite.test.js` 实际构建并验证 HTTP 缓存、运行时 CDN、按需分包和模拟结果；`test/metrics.test.js` 验证接口字段及按需采集；资源测试验证 SW 放行构建文件。
- 不主动启用浏览器自动化；用户明确要求时再运行浏览器测试，并覆盖进入对局、素材预载和 SW 更新。构建/Node 测试通过不等同于浏览器实测、Docker 镜像验证或便携包验证。
- 2026-10-06 曾在修改前源码复现三个全量测试失败：`test/match/fuzz.test.js` 的两个用例生成缺少字段的 `g.console` 消息，以及 `test/ui/playtest3.test.js` 直接调用组件导致 Preact Hook 错误。这是历史记录；以后遇到失败需重新核实基线，不能永久忽略或默认归为已有问题。
- 全量测试出现额外失败时逐项检查：素材缺失先核对清单与磁盘并补齐；静态断言与合并后的 import/标签不同先核对实际功能；Windows 临时目录清理和短计时测试先独立复测并判断是否依赖平台或负载，再做有依据的修复，不直接跳过测试。
- 提交只纳入合并/修复范围，沿用仓库 Conventional Commit 与已有签名配置；报告实际验证结果及尚未验证的部分。
