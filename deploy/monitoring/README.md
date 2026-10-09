# Stronghold 持续监控：Grafana + Prometheus

**独立监控栈，不替换游戏 `/metrics` 的 JSON 接口，不修改游戏容器、Redis、公告或素材挂载。**

- JSON collector：固定目标每 10 秒抓一次 `/metrics`，转成 Prometheus 指标；同一抓取仍在进行时不重叠执行。
- 可选匿名 WebSocket 探针：每 10 秒新建连接，发送一次 `ping` 后关闭；不发 `hello`、不创建玩家/房间/对局。
- Prometheus：每 10 秒抓 collector，保留 **30 天 / 5 GB**（任一达到就清理旧块）。
- Grafana：自动配置数据源和中文面板，可选择实例，默认显示最近 6 小时。

## 1. 最短部署步骤（Linux / Docker / 1Panel）

在更新后的仓库根目录执行：

```sh
cd deploy/monitoring
cp monitoring.env.example monitoring.env
cp exporter/targets.example.json exporter/targets.json
```

编辑 **monitoring.env**，必须把 `GRAFANA_ADMIN_PASSWORD` 改成长随机密码；编辑 **exporter/targets.json**，把 URL 改成实际游戏接口。两个文件已加入 `.gitignore`，不要提交真实配置或密码。

```sh
docker compose --env-file monitoring.env -f docker-compose.yml config --quiet
docker compose --env-file monitoring.env -f docker-compose.yml up -d
docker compose --env-file monitoring.env -f docker-compose.yml ps
docker compose --env-file monitoring.env -f docker-compose.yml logs --tail=100 exporter prometheus grafana
```

示例假定游戏端口已发布到宿主机 **3000**，collector 从 `host.docker.internal:3000` 访问。Docker Linux 通过 `host-gateway` 映射宿主机；**实际端口和网络以你的部署为准**。如果游戏只绑定宿主机 `127.0.0.1`，Linux bridge collector 通常不能通过 host-gateway 访问它，使用下节共享网络，而不是把游戏接口开放公网。

默认 Grafana **仅绑定宿主机 127.0.0.1:3001**。本机打开 `http://127.0.0.1:3001`；远端可用 SSH：

```sh
ssh -L 3001:127.0.0.1:3001 USER@YOUR_SERVER
```

首次登录使用 monitoring.env 中的管理员账号密码，自动出现 **Stronghold / Stronghold 平台：延迟、资源与稳定性**。若要用 1Panel/Nginx 域名，请反向代理到宿主机 `127.0.0.1:3001`、启用 HTTPS，并把 `GRAFANA_ROOT_URL` 改为实际 Grafana HTTPS origin。若反向代理也在容器内，须按实际网络选择能访问的地址；不要盲目暴露 Prometheus/collector。

Grafana 初始化密码只在**第一次创建数据库**时使用；以后修改 env 不会修改已有管理员密码，使用 Grafana UI/CLI 的密码重置。监控栈需要能拉取镜像；示例固定 Grafana 13.2.3 / Prometheus 3.15.0，而非 floating latest。collector 无 npm 依赖，只读挂载 exporter 自身目录，使用 Node 22。宿主机目标文件应让容器 `node` 用户可读（例如644，不保存密码）。

## 2. 已有 Docker 游戏容器：推荐共享网络

如果游戏没有宿主机发布端口，或希望完全内部采集，查看**实际**游戏网络：

```sh
docker inspect YOUR_GAME_CONTAINER --format '{{json .NetworkSettings.Networks}}'
```

创建本机专用的 `network.override.yml`（已排除Git及游戏Docker构建上下文，不要误改游戏服务）：

```yaml
services:
  exporter:
    networks:
      - default
      - game-network
networks:
  game-network:
    external: true
    name: YOUR_EXISTING_GAME_NETWORK
```

targets.json 使用游戏容器在该网络中的真实名字/别名：

```json
[
  {
    "name": "production",
    "url": "http://YOUR_GAME_ALIAS:3000/metrics",
    "wsUrl": "ws://YOUR_GAME_ALIAS:3000/ws"
  }
]
```

```sh
docker compose --env-file monitoring.env -f docker-compose.yml -f network.override.yml up -d
```

不要假定本仓库已有游戏 Compose 服务名；本 Compose **只创建监控三个服务**，不启动/停止游戏服务，也不读取游戏配置。

## 3. 目标、多实例与 HTTPS 网络探针

支持 1–32 个命名实例：

