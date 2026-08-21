# taskdial · 轮盘

[English](README.md) · **中文**

固定时间片的任务轮转器。一个圆分成 N 片，每片是一个正在推进的任务；片长到点，盘转到下一片，等你确认再开始计时。

- 当前任务名在最上面，带片号色标和累计时长
- 底部一只像素小动物跟着本轮进度从左跑到右，到点坐下等你确认，终点它想要的东西一直在转，越接近本轮结束转得越快 —— 池子里 111 套跑者/目标物组合，每次真正开始新一轮随机换一只（暂停再继续不换）
- 每个任务**自己的片长** —— 收邮件 5 分钟，深度活 50 分钟

## 装

去 [Releases](https://github.com/victor-develop/taskdial/releases) 下最新的 `.app`。只有 Apple Silicon 的构建，Intel Mac 得自己从源码打。

app **没有签名和公证**，第一次打开会被 Gatekeeper 拦。右键点图标 → 打开 → 再点一次「打开」。或者：

```bash
xattr -dr com.apple.quarantine /Applications/taskdial.app
```

## 从源码跑

### 桌面 app（Tauri，推荐）

```bash
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。窗口是无边框、置顶、不可缩放的，拖顶上那条状态栏移动。

### 浏览器 + PiP（不想装东西时的临时方案）

```bash
npm run dev
```

打开 http://localhost:5183 ，点右上角 **⧉** 把圆盘丢进 Document Picture-in-Picture 小窗，那个窗口是系统级置顶的。只有 Chromium 系支持；Safari、Firefox 里 ⧉ 按钮不会出现，页面本身照常能用。

## 本地 HTTP API

app 内置一个只绑 `127.0.0.1:7717` 的服务，让 agent 能读状态、改任务片。

```
GET    /                      landing page
GET    /insights              暂停报告 —— HTML，?format=md 出 markdown，?format=json 出结构化聚合
GET    /health                {ok, version, phase, uptime, window}
GET    /skills                能力清单（JSON，?format=md 出 markdown）
GET    /control/state         当前完整状态
POST   /control/slices        加一片            {name, lenMin}
PATCH  /control/slices/:id    改名 / 改片长
DELETE /control/slices/:id    删一片
POST   /control/pause         {reason?}
POST   /control/resume
```

**状态机只有一份。** 写请求不在 Rust 里复刻规则，而是转成 intent 交给窗口里那份 `model.reducer` 处理，所以边界跟 app 里完全一致（第 9 片返回 422，`lenMin: 9999` 夹成 180）。代价是写操作依赖窗口活着，不在时返回 503；只读端点不受影响。

`/insights?format=md` 是专门给 AI 吃的：聚合好、只列非零时段、没有 JSON 噪音。聚合实现在 `src-tauri/src/insights.rs`，三种形态共用同一份 —— 网页以前在浏览器里自己算一遍，那正是同一份报告长出两套算法的经典路径。

### 安全

默认只绑 loopback。校验 `Host` 头挡 DNS rebinding（网页可以把域名解析到 127.0.0.1 来打你的写接口），带 `Origin` 的写请求一律拒，不发任何 CORS 头。端口被占直接报错退出，不静默换端口 —— 换了 agent 就打空了。

配置在 app 配置目录下的 `server.json`：

```json
{ "enabled": true, "bind": "127.0.0.1", "port": 7717 }
```

`bind` 可以放开，而且没有 token —— 也就是说**同网段任何人都能改你的状态，不只是读**。所以默认值保持 loopback，放开必须是你显式改配置。

## 存档

存在 webview 的 localStorage。Tauri 里按 app identifier 存，跟端口无关，怎么重启都在。浏览器模式下跟 dev server 进程无关 —— 杀了重开数据还在。

浏览器模式下端口在 `vite.config.ts` 里锁死了 5183 + `strictPort`。**别改**：localStorage 按 origin 分桶，换个端口就等于换了个空桶，看起来像数据丢了。端口被占时 Vite 会直接报错退出，不会静默顺延到别的端口。（Tauri 里没有这个问题 —— 前端是从内置协议加载的，没有端口。）

会丢的只有一种情况：正在跑但没确认的那一轮，隔了超过两个片长才回来 —— 那一轮直接作废，不给补记。

设置面板里有 **导出 / 导入**，存档是一个 JSON 文件。换 origin、换机器、清缓存之后都靠它搬。导入一律落回 idle 状态 —— 不拿别处没跑完的那一轮接着计时。

<details>
<summary>试过 numa，暂时放弃（留个记录）</summary>

[numa](https://github.com/razvandimescu/numa) 能给服务发 `.numa` 域名，origin 里就没有端口了。但这台机器上 **Cloudflare WARP** 占着 `127.0.2.2:53` / `127.0.2.3:53`，numa 默认绑 `0.0.0.0:53`，macOS 上通配绑定跟已有的具体地址绑定冲突，服务起不来。

真要接的话（都需要 sudo）：`~/.config/numa/numa.toml` 里写 `[server] bind_addr = "127.0.0.1:53"`，然后 `sudo numa install --no-system-dns`（**别用**不带参数的版本，那个会把系统 DNS 从 WARP 抢过来），再写 `/etc/resolver/numa` 让 `*.numa` 单独走 127.0.0.1。vite 那边要把 `dial.numa` 加进 `server.allowedHosts`。

没接的原因：`strictPort` 已经解决了存档换桶的问题，而走到 Tauri 之后根本没有 origin 这回事。

</details>

## 已定的设计

| 决定 | 怎么做的 | 为什么 |
|---|---|---|
| 确认不自动开始 | 到点后停在 `awaiting`，不点就一直等 | 计时器上的数字 = 真实投入，不掺等待时间 |
| 顺序固定 | 按 1→2→3→4 转 | 强制均衡，避免一直待在舒适区 |
| 锁片是显式动作 | 双击盘面，或确认条里点 🔒 | All-in 一个任务是个决定，不该是默认状态 |
| 手动收工 | 设置 → 收工，不按自然日切 | 熬到凌晨两点不该被判成第二天 |
| 时间用时间戳算 | 一律 `Date.now()` 差值，不靠 `setInterval` 累加 | 后台 tab 定时器会被降频，累加会走慢 |
| 饼块角度不跟片长走 | 50min 的片和 5min 的片一样大 | 片长是「一次给多少」，年轮是「总共给了多少」。压到同一个几何量上，年轮就没法互相比了 —— 短片长那片投入再多也会显得少 |

每片的片长在设置里改，点那一行的 `5m` 就展开预设。那个**默认值只用来给新片赋初值**，不做实时继承，每片都带一个显式数字。下一片多长会在确认条上先告诉你 —— 顺序是固定的，下一片跟你刚跑完那片很可能不一样长。

## 年轮

年轮**连续生长** —— 计时一开始弧就在长，不是每轮跳一格。确认那一刻不会有跳变，因为正在跑的这一轮实时算进了当前片。

- **一直在长** → 当前层的弧持续推进
- **每 1 小时** → 长成一整层年轮，一段三音提示音
- **每 8 小时**（8 层）→ 弧边刻一道，年轮色阶加深，从内圈开始下一圈

3 圈 = 24h 才算满片。一个任务喂一整天也填不满，晚上还有东西可看。

层的单位是**实际投入时长**，跟片长解耦 —— 改成 25min 片，还是 1 小时长一层。

## 代码

- `src/model.ts` — 状态机、年轮换算、localStorage 存档
- `src/Dial.tsx` — SVG 盘面，扇环 path 和转盘动画
- `src/App.tsx` — 计时循环、确认条、设置、收工总结
- `src/Runner.tsx` — 渲染当前抽到的那一套跑者/目标物；精灵图是字符串矩阵压成的 SVG path
- `src/zoo/` — 精灵图池子，**一个文件一只动物**（`src/zoo/pets-dachshund-sausage.ts` 之类），外加 `index.ts`（barrel + `pickZooSprite`）和 `types.ts`。由 `pixel-zoo/gen_zoo_ts.py` 从 `pixel-zoo/sprites.json` 生成 —— 改单只动物就直接改它的文件；要批量改画法就改生成脚本重新跑一遍，别手改 111 个文件
- `src/autosize.ts` — 把 Tauri 窗口高度调成跟内容一样
- `src/pip.ts` — Document PiP，把 `#root` 整个搬进小窗（不重挂载，状态不丢）
- `src-tauri/` — 桌面外壳，窗口配置在 `tauri.conf.json`

改之前有三件事得知道：

**PiP 搬的必须是 React 的根容器本身。** React 把事件委托挂在根容器上，只搬里面某个子节点的话，PiP 窗里的事件冒泡不到那个容器，所有按钮都会失效。所以 `index.html` 里 `#root` 外面还包了个 `#home` 当窝。

**像素图不能靠 transform 旋转。** 转出来是糊的锯齿。每个目标物都是逐帧画的：0° 和 45° 手画，另外两帧靠 `Runner.tsx` 里的 `rot90` 转置得到。180° 对称（或者接近）的形状四帧都立得住；细长、有明确朝向的形状转到 45° 会拍扁成一条认不出来的斜线 —— 这是已知问题，见下面「之后」。

**换动物只在真正开始新一轮时发生，暂停恢复不算。** `Runner` 盯着 phase 的跳变：`idle`/`awaiting` → `running` 才抽新的，`paused` → `running` 保持原来那只 —— 暂停完一恢复，脚下的动物突然换了个物种，会很突兀。这套逻辑整个封在 `Runner.tsx` 里，没往 `model.ts` 加任何状态：抽到哪只动物这件事不值得持久化，也不值得写测试。

## 之后

- 存档从 localStorage 换成 JSON 文件（能备份、能进 git）
- 开机自启、菜单栏图标
- 收工总结做成一张能看的图
- 重画 `pixel-zoo/quality_check.py` 标出的那 ~30 套 —— 目标物转到 45° 时「填充像素占外接矩形」的密度骤降（细长形状被拍成了一条斜线，不是它本来该有的样子）。先这样上了，不算坏，只是有些没那么好认。打开 `pixel-zoo/preview.html` 勾选「只看有疑虑的」能直接看到是哪几个
