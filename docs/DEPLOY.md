# 部署指南

目标：在一台家用 Windows 小主机上长期开服，让朋友通过局域网或公网来玩。macOS / Linux / Docker 放在后面。
所有命令都在项目根目录执行。遇到问题先运行 `node tools/doctor.mjs`（只读诊断）。

## 0. 资源需求

| 项目 | 说明 |
|---|---|
| 服务器 CPU | 战斗默认在各玩家浏览器里模拟（DESIGN §14）。服务器管理回合、经济和校验；AI 阵容预演、普通/联防战场的服务器模拟、结果复算默认交给固定 Worker 池，见 §3.5。必要计算在池不可用时退回约 8 ms 分片执行。`SP_VERIFY=all` 会复算每个真人普通/联防战场，CPU 成本明显增加；具体容量应通过真实多房间压测确定。 |
| 服务器内存 | 空闲约 100 MB，每个进行中的对局再增加几 MB。 |
| 网络 | 4 人对局中服务器每回合下行约 0.25 MB（DESIGN §14 实测）。首次进入游戏时浏览器要从主机下载所需的图片 / Spine 模型 / 音频（按需加载，之后走浏览器缓存），公网隧道带宽小时第一次会慢一些。 |
| 磁盘 | 素材约 270 MB（`public/assets`）+ 依赖约 125 MB（`node_modules`）；可选的本地提取约 40 MB（`.venv-extract`）+ 70 MB 贴图（见第 6 节）。 |
| 玩家设备 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑或手机平板（横屏）。老旧设备可在设置里调低画质或访问 `/?board=2d`。 |

WebSocket 默认启用 `permessage-deflate`，仅压缩不小于 1 KB 的消息，并关闭客户端和服务端上下文复用。大型 `m.public` / `b.snap` 消息通常能显著减少带宽，小消息不会增加压缩开销；压缩会消耗 CPU，真实容量应在目标机器上压测。设置 `SP_WS_COMPRESSION=off` 或 `0` 可关闭；`/metrics.websocket` 会报告当前开关和阈值。

服务器默认**无状态**：房间和对局只存在内存里，没有数据库和存档，不需要备份。重启服务器会结束正在进行的对局（包括断线后本可在 24 小时内回来继续的独立模拟）。想让容器/进程重启后玩家仍回到原座位，设置 `SP_REDIS_URL` 使用你自己的 Redis 做状态存档，见 §3.1「断点续玩」；也可以把素材放到 CDN，见 §3.2。

## 1. Windows 小主机：一步步

### 1.1 安装与首次启动

1. 安装 Node.js 22 LTS 和 Git（在 PowerShell 或「终端」里；用下面的完整包时不需要 Git）：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   装完**关闭并重新打开**终端，`node -v` 应显示 v22 或更高（winget 的 LTS 目前是 v24.x，同样可用）。没有 winget 时从 <https://nodejs.org/zh-cn/download> 和 <https://git-scm.com/download/win> 下载安装。
2. 下载，二选一。建议放在一个固定、短、**不在 OneDrive 同步范围内**的目录，例如 `C:\Stronghold-Protocol`：
   - **完整包（推荐）**：在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 页面下载最新版本（当前为 v0.1.3）的完整包 zip（已含依赖、前端库和全部素材，包括官方 3D 棋盘），解压后把里面的 `Stronghold-Protocol` 文件夹放到上述位置。不需要 Git，首次启动也不用再下载素材。素材版权归上海鹰角网络 / Yostar，仅限非商业使用，见 [NOTICE.md](../NOTICE.md)。
   - **源码**：
     ```powershell
     git clone https://github.com/sganggs/Stronghold-Protocol.git C:\Stronghold-Protocol
     ```
3. 双击 `C:\Stronghold-Protocol\scripts\start-windows.bat`。首次会：安装依赖（`npm ci`；完整包已含，跳过）→ 复制前端库 → 下载约 270 MB 素材（完整包已含，跳过；显示进度，中断后再次启动会续传）→ 若检测到本机的明日方舟客户端，询问是否提取官方贴图（可跳过）→ 启动服务器并打开浏览器。
4. 窗口里会打印朋友可用的地址，例如 `http://192.168.1.23:3000`。用另一台设备打开它确认能进入。关闭窗口即停止服务器。

等价的手动命令：`npm ci`、`node tools/setup.mjs`、`npm start`。

### 前端构建与缓存

从源码生产部署时运行：

```bash
npm ci
npm run build
npm start
```

`npm run build` 先准备前端库，再由 Vite 将页面 JS/CSS 打包到 `public/build/`。服务器在该目录有 `index.html` 时自动使用构建页面；HTML 保持 `no-cache`，`/build/assets/` 下带内容哈希的 JS/CSS 使用 `public, max-age=31536000, immutable`，并继续支持 gzip 与 ETag。基础 UI 库独立分包，渲染器、战斗模拟和 Three.js 按需加载。素材、字体、游戏 JSON、素材预载 Service Worker 仍通过现有路由提供；`SP_ASSETS_CDN` 和 `SP_DATA_CDN` 仍可在启动时配置，无需为不同 CDN 重新构建。

`setup` 在安装了 Vite 时自动构建；Docker 构建和 Windows 便携包制作也包含前端构建，运行容器/便携包无需安装 Vite。仅安装生产依赖（`npm ci --omit=dev`）时，应先在构建机器上生成 `public/build/` 并一同部署。

开发时使用 `npm run dev`，会强制提供源码页面，刷新浏览器即可看到修改。没有构建产物时普通启动也会回退到源码页面。每次生产更新都需要重新构建并重启服务，已有构建不会自动跟随源码变化。

构建不会删除旧哈希文件，以便已经打开的页面继续加载旧版分包。在线更新时先上传新增的 `build/assets/` 文件，再替换 `build/index.html`，保留旧分包；定期清理请在维护停服期间进行。不要直接删除整个 `public/build/` 后在线重建。

