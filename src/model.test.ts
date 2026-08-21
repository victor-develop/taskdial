import { beforeEach, describe, expect, it } from 'vitest'
import { testEnv, type TestEnv } from './env'
import {
  CAP_MS,
  MAX_PAUSES,
  MS_HOUR,
  MS_MIN,
  createModel,
  elapsedMs,
  sliceAngle,
  rings,
  roundMs,
  save,
  type Model,
  type State,
} from './model'

// vitest 默认跑在 node 里，没有 localStorage，给个最小实现
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
const at = (min: number) => T0 + min * MS_MIN

let env: TestEnv
let m: Model

beforeEach(() => {
  env = testEnv(T0)
  m = createModel(env)
  store.clear()
})

/** 一个可控的起点：4 片、每片 lenMin 分钟、刚跑起来 */
function running(lenMin = 25): State {
  const base = m.initialState()
  const s: State = { ...base, slices: base.slices.map((sl) => ({ ...sl, lenMin })) }
  return m.reducer(s, { type: 'start' })
}

describe('暂停冻结投入', () => {
  it('暂停期间投入不涨，继续后接着同一轮跑', () => {
    let s = running()
    expect(elapsedMs(s, at(10))).toBe(10 * MS_MIN)

    env.set(at(10))
    s = m.reducer(s, { type: 'pause' })
    expect(s.phase).toBe('paused')
    expect(s.roundElapsedMs).toBe(10 * MS_MIN)

    // 停两个小时也好，停三天也好，都不该多算一分钟
    expect(elapsedMs(s, at(130))).toBe(10 * MS_MIN)
    expect(elapsedMs(s, at(10 + 3 * 24 * 60))).toBe(10 * MS_MIN)

    env.set(at(130))
    s = m.reducer(s, { type: 'resume' })
    expect(s.phase).toBe('running')
    // 接着跑 5 分钟 = 15，不是从 0 重来，也不是把暂停的 120 分钟算进去
    expect(elapsedMs(s, at(135))).toBe(15 * MS_MIN)
  })

  it('跑满一整片才结算', () => {
    let s = running(25)
    env.set(at(10))
    s = m.reducer(s, { type: 'pause' })
    env.set(at(130))
    s = m.reducer(s, { type: 'resume' })
    env.set(at(145))
    s = m.reducer(s, { type: 'complete' })

    expect(s.slices[0].totalMs).toBe(25 * MS_MIN)
    expect(s.roundElapsedMs).toBe(0)
    expect(s.phase).toBe('awaiting')
  })

  it('定时器晚触发也只记一片，不把超出的时间算进去', () => {
    // tab 被降频、机器睡了一觉，complete 迟到了 5 分钟才跑
    let s = running(25)
    expect(elapsedMs(s, at(30))).toBe(30 * MS_MIN)
    env.set(at(30))
    s = m.reducer(s, { type: 'complete' })
    // 记 25，不是 30 —— 一片就是一片
    expect(s.slices[0].totalMs).toBe(25 * MS_MIN)
  })

  it('确认下一轮时把累计清零，不会把上一轮的投入带过来', () => {
    let s = running()
    env.set(at(10))
    s = m.reducer(s, { type: 'pause' })
    env.set(at(20))
    s = m.reducer(s, { type: 'resume' })
    env.set(at(35))
    s = m.reducer(s, { type: 'complete' })
    s = m.reducer(s, { type: 'confirm' })
    expect(s.roundElapsedMs).toBe(0)
    expect(elapsedMs(s, at(35))).toBe(0)
  })

  it('只有 running 能暂停，只有 paused 能继续', () => {
    const idle = m.initialState()
    expect(m.reducer(idle, { type: 'pause' })).toBe(idle)
    expect(m.reducer(idle, { type: 'resume' })).toBe(idle)

    const s = running()
    expect(m.reducer(s, { type: 'resume' })).toBe(s)
  })
})

