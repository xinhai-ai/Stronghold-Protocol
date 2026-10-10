# 双用户名审核后端

本分支同时支持自托管 `konsheng/Sensitive-lexicon` 词库服务和 TypeSafe Jev。浏览器把 `hello` 直接发送到 WebSocket；服务端在 WebSocket `hello` 上审核，审核结束（通过或故障降级）后才创建、接管或重命名会话，并通过同一 WebSocket 返回 `NAME_REJECTED`。服务日志只记录不含昵称、令牌、地址和响应内容的审核触发标记。明确命中拦截；后端故障、超时、限流、预算耗尽或非法响应静默放行，不提示、不缓存降级结果。首次登录、恢复登录和在线改名收到明确 `NAME_REJECTED` 均自动返回可编辑昵称标题页，清除本页与 sessionStorage 的 entered 标记并关闭旧页面对话框；不清除原 token、房间或对局，不发送退出，在线改名仍保留原先有效昵称与会话。用户手动输入可用名称后可继续使用原身份，不自动重复尝试被拒名称。聊天拒绝、限流及普通游戏错误不触发名称回退。

## 选择模式

```env
# 只用 Sensitive-lexicon
SP_NAME_MODERATION=lexicon
SP_NAME_MODERATION_URL=http://sensitive-lexicon:8080

# 只用 Jev
SP_NAME_MODERATION=jev
TYPESAFE_API_KEY=你的服务端密钥

# 两者都用：任一后端给出明确拒绝即拦截
SP_NAME_MODERATION=both
SP_NAME_MODERATION_URL=http://sensitive-lexicon:8080
TYPESAFE_API_KEY=你的服务端密钥
```

`SP_NAME_MODERATION=off` 或完全没有配置时关闭。仅设置 URL 自动选择 `lexicon`；仅设置 `TYPESAFE_API_KEY` 自动选择 `jev`。`both` 缺少任一所需配置时启动失败，避免以为双重审核已启用。模式值必须是 `off`、`lexicon`、`jev` 或 `both`。

### Sensitive-lexicon Docker

当前接入的上游 dev 提交为 `b05a333e0747d39c86bc2375a8af7b5b24c4fa08`。其 HTTP 接口无鉴权，建议只放在回环或受控 Docker 网络：

```sh
git clone --branch dev --single-branch https://github.com/konsheng/Sensitive-lexicon.git
git -C Sensitive-lexicon checkout b05a333e0747d39c86bc2375a8af7b5b24c4fa08
docker build -t sensitive-lexicon-server:b05a333e Sensitive-lexicon
docker run -d --name sensitive-lexicon --restart unless-stopped \
  --network stronghold-protocol_default sensitive-lexicon-server:b05a333e
```

验证：`GET /health`；`POST /contains` 请求 `{ "text": "昵称" }`，响应 `{ "contains": true, "word": "命中词" }` 时拒绝，`contains: false` 时放行。不要使用 `/detect` 作为昵称判定。不要将 `/reload` 暴露给公网。

### Jev

Jev 使用服务端 `POST https://api.typesafe.ai/v1/systemone` 和 Bearer API key；浏览器不会接触密钥。昵称请求使用 `state.username`，聊天请求使用 `state.chat`，均只问一个 `unsafe` Noul 违规概率，达到 `SP_NAME_MODERATION_THRESHOLD`（默认 `0.5`）即明确拒绝。固定提示词合并政治、色情、暴恐、违法、仇恨辱骂、隐私等范围，同时要求排除游戏虚构及忽略输入指令；取消四项重复描述，使用简短英文以尽量将一次输入降低到 100 tokens 以下。不截断昵称/聊天内容；实际 token 数由 Jev 分词和内部模板决定，未调用真实 API 验证计费值，复杂 emoji 或特殊文字不能保证低于 100。昵称与聊天缓存及正在进行的请求仍不混用。可选 `SP_NAME_MODERATION_MODEL` 默认为 `jev-latest`。Jev 是模型辅助的服务器政策，不等同法律认定；正常游戏词和普通名字仍可能误判或漏判。

## 共存和故障边界

`both` 会并行调用两个后端。每个后端独立缓存通过/明确拒绝结果五分钟、最多 512 项；进行中的相同请求合并；单个后端异常返回内部 `allowed: true`，不影响另一个后端的明确拒绝。只有 `NAME_REJECTED` 或名字格式错误可以阻止 hello，未知错误不会阻断登录。聊天正文也在服务端转发给对局前使用相同的双审核策略；明确拒绝转为 `CHAT_REJECTED`，不会广播给其他玩家。