### 1.2 防火墙

- 第一次启动时 Windows 会弹出「Windows 安全中心警报」：勾选**专用网络**并点「允许访问」。
- 没弹窗或点错了，用**管理员** PowerShell 添加规则（下面的开机自启脚本也会自动添加）：
  ```powershell
  netsh advfirewall firewall add rule name="Stronghold Protocol" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
  ```
- 家里的网络要是「公用网络」，Windows 会拦截入站连接。改成专用（管理员 PowerShell；网卡名用 `Get-NetConnectionProfile` 查看）：
  ```powershell
  Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private
  ```
- `node tools/doctor.mjs` 会显示规则是否存在、每个网络的类型，以及朋友可用的地址。

### 1.3 固定局域网 IP（推荐）

主机 IP 变了，朋友收藏的地址就失效。推荐在**路由器**后台的「DHCP 静态分配 / 地址保留」里把小主机的 MAC 地址绑定到固定 IP（如 `192.168.1.50`）。也可以在 Windows「设置 → 网络和 Internet → 属性 → IP 分配 → 编辑」里手动设置（IP、子网掩码、网关、DNS 与路由器一致，且不要与别的设备冲突）。

### 1.4 开机自动在后台运行

先关闭 `start-windows.bat` 的窗口（否则端口冲突），然后在项目目录运行（会自动请求管理员权限）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1
```

它会：运行一次 `tools/setup.mjs` → 把设置写入 `scripts\service.env.cmd`（node.exe 路径、端口等）→ 注册计划任务 **StrongholdProtocol**（开机 20 秒后以 SYSTEM 身份运行 `scripts\run-server.cmd`，无需登录；服务器退出后 5 秒自动重启）→ 添加防火墙规则 → 立即启动并显示状态。日志在 `logs\server.log`（超过 10 MB 自动轮换）。

| 需求 | 命令（都加在 `powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1` 之后） |
|---|---|
| 换端口 / 其他设置 | `-Port 8080`、`-Verify sample`、`-Combat server`、`-BindHost 127.0.0.1`（只给反向代理用） |
| 公用网络也放行 | `-AllowPublicNetwork`（一般不需要；Tailscale 网卡被识别为公用网络时可能需要） |
| 查看状态和最近日志 | `-Status` |
| 重启（更新代码后） | `-Restart` |
| 停止 | `-Stop`（下次开机仍会自动启动） |
| 卸载 | `-Uninstall`（删除计划任务、防火墙规则和 `service.env.cmd`） |

建议同时关闭睡眠，否则小主机会在无人操作时休眠：`powercfg /change standby-timeout-ac 0`。

<details>
<summary>替代方案：用 NSSM 注册成真正的 Windows 服务</summary>

```powershell
winget install NSSM.NSSM            # 或从 https://nssm.cc 下载
nssm install StrongholdProtocol "C:\Program Files\nodejs\node.exe" server\index.js
nssm set StrongholdProtocol AppDirectory C:\Stronghold-Protocol
nssm set StrongholdProtocol AppEnvironmentExtra PORT=3000 HOST=0.0.0.0
nssm set StrongholdProtocol AppStdout C:\Stronghold-Protocol\logs\server.log
nssm set StrongholdProtocol AppStderr C:\Stronghold-Protocol\logs\server.log
nssm start StrongholdProtocol
```

防火墙规则仍需按 1.2 手动添加。两种方式只选一种。
</details>

### 1.5 更新

```powershell
cd C:\Stronghold-Protocol
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop   # 装了开机自启时
git checkout -- data/assets.json    # 素材清单由 setup 重新生成，先还原以免 git pull 冲突
git pull
npm ci
node tools/setup.mjs                # 补下载新增的素材（已有文件会跳过）
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

没装开机自启的话，最后一步改成重新双击 `start-windows.bat`。用 Releases 完整包的：停止服务器，把新版本的完整包解压到新目录后从那里启动即可（素材已包含；装了开机自启的，在新目录重新运行一次 `install-service-windows.ps1`）。用 GitHub「Download ZIP」源码包的：解压新版本后，把旧目录里的 `public\assets`、`public\fonts`、`.cache` 和 `data\local-assets.json`（若有）复制过去，可避免重新下载。

## 2. 让不在同一网络的朋友加入

### 2.1 Tailscale / ZeroTier（推荐给家用小主机）

组一个虚拟局域网：不需要公网 IP、不需要改路由器、不暴露到互联网。

- **Tailscale**：主机和朋友都安装 <https://tailscale.com/download>（Windows：`winget install Tailscale.Tailscale`）并登录。朋友用自己的账号时，在 Tailscale 管理后台把这台主机「Share」给他们，或邀请他们加入你的 tailnet。朋友访问 `http://<主机的 100.x.y.z 地址>:3000`（`tailscale ip -4` 查看；开了 MagicDNS 也可以用 `http://<主机名>:3000`）。
- **ZeroTier**：在 <https://my.zerotier.com> 创建网络，主机和朋友安装客户端并加入同一个 Network ID，在后台勾选授权成员；访问 `http://<主机的 ZeroTier IP>:3000`。
- 连不上时运行 `node tools/doctor.mjs`：看 VPN 网卡是否被 Windows 识别为「公用网络」，是的话按 1.2 改为专用，或安装自启时加 `-AllowPublicNetwork`。

### 2.2 cloudflared 临时隧道（朋友什么都不用装）

```powershell
winget install --id Cloudflare.cloudflared      # macOS: brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

把输出的 `https://xxxx.trycloudflare.com` 发给朋友。页面是 https 时客户端自动改用 `wss://`，不需要任何配置；服务器会通过隧道转发的 `CF-Connecting-IP` 识别真实来源（`TRUST_PROXY=auto`）。临时隧道每次启动地址都不同，且没有可用性保证；需要固定地址请使用 Cloudflare 账号 + 自己域名的「命名隧道」。

