import type { State } from './model'

/**
 * 什么时候把状态落盘。
 *
 * 落盘这件事在 Tauri 里不便宜：序列化整个 state、跨 IPC 送进 Rust、
 * 再 write + rename 到磁盘。而改任务名是**逐字符**触发的 —— 打一行字
 * 就是几十次 IPC 加几十次磁盘写，全排在同一条 IPC 线程上。
 *
 * 所以：高频编辑等一等再合并着写；要紧的变化（开始/暂停/换片这类）
 * 不等；再加一个最长间隔兜底，别为了省 IO 把人刚打的字拖太久。
 */

export const PUSH_WAIT_MS = 250
export const PUSH_MAX_WAIT_MS = 1000

/** 定时器和时钟都注入，测试才能用假时钟跑 —— 跟 env.ts 一个路子 */
export type Timers = {
  set: (fn: () => void, ms: number) => number
  clear: (id: number) => void
  now: () => number
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
  now: () => Date.now(),
}

export function createPushScheduler(
  send: (state: State) => void,
  timers: Timers = realTimers,
  waitMs = PUSH_WAIT_MS,
  maxWaitMs = PUSH_MAX_WAIT_MS,
) {
  let pending: State | null = null
  let timer: number | undefined
  // 让第一次 push 直接走，不平白压 250ms
  let lastSentAt = -Infinity

  function fire() {
    if (timer !== undefined) {
      timers.clear(timer)
      timer = undefined
    }
    const s = pending
    pending = null
    if (!s) return
    lastSentAt = timers.now()
    send(s)
  }

  return {
    /** urgent：阶段变了、片数变了这类，立刻落盘，不跟打字一起等 */
    push(state: State, urgent = false) {
      pending = state
      if (urgent || timers.now() - lastSentAt >= maxWaitMs) {
        fire()
        return
      }
      if (timer !== undefined) timers.clear(timer)
      timer = timers.set(fire, waitMs)
    },
    /** 窗口要没了之类，把攒着的立刻推出去 */
    flush: fire,
    hasPending: () => pending !== null,
  }
}
