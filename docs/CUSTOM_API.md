# 公开 HTTP 查询 API

这三个接口无需账号、Cookie 或令牌，不创建会话、不占用席位。时间戳均为 Unix 毫秒。JSON 响应使用 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；HEAD 状态码及响应头与 GET 一致，但不返回正文。反向代理 / CDN 应将这些路径转到游戏进程并遵循 `no-store`。

## 房间状态

`GET /api/rooms/:code/status`、`HEAD /api/rooms/:code/status`。

房间号为 4 位 `ABCDEFGHJKLMNPQRSTUVWXYZ` 字母，不含 I、O。整个路由不区分大小写，返回大写房间号；不接受尾部 `/`，忽略查询参数。只查询指定房间，不提供列表。

```json
{
  "code": "ABCD",
  "mode": "coop",
  "difficulty": "NORMAL",
  "difficultyName": "险境模拟",
  "inMatch": false,
  "joinable": true,
  "capacity": 4,
  "occupied": 1,
  "humans": 1,
  "bots": 0,
  "connectedHumans": 1,
  "phase": "LOBBY",
  "round": 0,
  "lastRound": null,
  "deadline": 0,
  "paused": false,
  "seats": [
    { "seat": 0, "name": "房主", "isBot": false, "isHost": true, "connected": true, "ready": false },
    null,
    null,
    null
  ],
  "serverNow": 1791190800000
}
```

- `mode`：`solo` 独立模拟 / `coop` 同盟模拟；容量分别为 1 / 4。`occupied` 包含 AI 和断线保留席位；统计和席位均不含观战者。`connectedHumans` 只计在线且未离席的真人。
- `difficulty`：`FUNNY` 标准模拟、`NORMAL` 险境模拟、`HARD` 绝境模拟、`ABYSS` 终极模拟；展示名称使用 `difficultyName`。
- `joinable`：同盟房间未开局且有空玩家席位，不表示可否重连 / 观战。
- 对局状态取最近发布的 `m.public`：`phase`、`round`、常规最后回合 `lastRound`、截止时间 `deadline`、`paused`。未开局时使用示例中的默认值，`deadline: 0` 表示无有效截止时间。
- 有对应对局状态的席位增加 `alive`、`lp`（有效数值或 `null`）、`pendingLp`。实时生命值显示为 `Math.max(0, lp - pendingLp)`；尚未上报的浏览器战斗进度不会出现在接口中。结束回大厅后这三个字段消失。
- 不返回玩家 ID、重连令牌、商店、调配或棋盘。持有分享码即可查询公开昵称。

| 状态码 | JSON 正文 | 条件 / 响应头 |
|---|---|---|
| 200 | 状态对象 | 房间存在 |
| 404 | `{"error":"ROOM_NOT_FOUND"}` | 格式错误、不存在或关闭；`/api/rooms` 也返回此错误 |
| 405 | `{"error":"METHOD_NOT_ALLOWED"}` | 非 GET / HEAD；`Allow: GET, HEAD` |
| 429 | `{"error":"RATE_LIMITED"}` | 超限；`Retry-After: 1` |

所有 `/api/rooms`、`/api/rooms/…` 共用客户端网络令牌桶，每秒补充 2 次、突发 10 次。失败查询和不支持的方法也计数；先检查限流，所以 429 优先于 405 / 404。IPv6 按 /64 合并，本机和内网也限流。地址识别遵循 `TRUST_PROXY`。所有响应带 `X-Robots-Tag: noindex, nofollow, noarchive`，不开放 CORS，跨站展示服务从后端查询。

## 健康检查与运行指标

`GET /healthz` 用于健康检查和页面版本检测，保留 `ok`、协议版本 `version`、应用版本 `app`、`uptimeSec`、构建标识 `build`，以及 `sockets`、`sessions`、`rooms`、`matches`、`roomMatches`、`standaloneMatches`、`humans`、`bots`、`spectators`、`queued` 计数。

`GET /metrics` 返回 JSON，包含上述字段及详细运行状态：`persist`、`workers`、`memory`、`staticCache`、`usage`、`socketBuffers`、`announcements`、`websocket`、`assetsCdn`、`dataCdn`、`limits`、`tuning`。这些详细字段从 `/healthz` 迁移到 `/metrics`，字段名、结构与含义保持原样；持久化或计算池未启用时，`persist` 或 `workers` 为 `null`。内存与 Worker 采样说明见 [部署文档](DEPLOY.md#35-多核计算固定-worker-池)。

两个端点均返回 200，支持 HEAD（无正文）和 `Cache-Control: no-store`；其他方法返回 405，`Allow: GET, HEAD`。无需认证，不开放 CORS，不包含客户端地址。`/metrics` 使用 JSON 格式。

## 延迟探测

`GET /api/ping` 返回 200、`{"ok":true}`；HEAD 返回 200；OPTIONS 返回 204。其他方法返回 405、`{"error":"METHOD_NOT_ALLOWED"}`、`Allow: GET, HEAD, OPTIONS`。

所有响应带 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, HEAD, OPTIONS`、`Cache-Control: no-store`。无独立应用层限流。可以用 `performance.now()` 测量 HEAD 往返时间；此耗时包含连接建立和 HTTP 处理，不等同于 WebSocket 延迟。

## 公告读取

`GET /api/announcement`、`HEAD /api/announcement`。有当前有效公告时返回 200：

```json
{
  "announcement": {
    "id": "0123456789abcdef01234567",
    "title": "维护公告",
    "text": "服务器即将维护。",
    "expiresAt": 1791194400000
  },
  "serverTime": 1791190800000
}
```

`id` 是 `JSON.stringify({ title, text, expiresAt })` 的 SHA-256 前 24 位十六进制摘要。标题、正文或截止时间改变会改变 ID，与配置里用于排期的 `id` 独立。公告配置可选 `title`（去除首尾空白后 1～80 个 JS 字符单位），省略时为“维护公告”。

**`expiresAt = Date.parse(startAt) + durationSeconds × 1000`**，复用已有公告排期的 `endAt`，请求和服务器重启不会延长公告。尚未开始、关闭、过期、文件缺失或无效时返回 `{"announcement":null,"serverTime":…}`。优先级和重叠选择与游戏内公告一致。

复用本项目的 `SP_ANNOUNCEMENTS_FILE` / `config/announcements.json`（[配置说明](DEPLOY.md#36-全站临时公告)），HTTP 请求最多每秒触发一次重读，原有每 2 秒轮询继续生效。例如：

```json
{
  "announcements": [
    {
      "id": "maintenance-20261005",
      "title": "维护公告",
      "text": "服务器即将维护。",
      "startAt": "2026-10-05T11:55:00+08:00",
      "durationSeconds": 300,
      "level": "info",
      "enabled": true
    }
  ]
}
```

上例于 12:00 到期。当前文件无效或不可读时，HTTP API 返回 `null`；游戏内原有“保留上次有效排期直到到期”的行为继续生效。无写入 API，无 CORS。其他方法返回 HTML 错误页，状态 405、`Allow: GET, HEAD`。