### 2.3 路由器端口转发

仅当你有**公网 IPv4**（很多宽带是运营商级 NAT，没有公网 IP，此时请用 2.1 / 2.2）：

1. 先按 1.3 固定主机的局域网 IP。
2. 路由器「虚拟服务器 / 端口转发」：外部端口 3000（或任意端口）→ 内部 `主机IP:3000`，TCP。
3. 朋友访问 `http://<你的公网 IP>:外部端口`。

注意：游戏没有账号系统，知道地址的人都能进来。服务器对来自互联网的连接有按网络的数量限制（每个网络最多 64 个连接，房间 / 对局数量也有上限），但仍建议不玩时关掉转发，或优先用 Tailscale。

### 2.4 反向代理与 HTTPS（有域名时）

必须部署在**域名根路径**（客户端使用 `/data/`、`/vendor/`、`/ws` 等绝对路径，不支持挂在子路径下）。代理需要转发 WebSocket 升级（路径 `/ws`）。建议让服务器只监听本机：`HOST=127.0.0.1`（Windows 自启：`-BindHost 127.0.0.1`）。

**Caddy**（自动申请 HTTPS 证书，WebSocket 无需额外配置）：

```caddy
game.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 443 ssl;
    server_name game.example.com;
    ssl_certificate     /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;      # WebSocket 长连接
    }
}
```

https / wss 说明：页面通过 https 打开时客户端自动连接 `wss://同一域名/ws`；http 时用 `ws://`。服务器本身只提供 http，证书由代理 / 隧道负责。代理与服务器在同一台机器或内网时，`TRUST_PROXY=auto` 会信任它的 `X-Forwarded-For` / `X-Real-IP`；代理在公网另一台机器上时设 `TRUST_PROXY=1`（同时确保游戏端口只对代理开放）。

## 3. Docker

```bash
# A) 构建时下载素材（需要联网，约 250 MB）
docker build -t stronghold-protocol --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped stronghold-protocol

# B) 不把素材打进镜像：先在宿主机运行 node tools/setup.mjs，然后挂载
docker build -t stronghold-protocol .
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/public/assets:/app/public/assets:ro" stronghold-protocol
```

镜像基于 `node:22-alpine`，多阶段构建，只含生产依赖；`public/vendor` 在构建时生成。`.dockerignore` 排除了 `public/assets`（不会把宿主机素材打进构建上下文）；`public/fonts`、`data/assets.json` 和 `data/local-assets.json` 若存在会被复制进去。环境变量同 README（`-e SP_VERIFY=sample`、`-e SP_REDIS_URL=redis://redis:6379/0`、`-e SP_ASSETS_CDN=https://cdn.example.com/stronghold` 等）。健康检查：`GET /healthz`。

docker compose 示例：

```yaml
services:
  stronghold:
    build:
      context: .
      args: { FETCH_ASSETS: "1" }
    ports: ["3000:3000"]
    restart: unless-stopped
    environment:
      SP_VERIFY: "off"
```

### 3.1 断点续玩：Redis 会话 / 对局恢复

设置 `SP_REDIS_URL`（例如 `redis://127.0.0.1:6379/0`）后，服务器每 `SP_REDIS_SAVE_MS`（默认 10 秒）以及**优雅关闭时**把一份状态文档写入 Redis，启动时读回。容器 `docker restart` / `docker compose up -d` 之后，玩家用浏览器重开页面（同一浏览器、同一令牌）就回到原房间原座位。

持久化使用一个按需启动的专用 Worker，独立于战斗 / AI 计算池。检查点的复杂状态编码、JSON 序列化和缓存由该 Worker 完成；Redis 接收已编码的字节。主线程仍需提取字段和进行 `postMessage` 的结构化复制，每次发送一局，等待 Worker 完成后再处理下一局，避免在同一轮 event loop 中集中处理所有对局。因此主线程开销降低，但并非零开销；也不会降低序列化所需的总 CPU。Worker 故障或超时时跳过本次保存并记录日志，不退回主线程序列化；下次保存重建 Worker，从最近成功保存的检查点继续。优雅关闭会等待正在执行的保存，再保存最终状态并关闭 Worker。

可以运行 `node tools/persistbench.mjs` 比较同步快照与 Worker 保存的耗时及 event-loop 心跳间隔。基准重复使用真实四席位对局的第 4 回合休整期状态，FakeBattle 只用于快速构造该状态；不含真实 Redis 网络、并发战斗或浏览器负载，不能用来推断线上容量。

| 会恢复 | 不会恢复 |
|---|---|
| 玩家身份：`playerId` + 重连令牌、昵称、干员调配（DESIGN §16） | 具体的 Socket：客户端用令牌重连后被服务器重新绑定 |
| 房间：代号、模式、难度、房主、座位（真人 + AI）、准备状态、房间的对局计数 | 重连窗口已经过期的会话（同盟 10 分钟 / 独立模拟 24 小时）—— 其房间若因此没人也会一并丢弃 |
| 进行中的对局（包括无房间匹配、房间内匹配和普通房间对局）：回合数、经济、棋盘 / 手牌 / 装备、生命、策略与机变选择、共享池剩余数量、随机数进度、当前阶段 | 战斗本身：检查点只在状态可序列化的阶段生成（信息确认 / 策略选择 / 机变 / 回合开始 / 休整期），所以**在战斗中被打断的对局会从该回合的休整期继续**：阵容与经济原样保留，这一回合重打（战斗 ID 会跳到新的一段，旧上报不会被误收） |
| | 匹配队列本身：尚未开局、仍在等待队友的队列不恢复；只有已经创建并运行的匹配对局会恢复 |
| | 独立模拟的“暂停”（`g.pause`）：恢复后对局是运行状态；当前阶段的剩余时间按检查点记录继续走，休整期至少还剩 20 秒 |
| | 服务器进程内的其他一切：日志、错误统计、诊断信息 |

