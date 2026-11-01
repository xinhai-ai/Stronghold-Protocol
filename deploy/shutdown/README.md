# 11 月 1 日停服页

独立 Cloudflare Worker + 静态站点 + D1，不依赖游戏服务器、Redis、游戏 API 或素材 CDN。页面使用现有深灰绿 / 薄荷绿风格。这里只准备部署源码，不会定时关闭服务器，也不会自动切换域名。

正常页面和已存在的静态文件优先由 Workers Assets 直接返回，不执行 Worker 脚本、不占用 Workers 脚本请求额度。`run_worker_first` 仅匹配 `/api/*` 和 `/ws`；缺失资源仍可能回落 Worker。`static/_headers` 随构建复制到 `dist/`，让首页保持 `no-store`、带内容哈希的 JS/CSS 使用长期缓存。

Worker 回落处理 `/` 和 `/index.html` 时读取静态资源的规范路径 `/`。不要改为请求 `/index.html`：Workers Assets 默认会将它重定向回 `/`，导致首页不断返回 `307 Location: /`。

验证容器使用 `id="turnstile-widget"`，避免浏览器将 DOM 元素暴露为 `window.turnstile` 而与 SDK 冲突。加载器检查实际 API 方法并等待 Turnstile 的 `onload` 参数回调，不能仅检查全局对象是否存在或依赖脚本元素的 `load` 事件；加载失败/超时可通过“重新加载验证”重试。

停服页独立支持简体中文、繁体中文、英语、日语、韩语。启动时按 `navigator.languages` 的偏好顺序匹配，地区语言使用对应基础语言，`zh-Hant` / 台港澳地区使用繁体，未匹配时回退英语。所有文案随静态文件打包，包含标题、按钮、占位符、确认框、导出/清理提示和服务端错误翻译；Turnstile 使用同一语言，不读取或改写游戏的语言偏好。组件保持默认宽度，留言入口保持折叠，留言仍仅管理员可读。无 JavaScript 时保留原有中文提示。

留言 API 能识别非 JSON 的限额响应，使用所选语言提示服务达到访问限制；IP 的 5 条留言限制仍显示独立提示。明确的 4xx 拒绝不会再附加“可能已保存”的网络中断提示。

## 本机开发和验证

在仓库根目录执行（沿用已安装的 Vite，无需改游戏构建）：

```sh
node deploy/shutdown/build.mjs
node --test test/shutdown.test.js test/shutdown-turnstile.test.js test/shutdown-i18n.test.js test/ui/stats.test.js test/ui/loadout.test.js
```

构建输出为本目录 `dist/`，已忽略。测试使用 Node 的 `node:sqlite`（Node 22.13+），验证 SQL 事务、限额和导出契约；它不等同于 Cloudflare 线上验证。可用 `npx vite preview --outDir deploy/shutdown/dist` 预览静态页面；此方式没有留言 API，页面会提示服务不可用，数据工具仍可使用。不要在生产域名试运行破坏性清理。

## 部署准备

所有 Wrangler 命令在 `deploy/shutdown` 下执行；使用 Wrangler 4。下列命令需要维护者自己的 Cloudflare 账号。

1. 运行 `npx wrangler d1 create stronghold-farewell`。
2. 复制 `wrangler.jsonc` 为 `wrangler.local.jsonc`，填入返回的 `database_id`。`SITE_ORIGIN` 默认为 `https://wei.linxia.dev`，必须与实际浏览器 origin 完全相同，包含协议、不带尾斜杠；更换域名、协议或端口会失去原浏览器存储访问权限。勿将新 workers.dev 地址重定向为玩家入口。已有本机配置需同步 `SITE_ORIGIN` 和 `assets.run_worker_first`，不要覆盖 D1 ID、Site Key 或 secrets。
3. 创建 Turnstile widget，允许原游戏域名；设置 `TURNSTILE_SITE_KEY`。服务端同时验证 `hostname` 和 `action`（必须为 `farewell`）。正式站点不得使用测试 key。
4. 写入两个 secrets，不能写进前端或提交到 Git：

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.local.jsonc
npx wrangler secret put IP_HASH_SECRET --config wrangler.local.jsonc
npx wrangler d1 migrations apply stronghold-farewell --remote --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

