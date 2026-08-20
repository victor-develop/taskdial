# 轮盘

固定时间片的任务轮转器。一个圆分成 N 片，每片是一个正在推进的任务；片长到点，盘转到下一片，等你确认再开始计时。

- 当前任务名在最上面，带片号色标和累计时长
- 底部一只像素小狗跟着本轮进度从左跑到右，到点坐下等你确认
- 终点一根像素骨头在转，越接近本轮结束转得越快

## 跑起来

### 桌面 app（Tauri，推荐）

```bash
npm run tauri dev
```

打包成 `.app` / `.dmg`：

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。窗口是无边框、置顶、不可缩放的，拖顶上那条状态栏移动。

### 浏览器 + PiP（不装 app 时的临时方案）

```bash
npm run dev
```

打开 http://localhost:5183 ，点右上角 **⧉** 把圆盘丢进 Document Picture-in-Picture 小窗，
那个窗口是系统级置顶的。只有 Chromium 系支持；Safari、Firefox 里 ⧉ 按钮不会出现，页面本身照常能用。

## 存档

存在 webview 的 localStorage。Tauri 里按 app identifier 存，跟端口无关，怎么重启都在。
浏览器模式下跟 dev server 进程无关 —— 杀了重开数据还在。

浏览器模式下端口在 `vite.config.ts` 里锁死了 5183 + `strictPort`。**别改**：localStorage 按 origin 分桶，
换个端口就等于换了个空桶，看起来像数据丢了。端口被占时 Vite 会直接报错退出，不会静默顺延到别的端口。
（Tauri 里没有这个问题 —— 前端是从内置协议加载的，没有端口。）

会丢的只有一种情况：正在跑但没确认的那一轮，隔了超过两个片长才回来 —— 那一轮直接作废，不给补记。

设置面板里有 **导出 / 导入**，存档是一个 JSON 文件。换 origin、换机器、清缓存之后都靠它搬。
导入一律落回 idle 状态 —— 不拿别处没跑完的那一轮接着计时。

### 试过 numa，暂时放弃（留个记录）

[numa](https://github.com/razvandimescu/numa) 能给服务发 `.numa` 域名，origin 里就没有端口了。
但这台机器上 **Cloudflare WARP** 占着 `127.0.2.2:53` / `127.0.2.3:53`，numa 默认绑 `0.0.0.0:53`，
通配绑定跟具体地址绑定冲突，服务起不来。

真要接的话（都需要 sudo）：`~/.config/numa/numa.toml` 里写 `[server] bind_addr = "127.0.0.1:53"`，
然后 `sudo numa install --no-system-dns`（别用不带参数的版本，那个会把系统 DNS 从 WARP 抢过来），
再写 `/etc/resolver/numa` 让 `*.numa` 单独走 127.0.0.1。vite 那边要把 `dial.numa` 加进 `server.allowedHosts`。

没接的原因：`strictPort` 已经解决了存档换桶的问题，而走到 Tauri 之后根本没有 origin 这回事。

## 已定的设计

| 决定 | 怎么做的 | 为什么 |
|---|---|---|
| 确认不自动开始 | 到点后停在 `awaiting`，不点就一直等 | 计时器上的数字 = 真实投入，不掺等待时间 |
| 顺序固定 | 默认按 1→2→3→4 转 | 强制均衡，避免一直待在舒适区 |
| 锁片是显式动作 | 双击盘面，或确认弹窗里点 🔒 | All-in 一个任务是个决定，不该是默认状态 |
| 手动收工 | 设置 → 收工，不按自然日切 | 熬到凌晨两点不该被判成第二天 |
| 时间用时间戳算 | 一律 `Date.now()` 差值，不靠 `setInterval` 累加 | 后台 tab 定时器会被降频，累加会走慢 |

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
- `src/App.tsx` — 计时循环、确认弹窗、设置、收工总结
- `src/Runner.tsx` — 像素小狗和骨头，精灵图是字符串矩阵压成的 path
- `src/pip.ts` — Document PiP，把 `#root` 整个搬进小窗（不重挂载，状态不丢）
- `src-tauri/` — 桌面外壳，窗口配置在 `tauri.conf.json`

搬的必须是 React 的**根容器本身**。React 把事件委托挂在根容器上，只搬里面某个子节点的话，
PiP 窗里的事件冒泡不到那个容器，所有按钮都会失效。所以 `index.html` 里 `#root` 外面还包了个 `#home` 当窝。

## 之后

- 存档从 localStorage 换成 JSON 文件（能备份、能进 git）
- 开机自启、菜单栏图标、窗口位置记忆
- 收工总结做成一张能看的图