```json
[
  {
    "name": "production",
    "url": "http://YOUR_GAME_ALIAS:3000/metrics",
    "wsUrl": "wss://YOUR_GAME_DOMAIN/ws"
  },
  {
    "name": "staging",
    "url": "http://STAGING_ALIAS:3000/metrics"
  }
]
```

`url` 固定抓取 JSON；`wsUrl` 可省略，或独立指向实际公网 WSS 入口，测量经过反向代理/TLS后的监控点RTT。不携带身份、secret或token，不发送游戏动作。**WS探针是匿名合成测试，不是玩家真实客户端的延迟**；若监控栈与游戏同机，即便走公网域名也不能代表不同地区用户。Cloudflare/WAF/认证代理阻挡自动探针时会显示失败，不能直接推断游戏进程不可用。

Prometheus指标的时间统一转换为**秒**，面板乘1000后显示毫秒；原游戏JSON中的`Ms`字段仍保持毫秒。Prometheus直方图桶累计值和`+Inf`边界按规范导出，不把启动累计p95直接当作最近p95。

改 targets.json 后重启 collector：

```sh
docker compose --env-file monitoring.env -f docker-compose.yml restart exporter
```

collector 不接受 `?target=` 参数改变抓取地址，避免变成公开 SSRF 代理；禁止URL内用户名/密码，不跟随HTTP重定向，不关闭TLS校验；每次超时5秒、JSON最多2MiB。URL/name仅由管理员配置；不在日志输出响应正文、玩家地址或标识。实例名是有限标签，消息标签使用固定协议白名单。

**安全边界：** 游戏 `/metrics` 沿用现有接口，未额外添加认证，不应公开Prometheus、collector或真实目标配置。建议仅允许内部网络采集游戏JSON；需要跨主机时用VPN/反向代理ACL。Grafana禁止匿名访问与注册。Prometheus/exporter没有host端口；只有Grafana提供登录入口。不挂载 Docker socket，不用 privileged 容器。

## 4. 新旧游戏服务器如何接入

**不升级游戏也能先用：** 连接/房间/对局、RSS/堆、Worker/存档、积压、吞吐速率、启动以来累计延迟，以及可选WS ping探针。

**要看近期长尾与实际CPU：** 用本次更新的游戏源码重新构建镜像并重建游戏容器，保留原环境、网络、挂载、Redis prefix/卷及公告排期，优先无对局时维护；单纯restart旧容器不能获得新代码。新增指标只有 `/metrics.websocket.diagnostics`：

- `processCpu`：进程累计user/system CPU时间；
- `recentEventLoop`：独立10秒窗口，启动后首个窗口完成前为null；多个抓取者不重置窗口；
- `handlerMs.*` / `sendCompletionMs` 的 `sumMs` 和累计 `buckets`。

`/healthz` 不增加诊断字段，`/metrics`仍是JSON，旧字段/启动以来统计/持久化未启用时null均保留。无新字段时面板显示未采集，而不是用collector CPU或零值假装游戏CPU。游戏数据/素材未变化，无需因本改动同步CDN。

## 5. 看什么，分别代表什么

| 面板 | 口径 / 限制 |
|---|---|
| 匿名WS ping / 建连 | 从监控容器发起，每次新连接；ping测到pong，不是操作完成，更不是玩家p95 |
| 最近10秒事件循环p99/max | 正常20ms定时分辨率也在数值内；阻塞会延长窗口，窗口样本时间/年龄单独显示 |
| 近5分钟处理p95 | 累计直方图桶的 `rate()` + `histogram_quantile()` 插值估计；只含进入JS后的同步处理，不含调度前等待 |
| 近5分钟本机发送p95/p99 | 每64次发送采样；压缩/排队/本机完成回调，**不是客户端状态到达**；零样本应无数据 |
| 兼容旧版累计延迟 | sinceStart，重启后归零；历史启动恢复的大停顿会一直保留，不能当作最近窗口 |
| 游戏进程CPU | 累计user+system速率×100，**100%=一个逻辑核**，可超过100%；含Worker/zlib，不是宿主机全核或容器配额百分比 |
| RSS / 各线程堆 | RSS已包含Worker；不能重复相加。模拟Worker样本可能不同时刻，样本年龄单独显示 |
| WS应用正文吞吐 | **发送为压缩前、接收为解压后**字节；不是实际公网出口。本次不在线hook私有ws帧发送实现 |
| Worker队列/失败/完成 | queue与busy为瞬时，完成/失败/拒绝用近5分钟增量；未启用时无数据 |
| Redis/存档 | enabled只代表配置，不代表Redis可达；writes速率和检查点规模，尚无Redis查询延迟/错误计数 |
| 玩家操作状态到达 | 明确为**尚未采集**：需后续单独实现匿名、采样、有限标签RUM，不能用上述任一曲线顶替 |

