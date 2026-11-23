import { beforeEach, describe, expect, it } from 'vitest'
import {
  PUSH_MAX_WAIT_MS,
  PUSH_WAIT_MS,
  createPushScheduler,
  type Timers,
} from './persist'
import type { State } from './model'

/** 假时钟 + 假定时器：时间手动推，到点的回调手动触发 */
function fakeTimers() {
  let t = 0
  let nextId = 1
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    now: () => t,
    set: (fn, ms) => {
      const id = nextId++
      jobs.set(id, { at: t + ms, fn })
      return id
    },
    clear: (id) => void jobs.delete(id),
  }
  return {
    timers,
    /** 把时间往前推 ms，期间到点的定时器按顺序跑掉 */
    advance(ms: number) {
      const target = t + ms
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, j]) => j.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, job] = due
        jobs.delete(id)
        t = job.at
        job.fn()
      }
      t = target
    },
  }
}

/** 只关心身份，内容无所谓 */
const st = (tag: string) => ({ tag } as unknown as State)

let clock: ReturnType<typeof fakeTimers>
let sent: State[]
let q: ReturnType<typeof createPushScheduler>

beforeEach(() => {
  clock = fakeTimers()
  sent = []
  q = createPushScheduler((s) => sent.push(s), clock.timers)
})

const tags = () => sent.map((s) => (s as unknown as { tag: string }).tag)

describe('落盘的节流', () => {
  it('第一次不等，直接落盘', () => {
    q.push(st('a'))
    expect(tags()).toEqual(['a'])
  })

  it('打字这种连发只落最后一次 —— 这就是卡顿的根因', () => {
    q.push(st('first')) // 首次直接走
    sent = []
    // 模拟逐字符改名：每 40ms 一个键，连打 20 个
    for (let i = 0; i < 20; i++) {
      clock.advance(40)
      q.push(st(`k${i}`))
    }
    // 800ms 内一次都还没到 maxWait，攒着
    expect(sent.length).toBeLessThanOrEqual(1)
    clock.advance(PUSH_WAIT_MS)
    // 落的是最后那次，不是中间任何一次
    expect(tags().at(-1)).toBe('k19')
    // 20 次按键最多换来 2 次落盘，不是 20 次
    expect(sent.length).toBeLessThanOrEqual(2)
  })

  it('停手之后才落盘，落的是最新那份', () => {
    q.push(st('a'))
    sent = []
    clock.advance(10)
    q.push(st('b'))
    clock.advance(PUSH_WAIT_MS - 1)
    expect(sent).toHaveLength(0) // 还没到点
    clock.advance(1)
    expect(tags()).toEqual(['b'])
  })

  it('一直不停手也不会无限拖着 —— 最长间隔兜底', () => {
    q.push(st('a'))
    sent = []
    // 每 100ms 敲一下，永远不给 250ms 的安静期
    for (let i = 0; i < 30; i++) {
      clock.advance(100)
      q.push(st(`k${i}`))
    }
    // 3 秒里至少被 maxWait 逼着落了 2 次
    expect(sent.length).toBeGreaterThanOrEqual(2)
    // 但也远少于 30 次
    expect(sent.length).toBeLessThan(10)
  })

  it('要紧的变化不等 —— 开始/暂停/换片不能拖', () => {
    q.push(st('a'))
    sent = []
    clock.advance(10)
    q.push(st('typing'))
    expect(sent).toHaveLength(0)
    q.push(st('phase-changed'), true)
    expect(tags()).toEqual(['phase-changed'])
  })

  it('紧急落盘之后，之前排着的定时器不会再补一次', () => {
    q.push(st('a'))
    sent = []
    clock.advance(10)
    q.push(st('typing'))
    q.push(st('urgent'), true)
    sent = []
    clock.advance(PUSH_WAIT_MS * 2)
    expect(sent).toHaveLength(0)
  })

  it('flush 把攒着的立刻推出去（窗口要关了）', () => {
    q.push(st('a'))
    sent = []
    clock.advance(10)
    q.push(st('half-typed'))
    expect(q.hasPending()).toBe(true)
    q.flush()
    expect(tags()).toEqual(['half-typed'])
    expect(q.hasPending()).toBe(false)
  })

  it('没东西可推时 flush 什么也不做', () => {
    q.flush()
    q.flush()
    expect(sent).toHaveLength(0)
  })

  it('推过之后隔久了再推，立刻走', () => {
    q.push(st('a'))
    sent = []
    clock.advance(PUSH_MAX_WAIT_MS)
    q.push(st('b'))
    expect(tags()).toEqual(['b']) // 不用等 250ms
  })
})
