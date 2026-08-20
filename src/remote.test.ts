import { beforeEach, describe, expect, it } from 'vitest'
import { testEnv, type TestEnv } from './env'
import { MS_MIN, createModel, type Model, type State } from './model'
import { applyIntent, type IntentResult } from './remote'

// vitest 跑在 node 里没有 localStorage；model.ts 顶层不碰它，
// 但 restore/load 会 —— 给个最小实现
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
  configurable: true,
})

const T0 = 1_700_000_000_000

let env: TestEnv
let m: Model

beforeEach(() => {
  env = testEnv(T0)
  m = createModel(env)
})

const ok = (r: IntentResult): State => {
  if (!r.ok) throw new Error(`intent 不该被拒：${r.error}`)
  return r.next
}
const err = (r: IntentResult): string => {
  if (r.ok) throw new Error('intent 该被拒却成功了')
  return r.error
}

describe('intent: addSlice', () => {
  it('带 name 和 lenMin 加一片', () => {
    const s = m.initialState()
    const next = ok(applyIntent(m, s, { op: 'addSlice', name: '写文档', lenMin: 25 }))
    expect(next.slices).toHaveLength(5)
    expect(next.slices[4]).toMatchObject({ name: '写文档', lenMin: 25, totalMs: 0 })
    // 原状态不被改动 —— reducer 是纯的，这里也得是
    expect(s.slices).toHaveLength(4)
  })

  it('不带字段用默认值（新任务 + defaultLenMin）', () => {
    let s = m.reducer(m.initialState(), { type: 'setDefaultLen', min: 40 })
    const next = ok(applyIntent(m, s, { op: 'addSlice' }))
    expect(next.slices[4]).toMatchObject({ name: '新任务', lenMin: 40 })
  })

  it('lenMin 越界被夹在 1–180，跟 reducer 一致', () => {
    const s = m.initialState()
    expect(ok(applyIntent(m, s, { op: 'addSlice', lenMin: 9999 })).slices[4].lenMin).toBe(180)
    expect(ok(applyIntent(m, s, { op: 'addSlice', lenMin: -3 })).slices[4].lenMin).toBe(1)
  })

  it('已有 8 片加不了，报错而不是安静忽略', () => {
    let s = m.initialState()
    for (let i = 0; i < 4; i++) s = m.reducer(s, { type: 'addSlice' })
    expect(s.slices).toHaveLength(8)
    expect(err(applyIntent(m, s, { op: 'addSlice' }))).toContain('8')
  })

  it('name 太长截到 60 字，两端空白剥掉', () => {
    const s = m.initialState()
    const next = ok(applyIntent(m, s, { op: 'addSlice', name: `  ${'长'.repeat(70)}  ` }))
    expect(next.slices[4].name).toBe('长'.repeat(60))
  })

  it('类型不对直接拒', () => {
    const s = m.initialState()
    expect(err(applyIntent(m, s, { op: 'addSlice', name: 42 }))).toContain('name')
    expect(err(applyIntent(m, s, { op: 'addSlice', lenMin: '25' }))).toContain('lenMin')
    expect(err(applyIntent(m, s, { op: 'addSlice', lenMin: NaN }))).toContain('lenMin')
    expect(err(applyIntent(m, s, { op: 'addSlice', name: '   ' }))).toContain('name')
  })
})

describe('intent: updateSlice', () => {
  it('改名 / 改片长 / 一起改', () => {
    const s = m.initialState()
    const id = s.slices[1].id

    const renamed = ok(applyIntent(m, s, { op: 'updateSlice', id, name: '改过' }))
    expect(renamed.slices[1].name).toBe('改过')
    expect(renamed.slices[1].lenMin).toBe(s.slices[1].lenMin)

    const relen = ok(applyIntent(m, s, { op: 'updateSlice', id, lenMin: 50 }))
    expect(relen.slices[1].lenMin).toBe(50)
    expect(relen.slices[1].name).toBe(s.slices[1].name)

    const both = ok(applyIntent(m, s, { op: 'updateSlice', id, name: '都改', lenMin: 15 }))
    expect(both.slices[1]).toMatchObject({ name: '都改', lenMin: 15 })
  })

  it('片长越界被夹住', () => {
    const s = m.initialState()
    const id = s.slices[0].id
    expect(ok(applyIntent(m, s, { op: 'updateSlice', id, lenMin: 300 })).slices[0].lenMin).toBe(180)
    expect(ok(applyIntent(m, s, { op: 'updateSlice', id, lenMin: 0 })).slices[0].lenMin).toBe(1)
  })

  it('id 不存在 / 缺 id / 什么字段都没给，都拒', () => {
    const s = m.initialState()
    expect(err(applyIntent(m, s, { op: 'updateSlice', id: 'nope', name: 'x' }))).toContain('nope')
    expect(err(applyIntent(m, s, { op: 'updateSlice', name: 'x' }))).toContain('id')
    expect(err(applyIntent(m, s, { op: 'updateSlice', id: s.slices[0].id }))).toContain('至少')
  })
})