面板按游戏实例分别计算近期直方图和速率，不把不同实例p95相加/取平均。多实例RSS也不能与部署副本预算混淆。建议固定负载至少观察24小时，看内存和对局数量是否同步回落，以及p99/max突刺是否与CPU/存档/队列同步。

## 6. 告警、保留与更新

Prometheus内置规则：collector/目标失败、WS探针失败、快照过旧、近期事件循环长尾、发送积压、Worker队列持续非空、持久化堆过高。面板显示 `ALERTS`，也可通过 Prometheus UI 的 `/alerts` 查看。

**尚未接Alertmanager或Grafana通知contact point，因此不会自动发邮件/Telegram/企业微信。** 如需通知，先配置目标通道与secret，不能仅有告警规则就宣称已能推送。阈值只是起点，结合真实基线调整；持久化没有活跃对局时写入为0是正常的，不直接告警“Redis故障”。

Grafana及Prometheus分别使用命名卷。**不运行 `down -v`**，否则会删历史和Grafana数据库。升级监控镜像前备份这两个卷；反向代理配置与密码也保留。30天/5GB只限制Prometheus数据，不包含Grafana卷、容器日志或临时WAL开销，应预留额外磁盘。

## 7. 排错与验证

```sh
# collector与Prometheus只在内部网络
docker compose --env-file monitoring.env -f docker-compose.yml exec exporter \
  node -e "fetch('http://127.0.0.1:9108/metrics').then(r=>r.text()).then(console.log)"
docker compose --env-file monitoring.env -f docker-compose.yml exec prometheus \
  promtool check config /etc/prometheus/prometheus.yml
docker compose --env-file monitoring.env -f docker-compose.yml exec prometheus \
  promtool check rules /etc/prometheus/stronghold-alerts.yml
curl -fsS http://127.0.0.1:3001/api/health
```

`sp_target_up=0`：核对容器内部地址、路径是否是完整JSON `/metrics` 而非 `/healthz`、网络别名、WAF/ACL及目标可达性。`up=1`但近期CPU/窗口缺失：游戏仍在旧版本；先看“新诊断可用”面板。启动前5分钟或样本少时近期直方图可能无数据，不能当0毫秒。

生产命令以上述实际网络/端口为准。本机Node测试及Prometheus配置校验不等于Linux Docker实际部署、Grafana浏览器布局或通知端到端验证；验收时需核对采集目标/build、面板实例过滤、持续抓取、权限、历史保留和手动故障演练。

## 8. 已有 Grafana / Prometheus 的复用

不必再启动两个新服务：只部署collector，把已有Prometheus的scrape job指向**collector的文本 `/metrics`**，不要直接抓游戏的JSON `/metrics`：

```yaml
scrape_configs:
  - job_name: stronghold-exporter
    scrape_interval: 10s
    static_configs:
      - targets: ["YOUR_COLLECTOR_ALIAS:9108"]
```

已有Prometheus须能通过共享内部网络访问collector；不要为了复用公开9108到公网。规则文件也需添加到已有 `rule_files`。已有Grafana可导入 `grafana/dashboards/stronghold-overview.json`；数据源使用UID `stronghold-prometheus`，或将面板JSON中**全部**该UID替换为已有Prometheus数据源UID，包含变量和每个面板。不要假定UI仅选择数据源就能覆盖所有硬编码UID。

## 9. 本次验证（2026-10-09）

- 168项定向回归通过；collector/诊断/接口17项同时在Node26.7.0及Node22.23.3通过，包含真实游戏JSON与匿名WS探针、旧版兼容、失败恢复、无身份/房间生成、抓取合并和边界验证。
- 官方Prometheus3.15.0本机实际启动并成功抓取；实际导出文本经 `promtool check metrics` 通过，Prometheus配置和9条规则通过校验，规则单元测试通过。面板67条PromQL均通过真实查询API，包含多实例样本。
- 官方ComposeCLI `config --quiet` 通过；YAML/JSON解析、任务路径ESLint、TypeScript及 `git diff --check` 通过。
- 全量Node：5510项，5493通过、2项既有i18n失败、15跳过。失败仍为资源导入准备文本缺英文msgid及语言包计数1241/1240；本次没有修改对应源码、语言包或断言。
- **未在Linux Docker实际启动此栈、未运行Grafana浏览器自动化、未部署线上或验证通知送达。** 本机CLI/Prometheus验证不是这些部署验证。未提交，原公告修改、本机同步脚本与资源ZIP保留。