把 Redis 一起用 compose 起来（`appendonly yes` 让 Redis 自己重启也不丢状态）：

```yaml
services:
  stronghold:
    build:
      context: .
      args: { FETCH_ASSETS: "1" }
    ports: ["3000:3000"]
    restart: unless-stopped
    depends_on: [redis]
    environment:
      SP_REDIS_URL: redis://redis:6379/0
      SP_VERIFY: "off"
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--save", ""]
    volumes:
      - redis-data:/data
volumes:
  redis-data:
```

要点：

- **Redis 只是存档，不是必需**：连不上或中途挂掉时游戏照常运行（只会在日志里看到 `[redis] …` 警告），只是重启不再恢复；服务器会自己重试。
- 状态键默认前缀 `stronghold:`、TTL 25 小时（`SP_REDIS_TTL`，兜底清理）。多个实例共用一个 Redis 时用 `SP_REDIS_PREFIX` 分开。
- 不要把 Redis 配成 `maxmemory-policy allkeys-lru`，否则状态键可能被淘汰。
- 想清空存档（所有人从头开始）：删除状态键即可，`redis-cli DEL stronghold:state`。
- 验证：`GET /metrics` 会返回 `persist: { redis: true, writes, checkpoints }`；启动日志会打印 `State: Redis (…)` 与 `[persist] state loaded (…)`。

### 3.2 素材放 CDN

容器里最占地方的是 `public/assets/`（约 250 MB 图片 / Spine / 音频）。想把它交给 CDN（或对象存储 / 另一台静态服务器）时设置 `SP_ASSETS_CDN`：

```bash
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -e SP_ASSETS_CDN=https://cdn.example.com/stronghold \
  stronghold-protocol
```

- 服务端在返回 `data/assets.json`、`data/local-assets.json` 时，把其中所有 `/assets/…` 改写成 `<SP_ASSETS_CDN>/assets/…`，因此**客户端零改动**：图片、Spine（skel / atlas / 贴图）、音频、本地提取的素材都自动走 CDN。
- CDN 侧目录结构必须与 `public/assets/` 一致（把该目录整个上传即可），并且**必须允许跨域**：浏览器会用 `fetch` 取 Spine 的 `.skel` / `.atlas`、用 `crossOrigin="anonymous"` 取图片。Nginx 例：`add_header Access-Control-Allow-Origin "*" always;`（音频走 `<audio>`，不需要 CORS）。
- 素材带内容指纹，可以放心设长缓存（`Cache-Control: public, max-age=31536000, immutable`）；`/fonts/` 与 `public/vendor/` 仍由游戏服务器自己提供。
- 没设置该变量时行为完全不变（服务器照旧自己提供 `/assets/…`），设置后本地 `/assets/` 仍然可用，可随时回退。
- 只想换目录名 / 走同源反代前缀也行：`SP_ASSETS_CDN=/cdn`。

验证：`GET /metrics` 里 `assetsCdn` 会显示当前地址；浏览器网络面板里素材请求应指向 CDN。

**数据也放 CDN：** 设置独立的 `SP_DATA_CDN`，把与游戏服务器同一版本的 `data/` 上传到 CDN 根目录下的 `data/`：

```bash
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -e SP_ASSETS_CDN=https://cdn.example.com/stronghold \
  -e SP_DATA_CDN=https://cdn.example.com/stronghold \
  stronghold-protocol
```

- 页面数据加载器、浏览器战斗模拟和独立素材加载器通过运行时 `/js/asset-cdn.js` 的 `DATA_CDN`，直接请求 `<SP_DATA_CDN>/data/chess.json` 等静态 JSON，无需先请求游戏源站。也支持同源前缀，例如 `/cdn`；移除变量并重启后恢复同源加载。Node 的 `/data/*.json` 始终读取本地数据，保持 GET/HEAD、ETag/304 和原有缓存策略，不再跳转到数据 CDN。
- `assets.json`、`asset-hashes.json` 也直接从数据 CDN 读取，**直接上传原始 JSON**，无需执行导出命令或提前改写地址。浏览器读取素材清单后，根据服务器通过 `/js/asset-cdn.js` 提供的 `ASSETS_CDN` 改写 `/assets/…`；已有的绝对地址保持原样。素材 CDN 与数据 CDN 可以使用不同域名。
- `local-assets.json` 保留在游戏服务器上，继续支持本地素材地址改写和未提取时的空清单；动态 `resource-manifest.json` 也保留在服务器上，并使用本地素材清单和哈希表生成。
- **服务器的本地 `data/` 必须保留**，游戏逻辑与战斗计算仍从本地读取。CDN 侧允许 JSON 跨域读取（例如 `Access-Control-Allow-Origin: *`），并设置 `Cache-Control: no-cache` 配合 ETag / Last-Modified；更新时同步上传并刷新 CDN 缓存，或者使用带版本号的 CDN 根目录，避免客户端与服务器数值不一致。
- 两个 CDN 变量可以独立配置。`GET /metrics` 的 `dataCdn` 显示当前数据 CDN 根目录；未配置时为 `null`。

更新资源后同步上传原始 JSON，并刷新 CDN 缓存。`/js/asset-cdn.js` 由游戏服务器提供，使用 `no-cache` 和 ETag 校验；代理应保留此缓存策略，以便切换素材或数据 CDN 后浏览器取得新地址。首次升级到浏览器直连数据 CDN 的版本需要重新构建前端并重启服务；之后仅切换 CDN 环境变量无需重新构建，刷新页面即可读取启动时的新配置。

