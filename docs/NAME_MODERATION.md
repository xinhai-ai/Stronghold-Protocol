# Sensitive-lexicon 用户名审核

审核后端已从 Jev 替换为自托管的 `konsheng/Sensitive-lexicon` dev 分支 Docker HTTP 服务。浏览器每次 hello（登录、重连、改名）前调用同源 POST `/api/name-moderation`；游戏服务端独立检查直接发送的 hello，审核结束（通过或故障降级）后才创建、接管或重命名会话。明确命中拦截；接口故障静默放行，不提示、不缓存降级结果。改名被拒保留原身份；首次登录被拒返回可编辑昵称的标题页。

## Docker 后端

本次核对的 dev 提交：`b05a333e0747d39c86bc2375a8af7b5b24c4fa08`。下面在独立部署目录构建该固定版本，不改变游戏镜像或主工作树：

```sh
git clone --branch dev --single-branch https://github.com/konsheng/Sensitive-lexicon.git
git -C Sensitive-lexicon checkout b05a333e0747d39c86bc2375a8af7b5b24c4fa08
docker build -t sensitive-lexicon-server:b05a333e Sensitive-lexicon
docker run -d --name sensitive-lexicon --restart unless-stopped \
  -p 127.0.0.1:8080:8080 sensitive-lexicon-server:b05a333e
curl http://127.0.0.1:8080/health
curl -H 'Content-Type: application/json' -d '{"text":"测试昵称"}' http://127.0.0.1:8080/contains
```

上游发布工作流也推送 GHCR 镜像，但 latest 同时受 dev/master 推送影响，不能等同固定 dev 版本。本次未拉取或验证远程镜像，优先自行构建固定提交。源码 Dockerfile 内置 Vocabulary，端口 8080，LEXICON_DIR=Vocabulary，以 nonroot 运行。

接口无鉴权，尤其 POST `/reload` 能触发重载：只绑定回环地址或放在受控 Docker 私网，禁止公开映射。游戏也在容器时，127.0.0.1 指的是游戏容器自身；将两个容器接入实际部署的同一网络，用 `http://sensitive-lexicon:8080`，后端不必发布宿主机端口。不要更改现有 Redis/公告挂载或运行 down -v。词库需裁剪时可挂载经过人工审查、nonroot 可读的词库目录到 `/app/Vocabulary:ro`；更新后在私网调用 `/reload` 或重建后端，并重启游戏服务以立即清除五分钟昵称缓存。

## 游戏服务配置

```sh
SP_NAME_MODERATION=lexicon
SP_NAME_MODERATION_URL=http://127.0.0.1:8080
# 两个容器同一网络时改为实际后端服务名，例如：
# SP_NAME_MODERATION_URL=http://sensitive-lexicon:8080
```

URL 为后端基地址（不是 /contains 完整路径），可带反向代理路径前缀；只允许 HTTP(S)，禁止内嵌账号密码、查询或片段。地址由服务端管理员配置，浏览器不可覆盖。显式 lexicon 未设 URL 使用 http://127.0.0.1:8080；仅设置 URL 自动启用；无配置默认关闭，SP_NAME_MODERATION=off 明确关闭。非法模式/地址启动报错，不悄悄变更目标。Jev 模式已移除，不再需要 TYPESAFE_API_KEY、模型或概率阈值；旧 Jev 环境变量应移除。服务按原进程管理器/容器方式注入，不自动读取 .env。

重新构建前端并重启/重建游戏服务，启动日志应显示 `[names] moderation Sensitive-lexicon enabled (fail open)`。并行测试用不同游戏端口和 Redis prefix。此功能不改 data/ 或图片模型；若 UI 语言 JSON 走 CDN，同步 public/i18n/en.json 并刷新对应缓存。

## 接口与边界

服务端仅调用 POST `/contains`，JSON `{ "text": "归一化昵称" }`。响应 `{ "contains": true, "word": "命中词" }` 拒绝；`{ "contains": false }` 放行；word 不转发浏览器、不记录日志。只有布尔 contains 是有效判定。上游 Contains 使用词库词条是否为输入文本子串的检查；不使用 `/detect`，其精确匹配是反向查找包含输入的词条，不能直接套用作昵称是否包含敏感词。本接入没有开启 fuzzy，也没有模型语义审核、类别选择、概率阈值、拼音或同义词扩展。繁体/谐音/拆字变体是否命中取决于部署词库，不保证识别。

默认加载 Vocabulary 下全部 txt，含政治、色情、暴恐及其他名单，范围可能超过这些类别；普通游戏用词、人名也可能误报，需按运营规则审查词库。命中属于服务器昵称政策，不能等同违法认定；词库可能误拦、漏拦，不保证完全合规。

4.5 秒服务端超时，客户端预审最多 7 秒。HTTP 非成功状态、网络/超时异常、非法 JSON、contains 缺失/非布尔、审核并发/预算耗尽均静默放行；**故障和预算耗尽期间违规昵称可能进入，这是优先保证可用性的取舍**。HTTP 安全边界、名字格式和原有 WS 消息限流不变。断线/关停、旧昵称结果不得创建或重命名会话。

通过/拒绝结果缓存五分钟、最多 512 项，同名进行中请求合并；故障降级不缓存。最多八个并发后端请求，全局每秒 20/突发 40，每客户端网络每秒 1/突发 5，最多 2048 个网络桶，空闲 60 秒释放。缓存命中不消耗后端请求预算。浏览器接口仅同源 JSON POST、正文最大 1 KiB、接收超时五秒，无 CORS；沿用 TRUST_PROXY 地址解析。只传昵称，不发送 token、IP、玩家 ID、房间或对局数据。缓存仅临时留在游戏服务内存；昵称送往管理员配置的后端，不再发送至 TypeSafe。命中时仅提示“该名称不可用”，标题页不显示审核说明；审核服务故障静默放行，不显示服务不可用提示。

## 验证

```sh
node --test test/name-moderation.test.js
npm run build
```

测试使用模拟返回及实际本地 HTTP 契约服务、真实游戏 WebSocket；不等于已启动上游 Docker 或验证完整词库识别效果。上线需验证后端 /health、正常/已知命中昵称、断开后端时静默放行、重连与改名。当前文档命令未在本机 Docker 实测。

源码依据：
- https://github.com/konsheng/Sensitive-lexicon/tree/dev
- 固定提交 cmd/server/main.go、internal/detect/service.go、internal/lexicon/store.go、Dockerfile、.github/workflows/server.yml。
