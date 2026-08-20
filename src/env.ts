/**
 * 两个「外部世界」的依赖：现在几点、下一个 id 是什么。
 *
 * 直接在逻辑里调 Date.now() / Math.random() 的代价不是「不优雅」，
 * 是没法测 —— 时间相关的分支只能靠 sleep 或者把 at 一路当参数传，
 * 后者等于把测试的需要泄露到 API 上，每个调用点都得记得传时间戳。
 */
export type Env = {
  now: () => number
  newId: () => string
}

export const systemEnv: Env = {
  now: () => Date.now(),
  newId: () => Math.random().toString(36).slice(2, 9),
}

export type TestEnv = Env & {
  set: (t: number) => void
  advance: (ms: number) => void
}

/** 测试用：时间手动推，id 按顺序发 */
export function testEnv(start = 0): TestEnv {
  let t = start
  let n = 0
  return {
    now: () => t,
    newId: () => `id${++n}`,
    set: (v) => {
      t = v
    },
    advance: (ms) => {
      t += ms
    },
  }
}