CDN 的 `/data/` 回源可使用 Nginx 的 `alias` 指向复制的数据目录，也可代理到 Node 的本地数据响应；Node 不再进行数据 CDN 跳转。静态域名要允许跨域 JSON，发布时与游戏服务器同步数据版本。游戏域名的 `/data/local-assets.json`、`/data/resource-manifest.json` 和 `/js/asset-cdn.js` 应继续代理到 Node；预载清单动态生成，不能通过复制 `data/` 得到。

### 3.3 资源预载（可选，客户端开关）

玩家在游戏里「首页右下角」或「设置 ▸ 预载资源」打开后，客户端会把对局素材存进浏览器缓存（Service Worker + Cache Storage，见 [docs/ASSETS.md](docs/ASSETS.md)「Preload」），之后进战斗不再等待下载：素材由 Service Worker 直接从本机缓存读取。默认关闭，服务端无需任何配置（清单 `GET /data/resource-manifest.json` 由服务端从 `data/assets.json` 自动生成）。部署上只需注意两件事：

- **`/resource-sw.js` 必须由游戏服务器提供，且不要被边缘缓存。** Service Worker 脚本要能立即更新：本项目对 `public/` 下的 `.js` 已经是 `no-cache`，但如果把整个 `public/` 交给 CDN / Cloudflare，请把 `resource-sw.js` 排除（Cloudflare → Caching → Cache Rules：`http.request.uri.path eq "/resource-sw.js"` → **Bypass**）。Nginx 例：

```nginx
location = /resource-sw.js {
    add_header Cache-Control "no-cache" always;
}
```

- 同一浏览器的多个标签页不会各下一遍：客户端用 Web Locks 串行化预载，只有一个标签页在下载（其余显示「另一标签页预载中」，回到该标签页时自动继续）。
- **更新只下变化的文件。** 清单里每个文件都带 `hash`（素材字节的 SHA-1 前 12 位）：本地素材由 `extract.py` 写入，网页素材由 `node tools/asset-hashes.mjs` 生成到 `data/asset-hashes.json`（跟 `data/assets.json` 一起放到服务器/镜像里；**重建 CDN 素材后记得重跑一次**，否则这些条目退回旧的「整个清单换版才失效」规则）。客户端把文件存在一个缓存 `stronghold-resources-v1-all` 里，靠这个 `hash` 决定哪些要重下；旧布局（`stronghold-resources-v1-<指纹>`）的缓存会被**迁移**而不是丢弃：客户端现算旧条目的 SHA-1，仍然一致的就搬进新缓存，不一致的删掉再下——所以这次上线不会让已预载的玩家把 330 MB 重下一次。
- **音频走 `/media/…`（0.1.2 起）。** 没有配置 CDN 时，客户端播放 BGM / 音效请求的是无扩展名地址 `/media/bgm/act1`（`shared/media.js`：避免 IDM / 迅雷 这类下载管理器嗅探 `.mp3` 请求），由服务端解析回 `public/assets/audio/…`。预载清单里记的**仍然是真实文件路径**（CDN 是纯静态托管，认不了 `/media/…`），Service Worker 会把这条路由映射到清单里的那条记录 —— 所以走不走 CDN，音频都命中预载缓存；`/media/…` 的响应头和直接请求 `/assets/audio/…` 一样（一天缓存、支持 Range）。
- **素材需要允许跨域读取**（与 §3.2 同一条要求）：预载会用 CORS 模式 `fetch` 素材并把响应写进缓存，缺 `Access-Control-Allow-Origin` 时该文件会被记为失败（游戏本身照常按需加载）。想确认预载是否生效：浏览器 DevTools → Application → Cache Storage 里应出现 `stronghold-resources-v1-all`，文件数为「已保存/总数」。

### 3.4 上限调整（房间 / 对局 / 连接）

服务端对「一个网络能占用多少」有几道上限。默认值适用于家用小主机与几十人的公网部署；容器里用环境变量就能调，不必改代码：

| 环境变量 | 默认 | 含义 | 客户端看到 |
|---|---|---|---|
| `SP_MAX_ROOMS` | `1000` | 全局同时存在的房间数（**含正在对局的房间**） | 「服务器内部错误」 |
| `SP_MAX_ROOMS_PER_ADDR` | `16` | 单个客户端网络同时拥有的房间数（`0` = 不限） | 「操作过于频繁」 |
| `SP_MAX_MATCHES_PER_ADDR` | `8` | 单个客户端网络同时进行的对局数（`0` = 不限） | 「操作过于频繁」 |
| `SP_MAX_CONNECTIONS` | `2000` | 全局 WebSocket 连接数 | 升级时 HTTP 503 |
| `SP_MAX_CONNECTIONS_PER_ADDR` | `64` | 单个客户端网络的连接数（`0` = 不限） | 升级时 HTTP 429 |

例子（`.env` 或 compose 的 `environment:`）：

```yaml
    environment:
      SP_MAX_ROOMS: "2000"            # 大服务器：放宽全局房间数
      SP_MAX_ROOMS_PER_ADDR: "32"     # 宿舍 / 校园网 / CGNAT：多人在同一出口 IP
      SP_MAX_MATCHES_PER_ADDR: "0"    # 0 = 不限制（只保留全局兜底）
```

几点要注意：