describe('暂停日志', () => {
  it('记下开始/结束/原因/当时在哪片', () => {
    let s = running()
    env.set(at(10))
    s = m.reducer(s, { type: 'pause' })
    s = m.reducer(s, { type: 'setPauseReason', reason: '会议' })
    env.set(at(40))
    s = m.reducer(s, { type: 'resume' })

    expect(s.pauses).toHaveLength(1)
    expect(s.pauses[0]).toMatchObject({
      at: at(10),
      endedAt: at(40),
      reason: '会议',
      sliceName: '写 PRD',
    })
  })

  it('原因清空就是没有原因，不是空字符串', () => {
    let s = running()
    s = m.reducer(s, { type: 'pause' })
    s = m.reducer(s, { type: 'setPauseReason', reason: '会议' })
    s = m.reducer(s, { type: 'setPauseReason', reason: '   ' })
    expect(s.pauses[0].reason).toBeUndefined()
  })

  it('收工不清暂停日志 —— 那是跨天的记录，不是今天的计数器', () => {
    let s = running()
    s = m.reducer(s, { type: 'pause' })
    s = m.reducer(s, { type: 'resume' })
    env.set(at(600))
    s = m.reducer(s, { type: 'finishDay' })

    expect(s.pauses).toHaveLength(1)
    expect(s.roundsToday).toBe(0)
    expect(s.slices.every((sl) => sl.totalMs === 0)).toBe(true)
    expect(s.dayStartedAt).toBe(at(600))
  })

  it('日志有上限，不会把存档撑爆', () => {
    let s = running()
    for (let i = 0; i < MAX_PAUSES + 30; i++) {
      env.set(at(i))
      s = m.reducer(s, { type: 'pause' })
      s = m.reducer(s, { type: 'resume' })
    }
    expect(s.pauses).toHaveLength(MAX_PAUSES)
    expect(s.pauses[0].at).toBe(at(MAX_PAUSES + 29)) // 留下的是最近的
  })
})

/** 盘面转完之后，指针（正上方）底下实际是哪一片 */
function pointerIndex(s: State) {
  const A = sliceAngle(s.slices.length)
  let best = 0
  let bestDelta = Infinity
  s.slices.forEach((_, i) => {
    const a = (((i * A + s.rotationDeg) % 360) + 360) % 360
    const delta = Math.min(a, 360 - a)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  })
  return { index: best, offBy: bestDelta }
}

describe('指针跟当前片必须始终一致', () => {
  it('一路转下去不会漂', () => {
    let s = running()
    for (let i = 0; i < 12; i++) {
      s = m.reducer(s, { type: 'complete' })
      s = m.reducer(s, { type: 'confirm' })
      const p = pointerIndex(s)
      expect(p.index).toBe(s.currentIndex)
      expect(p.offBy).toBeCloseTo(0)
    }
  })

  it('加片之后指针还指着当前片', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' }) // 4 片时转过一格，rotationDeg 是 -90 的倍数
    s = m.reducer(s, { type: 'addSlice' }) // 变 5 片，每格变成 72°
    const p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('转过很多轮再加片也一致', () => {
    let s = running()
    for (let i = 0; i < 25; i++) {
      s = m.reducer(s, { type: 'complete' })
      s = m.reducer(s, { type: 'confirm' })
    }
    const before = s.rotationDeg
    s = m.reducer(s, { type: 'addSlice' })
    const p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)
    // 只做小幅修正，不能把已经转过的圈数抹掉让盘面倒转好几圈
    expect(Math.abs(s.rotationDeg - before)).toBeLessThanOrEqual(sliceAngle(s.slices.length))
  })

  it('删片之后也一致', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' })
    s = m.reducer(s, { type: 'complete' })
    s = m.reducer(s, { type: 'removeSlice', id: s.slices[3].id })
    const p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('存档里角度是坏的，load 要修好（现有用户就是这个状态）', () => {
    const s = running()
    save({ ...s, slices: [...s.slices, { id: 'x', name: '第五片', totalMs: 0, lenMin: 5 }], currentIndex: 1, rotationDeg: -90 })
    const p = pointerIndex(m.load())
    expect(p.index).toBe(1)
    expect(p.offBy).toBeCloseTo(0)
  })
})

describe('轮转', () => {
  it('确认后转到下一片，转角只减不加（转向永远一致）', () => {
    let s = running()
    const before = s.rotationDeg
    s = m.reducer(s, { type: 'complete' })
    expect(s.currentIndex).toBe(1)
    expect(s.rotationDeg).toBe(before - 90)
  })

  it('锁片时不转，连续投喂同一片', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' })
    s = m.reducer(s, { type: 'togglePin' }) // 指针退回刚跑完那片
    expect(s.pinned).toBe(true)
    expect(s.currentIndex).toBe(0)

    s = m.reducer(s, { type: 'confirm' })
    s = m.reducer(s, { type: 'complete' })
    expect(s.currentIndex).toBe(0)
    expect(s.slices[0].totalMs).toBe(50 * MS_MIN)
  })

  it('跳过只换片不计时间', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' })
    const totals = s.slices.map((sl) => sl.totalMs)
    s = m.reducer(s, { type: 'skip' })
    expect(s.currentIndex).toBe(2)
    expect(s.slices.map((sl) => sl.totalMs)).toEqual(totals)
  })

  it('片数不足 3 时删不掉，超过 8 时加不了', () => {
    let s = m.initialState()
    s = m.reducer(s, { type: 'removeSlice', id: s.slices[0].id })
    expect(s.slices).toHaveLength(3)
    const three = s
    expect(m.reducer(s, { type: 'removeSlice', id: s.slices[0].id })).toBe(three)

    for (let i = 0; i < 10; i++) s = m.reducer(s, { type: 'addSlice' })
    expect(s.slices).toHaveLength(8)
  })

  it('新片用默认片长', () => {
    let s = m.reducer(m.initialState(), { type: 'setDefaultLen', min: 40 })
    s = m.reducer(s, { type: 'addSlice' })
    expect(s.slices.at(-1)!.lenMin).toBe(40)
  })

  it('片长按片存，roundMs 读的是当前片', () => {
    let s = m.initialState()
    s = m.reducer(s, { type: 'setLen', id: s.slices[0].id, min: 5 })
    s = m.reducer(s, { type: 'setLen', id: s.slices[1].id, min: 50 })
    expect(roundMs(s)).toBe(5 * MS_MIN)
    s = m.reducer(s, { type: 'start' })
    s = m.reducer(s, { type: 'complete' })
    expect(roundMs(s)).toBe(50 * MS_MIN)
  })

  it('片长被夹在合法范围里', () => {
    let s = m.initialState()
    s = m.reducer(s, { type: 'setLen', id: s.slices[0].id, min: 99999 })
    expect(s.slices[0].lenMin).toBe(180)
    s = m.reducer(s, { type: 'setLen', id: s.slices[0].id, min: -5 })
    expect(s.slices[0].lenMin).toBe(1)
  })
})

