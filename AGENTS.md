# 合并上游时的仓库约定

本文件适用于整个仓库，记录本分支相对上游增加的行为及合并验证要求。合并时保留上游的功能更新，同时维护以下约定；不要用整文件覆盖的方式解决冲突。用户明确调整需求时，以用户指示为准，并同步更新本文。

## 开始合并前

- 检查 `git status`、暂存区和上游差异，保留已有的本机修改。`config/announcements.json` 可能包含正在使用的公告排期，不要覆盖或顺手提交。
- 先识别上游是否修改了前端加载入口、模拟模块导入、静态服务、构建/启动脚本及监控接口；这些是本分支的主要冲突点。
- `public/build/`、`public/vendor/`、素材和依赖是生成文件，不应纳入源码提交。合并 `package.json` 的依赖后使用 npm 更新 `package-lock.json`，保留版本元数据一致。
- 本分支的相关实现起点为 `f164a5e`（Vite 打包、SW 排除构建文件、监控接口拆分）。后续合并以当前代码和测试为准。

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

## 合并后的验证

依赖有变化时先运行 `npm ci`。在仓库根目录运行：

```sh
npm run build
node --test test/vite.test.js test/metrics.test.js test/build.test.js test/ui/buildGuard.test.js test/cdn.test.js test/resources/common.test.js test/resources/index.test.js test/resources/manifest.test.js test/resources/store.test.js
node --test test/lobby.test.js test/workers.test.js test/memory-lifecycle.test.js test/announcements.test.js test/persist.test.js test/persist-worker.test.js test/windows-bundle.test.js test/doctor.test.js test/version.test.js
node --test
git diff --check
```

- `test/vite.test.js` 实际构建并验证 HTTP 缓存、运行时 CDN、按需分包和模拟结果；`test/metrics.test.js` 验证接口字段及按需采集；资源测试验证 SW 放行构建文件。
- 不主动启用浏览器自动化；用户明确要求时再运行浏览器测试，并覆盖进入对局、素材预载和 SW 更新。构建/Node 测试通过不等同于浏览器实测、Docker 镜像验证或便携包验证。
- 2026-10-06 曾在修改前源码复现三个全量测试失败：`test/match/fuzz.test.js` 的两个用例生成缺少字段的 `g.console` 消息，以及 `test/ui/playtest3.test.js` 直接调用组件导致 Preact Hook 错误。这是历史记录；以后遇到失败需重新核实基线，不能永久忽略或默认归为已有问题。
- 提交只纳入合并/修复范围，沿用仓库 Conventional Commit 与已有签名配置；报告实际验证结果及尚未验证的部分。