- 「一个网络」怎么算：直连时是客户端 IP（IPv6 取 /64）；经过反代 / Cloudflare 时是转发头里的真实玩家 IP（`cf-connecting-ip` / `x-real-ip` / `x-forwarded-for`）。**本机/内网直连不受单网络限制**。
- 若把 `TRUST_PROXY` 设为 `0`，经本机反代的流量全部算作「本地」→ 单网络上限**完全不生效**，只剩全局兜底；默认 `auto` 才会按真实玩家 IP 计数。
- 房间只在真的变空时才释放：大厅断线满 60 秒，或对局中重连窗口结束（同盟 10 分钟、**独立 24 小时**）。**打完一局不会释放房间**（只是回到大厅，仍计入上限）。
- 程序内调用还可以直接传 `startServer({ maxRooms, maxRoomsPerAddr, ... })`；显式传的参数优先于环境变量（便于测试），环境变量优先于代码默认值。值写错了（负数、小数、非数字）会记一条 warn 并继续用默认值——不会因为一个手误把防护关掉。
- **容量与 CPU**（单机实测，见本节末尾的容量说明）：一局 4 人合作在 **客户端战斗**（默认）下约用 **8–10 s CPU**，其中 AI 席位的"预演摆位"占约 70%（`SP_BOT_REHEARSAL=0` 可降到 2.7–3.5 s）。摊到 25–30 分钟的一局就是 **每房约 0.5–0.7% 单核**；1000 名玩家 = 250 房 ≈ **1.3–1.8 核**（这还是"每个房间都塞满 AI 席位在预演"的最坏情况）。真正会把它打爆的是 `SP_COMBAT=server`（改为按 tick 推快照，数量级上升）与 `SP_VERIFY=all`（每局客户端上报的战斗服务器再算一遍）；Redis 在 250 个活对局时约 3.6 MB/10 s（≈370 KB/s，AOF 约 32 GB/天，可用 RDB 快照或把 `SP_REDIS_SAVE_MS` 调到 30 s 降下来）。启动日志里 `[match] tuning:` 一行和 `GET /metrics` 的 `tuning` 字段会报出当前生效的 `combat` / `verify` / `botRehearsal`。
- 观察方式：启动日志有一行 `[http] limits: rooms 1000 (16/network), matches 8/network, sockets 2000 (64/network)`；`GET /metrics` 的 `limits` 是当前生效值，`usage` 告诉你**最忙的那条网络离上限还有多远**：

  ```json
  "usage": { "rooms": 3, "matches": 1, "networks": 2, "worstRooms": 2, "worstMatches": 1,
             "overRooms": 1, "overMatches": 1, "socketNetworks": 2, "worstSockets": 2, "overSockets": 1 }
  ```

  `networks` = 当前占用房间/连接的客户端网络数，`worst*` = 最忙那条网络占用的房间 / 对局 / 连接数，`over*` = 已经达到上限的网络数（**> 0 就说明有网络正在被限流**）。判断方法：如果 `overRooms` 一直大于 0、`worstRooms` 贴着 `maxRoomsPerAddr`，就是某条出口 IP（宿舍 / 公司 / CGNAT）挤爆了，调大它比调大全局上限更对症。
  出于隐私，`/metrics` 是公开端点，**不会列出客户端地址**；具体是哪个 IP 被拒只出现在服务端日志里（`[lobby] room limit (N) reached for <ip>` / `match limit (N) reached for <ip>`，同一条 10 秒内只打一次并附上被合并的次数）。

### 3.5 多核计算：固定 Worker 池