describe('年轮', () => {
  it('每小时一层，8 层一圈', () => {
    expect(rings(0)).toMatchObject({ lap: 0, full: 0, notches: 0 })
    expect(rings(3.5 * MS_HOUR)).toMatchObject({ lap: 0, full: 3 })
    expect(rings(3.5 * MS_HOUR).frac).toBeCloseTo(0.5)
    expect(rings(8 * MS_HOUR)).toMatchObject({ lap: 1, full: 0, notches: 1 })
    expect(rings(17 * MS_HOUR)).toMatchObject({ lap: 2, full: 1, notches: 2 })
  })

  it('24 小时封顶，再喂也不涨', () => {
    expect(rings(CAP_MS).maxed).toBe(true)
    expect(rings(CAP_MS * 3).maxed).toBe(true)
    expect(rings(CAP_MS * 3).full).toBe(8)
  })
})

describe('导入的存档', () => {
  const ok = {
    slices: [
      { id: 'a', name: '甲', totalMs: MS_HOUR, lenMin: 25 },
      { id: 'b', name: '乙', totalMs: 0, lenMin: 5 },
      { id: 'c', name: '丙', totalMs: 0, lenMin: 50 },
    ],
    defaultLenMin: 5,
    currentIndex: 1,
    roundsToday: 7,
  }

  it('正常存档原样进来，但一律落回 idle', () => {
    const s = m.parseSnapshot(JSON.stringify(ok))
    expect(s.slices.map((x) => x.lenMin)).toEqual([25, 5, 50])
    expect(s.slices[0].totalMs).toBe(MS_HOUR)
    // 不拿别处没跑完的那一轮接着计时
    expect(s.phase).toBe('idle')
    expect(s.roundStartedAt).toBeNull()
    expect(s.roundElapsedMs).toBe(0)
    expect(s.pinned).toBe(false)
  })

  it.each([
    ['不是对象', '"hi"'],
    ['烂 JSON', '{oops'],
    ['片太少', '{"slices":[{"name":"a","totalMs":0}]}'],
    [
      '片太多',
      JSON.stringify({ slices: Array.from({ length: 9 }, () => ({ name: 'x', totalMs: 0 })) }),
    ],
    ['没名字', '{"slices":[{"totalMs":0},{"name":"b","totalMs":0},{"name":"c","totalMs":0}]}'],
    ['负时长', '{"slices":[{"name":"a","totalMs":-5},{"name":"b","totalMs":0},{"name":"c","totalMs":0}]}'],
    [
      '时长是字符串',
      '{"slices":[{"name":"a","totalMs":"9"},{"name":"b","totalMs":0},{"name":"c","totalMs":0}]}',
    ],
  ])('拒绝 %s', (_label, text) => {
    expect(() => m.parseSnapshot(text)).toThrow()
  })

  it('越界的数值被夹住而不是照单全收', () => {
    const s = m.parseSnapshot(
      JSON.stringify({
        ...ok,
        slices: ok.slices.map((x) => ({ ...x, totalMs: 9e15, lenMin: 9999 })),
        currentIndex: 77,
      }),
    )
    expect(s.slices[0].totalMs).toBe(CAP_MS)
    expect(s.slices[0].lenMin).toBe(180)
    expect(s.currentIndex).toBe(2)
  })

  it('v0.1 的老存档：全局片长写进每一片，累计一点不丢', () => {
    const s = m.parseSnapshot(
      JSON.stringify({
        slices: [
          { id: 'a', name: '甲', totalMs: 6 * MS_HOUR },
          { id: 'b', name: '乙', totalMs: 2 * MS_HOUR },
          { id: 'c', name: '丙', totalMs: 0 },
        ],
        sliceLenMin: 25,
      }),
    )
    expect(s.defaultLenMin).toBe(25)
    expect(s.slices.map((x) => x.lenMin)).toEqual([25, 25, 25])
    expect(s.slices.map((x) => x.totalMs)).toEqual([6 * MS_HOUR, 2 * MS_HOUR, 0])
  })

  it('坏掉的暂停记录被丢掉，好的留下', () => {
    const s = m.parseSnapshot(
      JSON.stringify({
        ...ok,
        pauses: [
          { at: T0, endedAt: T0 + MS_MIN, reason: '会议', sliceName: '甲' },
          { at: 'nope' },
          { endedAt: 5 },
          null,
        ],
      }),
    )
    expect(s.pauses).toHaveLength(1)
    expect(s.pauses[0].reason).toBe('会议')
  })
})

