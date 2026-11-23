/**
 * 前端 ↔ Rust server 的桥（issue #1 方案 B 的前端半边）。
 *
 * 三件事：把每次状态变化推给 Rust（内存快照 + 落盘）、启动时从 Rust 的
 * state.json 恢复、监听 server 转来的 intent 并用 model.reducer 处理后回话。
 * 全部动态 import @tauri-apps/api，浏览器里跑（vite dev / PiP）时是空操作。
 */
import { model, type State } from './model'
import { createPushScheduler } from './persist'
import { applyIntent } from './remote'

export const inTauri = () => '__TAURI_INTERNALS__' in globalThis

const core = () => import('@tauri-apps/api/core')

const pushQueue = createPushScheduler((state) => {
  void core()
    .then(({ invoke }) => invoke('sync_state', { state: JSON.stringify(state) }))
    .catch(() => {})
})

/**
 * 把状态推给 Rust 落盘。推不动就算了 —— 别因为 server 挂掉计时。
 *
 * 默认合并一小段时间内的多次变化：改任务名是逐字符触发的，不合并的话
 * 打一行字就是几十次 IPC + 几十次磁盘写，打字会明显发卡。
 * urgent 用于阶段/片数这类要紧变化，不等。
 */
export function pushState(state: State, urgent = false) {
  if (!inTauri()) return
  pushQueue.push(state, urgent)
}

/** 把攒着还没推的那份立刻推出去（窗口要关了之类） */
export function flushState() {
  if (!inTauri()) return
  pushQueue.flush()
}

/**
 * 启动时问 Rust 要它管的存档文件。文件在，它就是主存档（server 改过的状态
 * 都在里面）；不在（首次升级）返回 null，调用方沿用 localStorage 那份，
 * 下一次 pushState 就把它迁移成文件了。
 */
export async function loadSavedState(): Promise<State | null> {
  if (!inTauri()) return null
  try {
    const { invoke } = await core()
    const raw = await invoke<string | null>('load_saved_state')
    return raw ? model.restore(raw) : null
  } catch {
    return null
  }
}

/**
 * 监听 server 发来的 intent。收到就跑 reducer，把新状态交给 apply（让窗口
 * 立刻刷新），再回话给 Rust（落盘 + 作为 HTTP 响应返回）。返回取消函数。
 */
export function listenIntents(
  getState: () => State,
  apply: (next: State) => void,
): () => void {
  if (!inTauri()) return () => {}
  let unlisten: (() => void) | undefined
  let stopped = false
  void (async () => {
    const [{ listen }, { invoke }] = await Promise.all([
      import('@tauri-apps/api/event'),
      core(),
    ])
    const un = await listen<{ id: number; intent: unknown }>('server://intent', (e) => {
      const res = applyIntent(model, getState(), e.payload.intent)
      if (res.ok) {
        apply(res.next)
        void invoke('intent_done', { id: e.payload.id, state: JSON.stringify(res.next) })
      } else {
        void invoke('intent_failed', { id: e.payload.id, error: res.error })
      }
    })
    // StrictMode 下 effect 会挂了又拆：拆得比 listen 完成还早时，别漏监听器
    if (stopped) un()
    else unlisten = un
  })()
  return () => {
    stopped = true
    unlisten?.()
  }
}

/**
 * 一轮到点的提示音。Tauri 里走系统 afplay（webview 的 AudioContext 可能
 * 是 suspended 的，到点了反而不响）；浏览器里退回 WebAudio。
 */
export function playAlert(fallback: () => void) {
  if (!inTauri()) return fallback()
  void core()
    .then(({ invoke }) => invoke('play_alert'))
    .catch(fallback)
}

/** ▤ 按钮：开系统浏览器看 /insights。浏览器里开新标签页，行为一致。 */
export function openInsights() {
  if (inTauri()) {
    void core()
      .then(({ invoke }) => invoke('open_insights'))
      .catch(() => {})
  } else {
    window.open('http://127.0.0.1:7717/insights', '_blank')
  }
}