describe('intent: removeSlice', () => {
  it('删掉指定那片', () => {
    const s = m.initialState()
    const id = s.slices[3].id
    const next = ok(applyIntent(m, s, { op: 'removeSlice', id }))
    expect(next.slices).toHaveLength(3)
    expect(next.slices.some((sl) => sl.id === id)).toBe(false)
  })

  it('只剩 3 片删不掉，报错而不是安静忽略', () => {
    let s = m.initialState()
    s = ok(applyIntent(m, s, { op: 'removeSlice', id: s.slices[0].id }))
    expect(err(applyIntent(m, s, { op: 'removeSlice', id: s.slices[0].id }))).toContain('3')
    expect(s.slices).toHaveLength(3)
  })

  it('id 不存在时拒，且不看片数下限（先报更准的错）', () => {
    const s = m.initialState()
    expect(err(applyIntent(m, s, { op: 'removeSlice', id: 'ghost' }))).toContain('ghost')
  })
})

describe('intent: pause / resume', () => {
  const running = () => m.reducer(m.initialState(), { type: 'start' })

  it('running 时暂停，原因记进最新那条暂停', () => {
    const next = ok(applyIntent(m, running(), { op: 'pause', reason: '会议' }))
    expect(next.phase).toBe('paused')
    expect(next.pauses[0]).toMatchObject({ reason: '会议', endedAt: null, sliceName: '写 PRD' })
  })

  it('暂停冻结投入：intent 走的也是同一份 reducer', () => {
    const s = running()
    env.advance(10 * MS_MIN)
    const next = ok(applyIntent(m, s, { op: 'pause' }))
    expect(next.roundElapsedMs).toBe(10 * MS_MIN)
    expect(next.pauses[0].reason).toBeUndefined()
  })

  it('原因超 40 字被 reducer 截断', () => {
    const s = running()
    const next = ok(applyIntent(m, s, { op: 'pause', reason: 'x'.repeat(50) }))
    expect(next.pauses[0].reason).toBe('x'.repeat(40))
  })

  it('不是 running 不能暂停，错误里说清当前 phase', () => {
    expect(err(applyIntent(m, m.initialState(), { op: 'pause' }))).toContain('idle')
    const paused = ok(applyIntent(m, running(), { op: 'pause' }))
    expect(err(applyIntent(m, paused, { op: 'pause' }))).toContain('paused')
  })

  it('resume 接上暂停，endedAt 落在最新那条上', () => {
    let s = running()
    env.advance(5 * MS_MIN)
    s = ok(applyIntent(m, s, { op: 'pause' }))
    env.advance(30 * MS_MIN)
    const next = ok(applyIntent(m, s, { op: 'resume' }))
    expect(next.phase).toBe('running')
    expect(next.pauses[0].endedAt).toBe(T0 + 35 * MS_MIN)
  })

  it('不是 paused 不能 resume', () => {
    expect(err(applyIntent(m, running(), { op: 'resume' }))).toContain('running')
    expect(err(applyIntent(m, m.initialState(), { op: 'resume' }))).toContain('idle')
  })
})

describe('intent: 垃圾输入', () => {
  it.each([
    ['不是对象', 'hi'],
    ['null', null],
    ['没有 op', {}],
    ['op 不认识', { op: 'dropTables' }],
    ['op 不是字符串', { op: 7 }],
  ])('拒绝 %s', (_label, raw) => {
    expect(applyIntent(m, m.initialState(), raw).ok).toBe(false)
  })
})

describe('model.restore（Rust 的 state.json 和 localStorage 走同一条路）', () => {
  it('null 给全新状态', () => {
    expect(m.restore(null).slices).toHaveLength(4)
  })

  it('文本存档原样恢复', () => {
    let s = m.reducer(m.initialState(), { type: 'setDefaultLen', min: 40 })
    s = m.reducer(s, { type: 'addSlice' })
    const back = m.restore(JSON.stringify(s))
    expect(back.slices).toHaveLength(5)
    expect(back.slices[4].lenMin).toBe(40)
  })

  it('跑飞太久的那一轮作废，跟 load 一个规矩', () => {
    const s = m.reducer(m.initialState(), { type: 'start' })
    env.advance(60 * MS_MIN) // 5 分钟的片，一小时后才回来
    const back = m.restore(JSON.stringify(s))
    expect(back.phase).toBe('idle')
    expect(back.roundStartedAt).toBeNull()
  })

  it('烂 JSON 落回全新状态，不抛', () => {
    expect(m.restore('{oops').slices).toHaveLength(4)
  })
})