describe('load 从存档恢复', () => {
  it('v0.1 老存档：全局片长写进每一片（这条走的是 load，跟导入是两条路）', () => {
    localStorage.setItem(
      'dial.v1',
      JSON.stringify({
        slices: [
          { id: 'a', name: '甲', totalMs: 6 * MS_HOUR },
          { id: 'b', name: '乙', totalMs: 0 },
          { id: 'c', name: '丙', totalMs: 0 },
        ],
        sliceLenMin: 25,
        currentIndex: 0,
        phase: 'idle',
      }),
    )
    const s = m.load()
    expect(s.defaultLenMin).toBe(25)
    expect(s.slices.map((x) => x.lenMin)).toEqual([25, 25, 25])
    expect(s.slices[0].totalMs).toBe(6 * MS_HOUR)
  })

  it('新存档里每片自己的片长不会被默认值顶掉', () => {
    const s = running()
    save({ ...s, slices: s.slices.map((sl, i) => ({ ...sl, lenMin: [5, 25, 50, 15][i] })) })
    expect(m.load().slices.map((x) => x.lenMin)).toEqual([5, 25, 50, 15])
  })

  it('跑飞太久的那一轮作废，不给补记', () => {
    save(running(5))
    env.set(at(60)) // 5 分钟的片，走了一小时才回来
    const s = m.load()
    expect(s.phase).toBe('idle')
    expect(s.roundStartedAt).toBeNull()
    expect(s.roundElapsedMs).toBe(0)
  })

  it('暂停不算跑飞 —— 那正是「先停着，回头再说」该有的样子', () => {
    let s = running(5)
    env.set(at(2))
    s = m.reducer(s, { type: 'pause' })
    save(s)

    env.set(at(3 * 24 * 60)) // 三天后打开
    const back = m.load()
    expect(back.phase).toBe('paused')
    expect(back.roundElapsedMs).toBe(2 * MS_MIN)
  })

  it('存档坏了就当没有，不该因为存档挂掉', () => {
    localStorage.setItem('dial.v1', '{broken')
    expect(m.load().slices).toHaveLength(4)
  })
})

describe('可替换的 env', () => {
  it('id 是从 env 拿的，测试里可以确定化', () => {
    expect(m.initialState().slices.map((s) => s.id)).toEqual(['id1', 'id2', 'id3', 'id4'])
  })

  it('时间也是从 env 拿的，不碰真实时钟', () => {
    expect(m.initialState().dayStartedAt).toBe(T0)
    env.advance(5 * MS_MIN)
    expect(m.reducer(m.initialState(), { type: 'start' }).roundStartedAt).toBe(at(5))
  })
})