四个模式都保留原有名字格式校验和 WebSocket 消息限流。浏览器直接发送 `hello`，只使用 WS 接收批准或拒绝，不再调用 HTTP 预审；旧同源 POST `/api/name-moderation` 接口作为兼容接口保留（JSON 正文 1 KiB、接收 5 秒、无 CORS），不是登录必经路径。只发送归一化昵称或当前消息正文，不发送 token、IP、玩家 ID、房间、整段聊天历史或对局数据。词库后端不需要 key；Jev key 只在服务端环境变量中。内容会发送到管理员配置的词库服务和/或 TypeSafe，运营者应在隐私说明中告知。

聊天最多 20 个 Unicode 码点，消息历史只保存当前页面最近 100 条，不写 Redis，页面刷新不恢复。审核请求每位玩家最多一个在途；审核等待期间可继续编辑，但不会同时提交多个请求。审查通过后再次检查原会话、连接及对局归属，退出、换局、重连或关停时丢弃旧请求，不能转发到下一局。冷却与表情共用原有一秒规则；观看者无发送权限。

服务端 INFO 日志记录 `[names] moderation triggered/rejected ...` 与 `[chat] moderation triggered/rejected ...` 事件标记，**不包含昵称、正文、地址、令牌、API key、命中词或原始审核响应**。这些标记表示本次进入审核流程或明确拒绝，缓存命中/预算降级也可能经过流程；不能把触发日志条数当作真实后端请求数，也不作为玩家识别数据。Prometheus 仅增加固定 `g.chat` 消息类型，不添加正文或昵称标签。

## 接口与边界

词库审核器仅调用 POST `/contains`，JSON `{ "text": "归一化昵称或消息正文" }`。响应 `{ "contains": true, "word": "命中词" }` 拒绝；`{ "contains": false }` 放行；word 不转发浏览器、不记录日志。只有布尔 contains 是有效判定。上游 Contains 使用词库词条是否为输入文本子串的检查；不使用 `/detect`，其精确匹配是反向查找包含输入的词条，不能直接套用作昵称是否包含敏感词。词库接入没有开启 fuzzy 或模型语义扩展；繁体/谐音/拆字变体是否命中取决于部署词库，不保证识别。

默认加载 Vocabulary 下全部 txt，含政治、色情、暴恐及其他名单，范围可能超过这些类别；普通游戏用词、人名也可能误报，需按运营规则审查词库。命中属于服务器昵称政策，不能等同违法认定；词库可能误拦、漏拦，不保证完全合规。

每个后端默认 4.5 秒服务端超时。HTTP 非成功状态、网络/超时异常、非法 JSON、contains 缺失/非布尔、审核并发/预算耗尽均静默放行；**故障和预算耗尽期间违规昵称或消息可能进入，这是优先保证可用性的取舍**。名字格式和原有 WS 消息限流不变。断线/关停、旧昵称结果不得创建或重命名会话。

通过/拒绝结果缓存五分钟、最多 512 项；故障降级不缓存。每个后端最多八个并发请求，全局每秒 20/突发 40，每客户端网络每秒 1/突发 5，最多 2048 个网络桶，空闲 60 秒释放。昵称与聊天共用每个后端的有界容量和预算；缓存命中不消耗后端请求预算。沿用 TRUST_PROXY 地址解析，但地址不会上传审核后端。命中昵称时仅提示“该名称不可用”，聊天提示“该内容不可用”，标题页不显示审核说明；审核服务故障静默放行，不显示服务不可用提示。
**fail-open 取舍：**审核服务故障期间，违规昵称可能进入；这优先保证登录可用性，不是审核始终成功的保证。词库命中和 Jev 结论属于本服务器昵称政策，不等同法律意见。

## 验证

```sh
node --test test/name-moderation.test.js
npm run build
```

测试覆盖词库 `/contains` 契约、Jev `/v1/systemone` 契约、四种配置、`both` 并行拒绝/故障降级、HTTP 预审和真实 WebSocket。未调用真实付费 Jev，也未在本机启动 Docker；上线前应分别验证 `/health`、正常昵称、已知词库命中、Jev key、双后端故障放行和改名/重连。