服务器为所有房间共用一个计算池。WebSocket、经济、结算和 Boss 共享血量由主线程管理；Worker 只计算 AI 候选布局评分、普通/联防战场的完整模拟和客户端结果复算。`SP_COMBAT=server` 的实时推流和 Boss 共享战场仍使用主线程的原有调度。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SP_WORKERS` | `min(8, max(1, 可用 CPU 数 − 2))` | 固定线程上限，0 关闭，1–32 手动指定；CPU 数使用 Node `os.availableParallelism()`，部署时结合容器 CPU 配额和内存调整 |
| `SP_WORKER_QUEUE` | `256` | 等待队列上限，不包含正在执行的任务；0 表示只接受可立即分配的任务 |
| `SP_WORKER_TIMEOUT_MS` | `120000` | 从提交开始计时，包含排队；超时的运行线程被终止，再有任务时重建 |

例如 8 核机器可以设置 `SP_WORKERS=6`。线程按需启动，第一次使用时获得当前服务器的游戏数据快照，后续任务只传战斗输入。每个线程一次执行一个任务；严格校验和接管优先于 AI 预演及抽样校验。

`SP_VERIFY=all` 的普通/联防战场进入等待校验状态，计算结束后才结算，重复上报不会重复计算。请求的 `ok` 表示已接收上报，最终战场状态通过原有 `m.public` 更新。抽样校验仅记录差异，队列满或计算失败时跳过。严格校验、AI 预演或接管失败会退回本地分片；严格校验失败会由服务器重新模拟，不能直接放行客户端结果。

准备阶段结束、玩家退出、战场被替换或对局销毁时，相关任务会取消，晚到的结果不能覆盖新状态。服务器关闭时停止计算池。虚拟时间工具和注入自定义 Battle 的测试保持同步执行。

启动日志的 `[workers]` 和 `/metrics` 的 `workers` 可查看线程上限、已启动线程、忙线程、队列长度，以及完成、失败、取消、拒绝计数；`queueMs` / `computeMs` 是累计排队/运行毫秒数，`avgComputeMs` 是成功完成任务的平均计算毫秒数（不含排队、超时和取消；运行时间包含首次线程初始化）。队列持续积压时，应降低开局速率或增加资源，避免依赖分片回退维持过载。

本机基准：`node tools/workerbench.mjs --workers 4 --battles 24`。工具先预热，再比较相同战斗的同步执行和 Worker 池执行，输出结果摘要一致性、吞吐及主线程定时器最大延迟。它不包含真实 WebSocket 流量、Redis 写入或完整对局，不能作为在线玩家容量承诺。

**内存诊断**：Docker 的 `MEM USAGE` 是容器总内存。`/metrics.memory.rss` 是整个 Node 进程的驻留内存（含所有 Worker）；同一对象的 `heapUsed` / `heapTotal` / `external` / `arrayBuffers` 是主线程计数，单位均为字节，`arrayBuffers` 已包含在 `external` 中，不能再相加。`workers.memory[].sample` 与 `persist.workerMemory` 是各线程最近完成任务时的采样，`sampledAt` 是采样时间，包含尚未 GC 的临时对象，不是当前实时堆。

模拟 Worker 各有独立 JS 堆和游戏数据副本，启动后为复用而保持存活。`SP_WORKERS=4` 比默认最多 8 个线程节省内存，但会减少计算并发度，调低后应观察任务队列和超时。静态 gzip 缓存按字节淘汰，上限 96 MiB，实际占用见 `/metrics` 的 `staticCache.gzipBytes`；WebSocket 发送积压见 `socketBuffers.total` / `max`；`persist.snapshotBytes` 是最近保存的 JSON 字节数。房间数不等于活跃对局数，`matches` 包含所有运行对局，`roomMatches` / `standaloneMatches` 区分房间与无房间匹配。

本地检查可运行 `node --expose-gc tools/memorybench.mjs`：比较 276 个信息确认阶段房间创建 / 销毁前后的主线程堆，以及 1 / 4 / 8 个 Worker 完成真实战斗后的进程 RSS。仅对主线程显式 GC，不采集生产环境，也不模拟 276 场同时战斗，不能当作生产内存上限。房间 / 对局销毁后主线程已用堆下降，而 RSS 不马上下降，可能是其他线程、V8 保留的堆或原生分配器的高水位；应结合持续采样判断是否泄漏，不能只凭一个 Docker 数值定性。

计算池支持单进程利用多个核。多实例部署仍需房间/重连路由和独立存档归属；直接用 PM2 cluster 并共用同一 Redis 存档键会导致路由错误和存档覆盖。

### 3.6 全站临时公告

公开 HTTP 接口提供房间状态、跨域延迟探测和公告读取，详见 [CUSTOM_API.md](CUSTOM_API.md)。公告接口的 `expiresAt` 是 `startAt + durationSeconds × 1000`；可选 `title` 用作该接口的标题，省略时为“维护公告”。

编辑 `config/announcements.json`，服务器每 2 秒读取一次，修改无需重启。公告在首页、大厅、房间和游戏内的上半屏滚动展示，不显示剩余时间，不拦截游戏操作，到期自动消失。开启系统“减少动态效果”时改为静态换行文本。默认配置为空，`config/announcements.example.json` 提供一个未启用的示例。

```json
{
  "announcements": [
    {
      "id": "maintenance-20261005",
      "text": "服务器将在今晚 22:00 进行维护，请提前完成当前对局。",
      "startAt": "2026-10-05T21:50:00+08:00",
      "durationSeconds": 60,
      "level": "warning",
      "enabled": true
    }
  ]
}
```

- `id`：唯一标识，1–64 个字母、数字、下划线或短横线。
- `text`：1–500 字纯文本，HTML 不会执行，换行会合并为空格。
- `startAt`：带时区的 ISO 日期，必须明确 `+08:00` 或 `Z` 等时区；立即发布可填当前时间，不能使用 `now`（避免重启后重新计时）。
- `durationSeconds`：持续秒数，1–86400。例子在 21:50:00 开始，21:51:00 结束；21:50:40 进入的玩家只看剩余 20 秒，界面不显示倒计时。
- `level`：`info`（普通，默认）、`warning`（提醒）或 `urgent`（紧急）。
- `enabled`：布尔值，默认 true；设为 false、删除该条目或清空数组可撤回。

配置最多 100 条，总文件最多 128 KiB。重叠公告仅显示等级最高的一条；同等级先显示触发时间较早的，同一触发时间按文件顺序。等待中的公告仍按原计划到期，不延长有效期。配置格式有误、文件不可读或保存时暂时缺失时，保留上一份有效配置直到它到期；日志和 `/metrics.announcements.configError` 可定位原因。清空时请写入合法的 `{"announcements": []}`，不要用删除文件代替撤回。

PowerShell 立即发布一条持续 60 秒的通知（会替换现有列表）：

```powershell
$notice = @{ announcements = @(@{
  id = 'quick-notice'; text = '服务器即将更新，请留意后续通知。'
  startAt = [DateTimeOffset]::Now.ToString('o'); durationSeconds = 60
  level = 'info'; enabled = $true
}) }
$notice | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 config/announcements.json
```

**Docker 支持实时修改。** 镜像包含默认的 `config` 目录；建议挂载整个目录，容器内 `node` 用户只需读取权限：

```bash
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  --mount type=bind,source="$(pwd)/config",target=/app/config,readonly \
  -e SP_ANNOUNCEMENTS_FILE=/app/config/announcements.json \
  stronghold-protocol
```

在 Docker Compose 服务中加入：

```yaml
    environment:
      SP_ANNOUNCEMENTS_FILE: /app/config/announcements.json
    volumes:
      - ./config:/app/config:ro