`IP_HASH_SECRET` 使用随机生成的至少 32 字节密钥，并长期保留；更换它会改变 IP 身份，使历史额度失效。不要启用会绕过配额表的第二份独立数据库。D1 保存留言及 IP 的 HMAC-SHA256，不存原始 IP；原始 IP 仅在当前请求中用于 Turnstile 验证。Cloudflare 平台日志保留策略需在账号内另行管理。

5. 在计划的 **2026-11-01** 切换原游戏域名到 Worker Custom Domain / 路由，确保 `/`、`/index.html`、`/assets/*` 和 `/api/*` 都由此部署服务，关闭原游戏入口和 WS 服务。构建资源使用 `/assets/`，无需沿用游戏素材。必须核查旧反向代理、页面缓存规则和 CDN，确保不再返回旧游戏 HTML。Worker 对 HTML 和 API 使用 `no-store`，`/ws` 返回 410。
6. 先在测试域名用测试数据库和 Turnstile widget 验证，再切生产；测试域名无法访问玩家原域名数据。上线后核验原域名历史数据可读、导出文件可导入原游戏、缓存清理不删统计、手机布局和真实 Turnstile；并发 6 次请求只能接受 5 次，第六次应返回 429。

## 导出和清理边界

- 统计 / 成就：读取 `sp.pref.stats`，复用原统计迁移、导出协议，可从原游戏本机历史导入。损坏、新版本或不识别记录会提示无法导出；不自动写回数据。
- 干员配置：读取 `sp.pref.loadout`，复用 `stronghold.loadout` 格式，包含技能、模组、潜能、练度，可在干员调配导入。
- 页面仅提供统计 / 成就和干员配置两个导出入口，按用户要求移除全部偏好导出按钮。
- 按用户要求不提供素材导出。缓存清理仅删除 `stronghold-resources-v1-*` 的 Cache Storage，保留战绩及媒体。不清空整个 origin，不删除其他应用的缓存 / localStorage，不声称能清理浏览器 HTTP 缓存。
- 单独删除个人数据需要确认，删除 `sp.pref.*` 及 `sp-hub-backdrop` / `sp-lobby-music` 两个 IndexedDB。不会删留言或重置 IP 额度。清理前关闭其他游戏标签；跨存储清理不是事务，如被阻塞或中途失败可能部分完成，页面会报错。
- 旧 `resource-sw.js` 只拦截素材请求，不缓存 HTML；新页面不注册游戏 SW，不连接 WS。现有 SW 对新构建脚本路径会回落网络。无需注销同源其他应用的 Service Worker。

## 留言规则与维护

昵称 1–24 字符、正文 1–500 字符。留言仅供管理员查看，用户端没有列表或查询接口；`GET /api/messages`（含分页参数）返回 404，不查询数据库。前端仅在展开“也可以选择留言”后加载验证并允许提交。留言失败保留输入；网络中断时提示可能已经保存，避免连续重复提交。

额度是每个 Cloudflare `CF-Connecting-IP` **全期累计 5 条**，非每天 5 条；共用出口共享，IP 变化会成为另一地址，不能承诺每人 5 条。忽略客户端 JSON / X-Forwarded-For 中的 IP。D1 `BEFORE INSERT` trigger 同事务计数并拒绝第六条；校验失败和写入失败不扣额度。删除或隐藏留言不返还额度。

管理员登录自己的 Cloudflare 账号后，在该 D1 数据库的控制台查询留言（访问权限由 Cloudflare 账号管理，不提供网站端管理接口）：

```sql
SELECT id, name, body, created_at FROM messages ORDER BY id DESC LIMIT 100;
```

备份：`npx wrangler d1 export stronghold-farewell --remote --output farewell-backup.sql --config wrangler.local.jsonc`。备份含 IP 摘要，妥善保存，不提交仓库。

官方参考：[Turnstile 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[Workers 静态资源绑定](https://developers.cloudflare.com/workers/static-assets/binding/)、[D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)。