```

之后修改宿主机 `config/announcements.json` 即可。挂载目录可以识别编辑器通过新文件替换旧文件的保存方式；只挂载单个文件可能看不到这类替换。配置必须在挂载前存在。容器重启读取原来的绝对时间，恢复未到期通知，过期通知不补播。公告由配置文件保存，独立于 Redis；多个实例若使用相同配置，需要保持服务器系统时钟同步。

## 4. macOS / Linux 常驻

- 临时开服：`scripts/start.sh`（或 `npm start`），保持终端窗口打开。macOS 首次会询问是否允许 node 接受传入连接，选「允许」。
- Linux systemd（`/etc/systemd/system/stronghold.service`，路径与用户按实际修改）：

  ```ini
  [Unit]
  Description=Stronghold Protocol game server
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/Stronghold-Protocol
  ExecStart=/usr/bin/node server/index.js
  Environment=PORT=3000 HOST=0.0.0.0
  Restart=always
  RestartSec=5
  User=stronghold

  [Install]
  WantedBy=multi-user.target
  ```

  `sudo systemctl daemon-reload && sudo systemctl enable --now stronghold`；日志 `journalctl -u stronghold -f`；防火墙 `sudo ufw allow 3000/tcp`。

## 5. 排错

| 现象 | 处理 |
|---|---|
| 任何问题 | `node tools/doctor.mjs`：Node 版本、依赖、素材完整性、端口、局域网地址、防火墙、网络类型 |
| `端口已被占用 / EADDRINUSE` | 已经有一个服务器在运行（自启任务？）或其他程序占用 3000：换端口 `scripts\start-windows.bat --port 3001` |
| 朋友打不开页面 | 防火墙规则 / 网络类型（1.2）；确认用的是 `LAN` 地址而不是 `localhost`；访客 Wi-Fi 常开启「AP 隔离」；不在同一网络请看第 2 节 |
| 画面是占位图、没有声音 | 素材没下完：重新运行 `node tools/setup.mjs`（会续传）；缺失明细在 `.cache/assets-report.json`。GitHub 原始地址访问失败时会自动改用 jsDelivr 镜像 |
| 素材下载很慢 / 失败 | 网络问题可随时中断，重新运行会跳过已完成的文件；`node tools/fetch-assets.mjs --concurrency=4` 降低并发。有文件没下载成功时，素材清单 `data/assets.json` 保持不变（脚本列出缺少的条目并以非零状态结束；游戏里缺的图片用占位图，缺的声音不播放），重新运行即可补齐 |
| 表情显示成默认图标、「玩法说明」只有文字要点 | 素材没下载完整：重新运行 `node tools/setup.mjs`（表情和教程图随其他素材一起从公开镜像下载，不需要客户端）；缺失明细在 `.cache/assets-report.json` |
| 本地提取失败 | 游戏照常运行，只是第 6 节表格里的几样换成替代样式。确认客户端已下载全部资源；Python 版本太新导致依赖安装失败时，安装 Python 3.12 后删除 `.venv-extract` 再运行 `node tools/setup.mjs --local` |
| 3D 棋盘没出现 | 需要本地提取的棋盘贴图（`node tools/doctor.mjs` 会显示「3D 棋盘可用」），以及支持 WebGL2 的浏览器。没有客户端的服务器可以从同一版本的整合包复制本地素材（第 6 节） |
| 断线 | 同盟模拟 10 分钟内、独立模拟 24 小时内（`config.constants.singleReconnectTime`）用同一浏览器重新打开页面，自动回到原座位。同盟掉线期间按原阵容自动作战、到时自动准备（不会代为购买；想让 AI 代打请用「离开模拟 → 暂离（AI 托管）」）；独立模拟不计时，等你回来 |
| 重启（容器 / 进程）后玩家回不到房间 | 没设 `SP_REDIS_URL` 时这是预期行为（纯内存）。设了之后看启动日志的 `State:` 行和 `[persist] state loaded (…)`；`GET /metrics` 的 `persist.writes` 应持续增长。宕机超过重连窗口（同盟 10 分钟 / 独立 24 小时）的会话必然丢弃 |
| 日志刷 `[redis] connect failed / write failed` | Redis 不可达或权限不对；对局本身照常进行（只是重启后回不到房间，同上一行）。确认地址（`redis://主机:端口/库号`）、有没有设密码（`redis://:密码@主机:6379/0`）、容器网络里主机名是否是服务名 |
| 设为 CDN 后素材 404 / 控制台报跨域 | CDN 目录结构必须与 `public/assets/` 一致；Spine 的 `.skel` / `.atlas` 靠 `fetch` 读取，需要 `Access-Control-Allow-Origin`。先直接访问 `<CDN>/assets/char/avatar/char_002_amiya.png` 确认能打开 |

## 6. 本地客户端素材（可选）

`public/assets/local/` 和 `data/local-assets.json` 是从本机安装的《明日方舟》客户端里提取的官方素材（`tools/local-extract`，DESIGN §13）：`node tools/setup.mjs` 检测到客户端时会询问是否提取，之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定客户端目录。setup 从公开镜像下载的素材不包含这部分，所以在没有客户端的电脑上（例如 Linux 服务器）从源码部署时不会有它；Releases 的完整包里已经带上了。

没有本地素材时游戏照常运行，只是下面几样换成替代样式：

| 内容 | 没有本地素材时 |
|---|---|
| 官方 3D 棋盘（贴图、模型、地图特效） | 2D 棋盘，地块由程序绘制 |
| 部分官方界面图标与底板：交流按钮和表情面板的边框、暂停面板、装备替换窗口、干员调配界面、队友状态与漏怪标记、模组类型图标等 | 样式相近的替代图形、图标或文字 |
| 灼热 / 炽焰源石虫的官方模型 | 染成橙色 / 红橙色的普通源石虫 |

表情（6 套 × 6 个）和「玩法说明」的 19 页教程图公开镜像也有：`node tools/setup.mjs` 会和其他素材一起下载（约 21 MB），不需要客户端；有本地素材时优先显示本地的。两处的图都会被收进预载清单（本地提取的那份和镜像的那份各一条，客户端照旧本地优先）：36 张战斗表情属于第一批（对局界面要用），19 页「玩法说明」属于后台批次（整屏截图，不急）。

**没有客户端的服务器**想要上表中的官方素材：从**同一版本**的完整包（[Releases](https://github.com/sganggs/Stronghold-Protocol/releases)）里，把 `public/assets/local/` 文件夹和 `data/local-assets.json` 复制到服务器项目目录下的相同位置。服务器每次请求都会重新读取这两处，不必重启，玩家刷新页面即可。一定要用与服务器代码相同版本的完整包：各版本提取的内容和清单可能不同（例如灼热 / 炽焰源石虫的模型是 0.1.0 之后才加入的），混用其他版本的文件会缺图或用错图。复制后 `node tools/doctor.mjs` 会显示本地素材的条目数和「3D 棋盘可用」。
