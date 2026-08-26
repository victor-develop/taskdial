import { beforeEach, describe, expect, it } from 'vitest'
import { wedgeAngles } from './Dial'
import { testEnv, type TestEnv } from './env'
import {
  CAP_MS,
  MAX_PAUSES,
  MS_HOUR,
  MS_MIN,
  MIN_VISIBLE,
  createModel,
  elapsedMs,
  visibleIndexes,
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

/** 盘面转完之后，指针（正上方）底下实际是哪一片。几何只看可见片。 */
function pointerIndex(s: State) {
  const vis = visibleIndexes(s.slices)
  const A = sliceAngle(vis.length)
  let best = vis[0]
  let bestDelta = Infinity
  vis.forEach((i, pos) => {
    const a = (((pos * A + s.rotationDeg) % 360) + 360) % 360
    const delta = Math.min(a, 360 - a)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  })
  return { index: best, offBy: bestDelta }
}

const hide = (s: State, i: number) => m.reducer(s, { type: 'toggleHidden', id: s.slices[i].id })

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


describe('临时隐藏某些片', () => {
  it('隐藏的片不参与轮转 —— 只在剩下的之间来回转', () => {
    let s = running()
    s = hide(s, 2)
    s = hide(s, 3)
    expect(visibleIndexes(s.slices)).toEqual([0, 1])

    // 转一圈：0 → 1 → 0 → 1，永远不落到 2、3
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      s = m.reducer(s, { type: 'complete' })
      seen.push(s.currentIndex)
      s = m.reducer(s, { type: 'confirm' })
    }
    expect(seen).toEqual([1, 0, 1, 0, 1, 0])
  })

  it('隐藏之后指针仍然对准当前片（几何按可见片数重算）', () => {
    let s = running()
    s = hide(s, 1) // 4 片变 3 片可见，每格从 90° 变 120°
    const p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)

    for (let i = 0; i < 5; i++) {
      s = m.reducer(s, { type: 'complete' })
      s = m.reducer(s, { type: 'confirm' })
      const q = pointerIndex(s)
      expect(q.index).toBe(s.currentIndex)
      expect(q.offBy).toBeCloseTo(0)
    }
  })

  it('把当前片藏了，指针挪到下一个可见的', () => {
    let s = running()
    expect(s.currentIndex).toBe(0)
    s = hide(s, 0)
    expect(s.currentIndex).toBe(1)
    const p = pointerIndex(s)
    expect(p.index).toBe(1)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('藏起来只是不轮转，累计一点不动', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' })   // 片 0 记满一轮
    const before = s.slices[0].totalMs
    expect(before).toBeGreaterThan(0)
    s = hide(s, 0)
    expect(s.slices[0].totalMs).toBe(before)
    s = hide(s, 0) // 放回来
    expect(s.slices[0].hidden).toBeFalsy()
    expect(s.slices[0].totalMs).toBe(before)
  })

  it(`至少留 ${MIN_VISIBLE} 片可见，再藏就挡住`, () => {
    let s = running()
    s = hide(s, 3)
    s = hide(s, 2)
    expect(visibleIndexes(s.slices)).toHaveLength(2)
    const stuck = s
    s = hide(s, 1)
    expect(s).toBe(stuck) // 没变
  })

  it('放回来之后重新参与轮转', () => {
    let s = running()
    s = hide(s, 1)
    s = hide(s, 1) // 放回
    expect(visibleIndexes(s.slices)).toEqual([0, 1, 2, 3])
    s = m.reducer(s, { type: 'complete' })
    expect(s.currentIndex).toBe(1)
  })

  it('隐藏时加片/删片，指针也不能漂', () => {
    let s = running()
    s = hide(s, 2)
    s = m.reducer(s, { type: 'addSlice' })
    let p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)

    s = m.reducer(s, { type: 'removeSlice', id: s.slices[4].id })
    p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('删掉当前片前面的那片，当前片跟着往前挪，指针不漂', () => {
    let s = running()
    s = m.reducer(s, { type: 'complete' }) // currentIndex = 1
    s = m.reducer(s, { type: 'confirm' })
    const name = s.slices[s.currentIndex].name
    s = m.reducer(s, { type: 'removeSlice', id: s.slices[0].id })
    expect(s.slices[s.currentIndex].name).toBe(name) // 还是同一个任务
    const p = pointerIndex(s)
    expect(p.index).toBe(s.currentIndex)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('存档里藏得只剩一片，load 要放开 —— 否则转不起来', () => {
    const s = running()
    save({ ...s, slices: s.slices.map((sl, i) => (i === 0 ? sl : { ...sl, hidden: true })) })
    const back = m.load()
    expect(visibleIndexes(back.slices).length).toBeGreaterThanOrEqual(MIN_VISIBLE)
  })

  it('导入的存档同理', () => {
    const raw = JSON.stringify({
      slices: [
        { id: 'a', name: '甲', totalMs: 0, lenMin: 5 },
        { id: 'b', name: '乙', totalMs: 0, lenMin: 5, hidden: true },
        { id: 'c', name: '丙', totalMs: 0, lenMin: 5, hidden: true },
      ],
    })
    const s = m.parseSnapshot(raw)
    expect(visibleIndexes(s.slices).length).toBeGreaterThanOrEqual(MIN_VISIBLE)
  })

  it('只剩下限那么多可见片时，删不掉可见的那片', () => {
    let s = running()
    s = hide(s, 3)
    s = hide(s, 2)
    expect(visibleIndexes(s.slices)).toHaveLength(MIN_VISIBLE)
    const stuck = s
    // 删可见的 → 拦住（否则可见数会掉到 1，转不起来）
    expect(m.reducer(s, { type: 'removeSlice', id: s.slices[0].id })).toBe(stuck)
    // 删已经藏起来的那片 → 允许，可见数不受影响
    const after = m.reducer(s, { type: 'removeSlice', id: s.slices[3].id })
    expect(after.slices).toHaveLength(3)
    expect(visibleIndexes(after.slices)).toHaveLength(MIN_VISIBLE)
  })

  it('盘面几何：隐藏片不占角度，剩下的均分圆周', () => {
    let s = running()
    expect(wedgeAngles(s).map((w) => w.center)).toEqual([0, 90, 180, 270])

    s = hide(s, 1)
    const w = wedgeAngles(s)
    // 只画 3 片，每格 120°；片号仍是原始下标 0/2/3
    expect(w.map((x) => x.index)).toEqual([0, 2, 3])
    expect(w.map((x) => x.center)).toEqual([0, 120, 240])
    // 相邻扇区首尾相接，不重叠也不留缝
    expect(w[0].a1).toBeCloseTo(w[1].a0)
    expect(w[1].a1).toBeCloseTo(w[2].a0)
  })

  it('盘面上当前片正对指针', () => {
    let s = running()
    s = hide(s, 1)
    for (let i = 0; i < 5; i++) {
      const w = wedgeAngles(s).find((x) => x.index === s.currentIndex)!
      const onScreen = (((w.center + s.rotationDeg) % 360) + 360) % 360
      expect(Math.min(onScreen, 360 - onScreen)).toBeCloseTo(0)
      s = m.reducer(s, { type: 'complete' })
      s = m.reducer(s, { type: 'confirm' })
    }
  })

  it('导入时保留合法的隐藏状态', () => {
    const raw = JSON.stringify({
      slices: [
        { id: 'a', name: '甲', totalMs: 0, lenMin: 5 },
        { id: 'b', name: '乙', totalMs: 0, lenMin: 5 },
        { id: 'c', name: '丙', totalMs: 0, lenMin: 5, hidden: true },
      ],
    })
    const s = m.parseSnapshot(raw)
    expect(s.slices.map((x) => !!x.hidden)).toEqual([false, false, true])
  })
})


describe('点某片直接切过去', () => {
  const jump = (s: State, i: number) => m.reducer(s, { type: 'jump', id: s.slices[i].id })

  it('当前这轮直接作废：不记时长、不算一轮', () => {
    let s = running(25)
    env.set(at(20)) // 已经跑了 20 分钟
    expect(elapsedMs(s, at(20))).toBe(20 * MS_MIN)
    const roundsBefore = s.roundsToday

    s = jump(s, 2)
    expect(s.currentIndex).toBe(2)
    expect(s.slices[0].totalMs).toBe(0) // 那 20 分钟没了 —— 你没把它做完
    expect(s.roundsToday).toBe(roundsBefore)
    expect(s.roundElapsedMs).toBe(0)
  })

  it('暂停累计下来的投入也一并作废（不能只清「正在跑的那一段」）', () => {
    let s = running(25)
    env.set(at(10))
    s = m.reducer(s, { type: 'pause' })   // 10 分钟进了 roundElapsedMs
    env.set(at(30))
    s = m.reducer(s, { type: 'resume' })
    env.set(at(35))                        // 累计 15 分钟，其中 10 分钟在 roundElapsedMs 里
    expect(s.roundElapsedMs).toBe(10 * MS_MIN)
    expect(elapsedMs(s, at(35))).toBe(15 * MS_MIN)

    s = jump(s, 2)
    expect(s.roundElapsedMs).toBe(0)
    expect(elapsedMs(s, at(35))).toBe(0) // 新一轮真的从零开始
  })

  it('切过去立刻开跑，不用再确认一次', () => {
    let s = running()
    env.set(at(5))
    s = jump(s, 1)
    expect(s.phase).toBe('running')
    expect(s.roundStartedAt).toBe(at(5))
    expect(elapsedMs(s, at(5))).toBe(0) // 新一轮从零开始
    expect(s.justFinished).toBeNull()
  })

  it('切过去之后指针对准目标片', () => {
    let s = running()
    for (const target of [2, 1, 3, 0]) {
      s = jump(s, target)
      const p = pointerIndex(s)
      expect(p.index).toBe(target)
      expect(p.offBy).toBeCloseTo(0)
    }
  })

  it('转角只减不加 —— 往回跳也是顺着转过去', () => {
    let s = running()
    s = jump(s, 3)
    const afterFar = s.rotationDeg
    s = jump(s, 1) // 往回跳
    expect(s.rotationDeg).toBeLessThan(afterFar)
    const p = pointerIndex(s)
    expect(p.index).toBe(1)
    expect(p.offBy).toBeCloseTo(0)
  })

  it('隐藏的片跳不过去', () => {
    let s = running()
    s = hide(s, 2)
    const before = s
    expect(jump(s, 2)).toBe(before)
  })

  it('跳到自己身上不响应 —— 误触不该把进度清掉', () => {
    let s = running()
    env.set(at(10))
    const before = s
    expect(jump(s, s.currentIndex)).toBe(before)
  })

  it('解除锁片：锁是锁在旧片上的', () => {
    let s = running()
    s = m.reducer(s, { type: 'togglePin' })
    expect(s.pinned).toBe(true)
    s = jump(s, 2)
    expect(s.pinned).toBe(false)
    // 之后恢复正常轮转
    s = m.reducer(s, { type: 'complete' })
    expect(s.currentIndex).toBe(3)
  })

  it('从暂停里跳走，那条暂停记录要收尾', () => {
    let s = running()
    env.set(at(5))
    s = m.reducer(s, { type: 'pause' })
    expect(s.pauses[0].endedAt).toBeNull()

    env.set(at(9))
    s = jump(s, 1)
    expect(s.phase).toBe('running')
    expect(s.pauses[0].endedAt).toBe(at(9)) // 不能永远挂着
    expect(s.pauses).toHaveLength(1)
  })

  it('隐藏之后跳转仍然按可见序列走', () => {
    let s = running()
    s = hide(s, 1) // 可见 0,2,3
    s = jump(s, 3)
    expect(s.currentIndex).toBe(3)
    const p = pointerIndex(s)
    expect(p.index).toBe(3)
    expect(p.offBy).toBeCloseTo(0)
    // 继续轮转不会落到被藏的 1 上
    s = m.reducer(s, { type: 'complete' })
    expect(s.currentIndex).toBe(0)
  })

  it('不存在的 id 不动状态', () => {
    const s = running()
    expect(m.reducer(s, { type: 'jump', id: 'nope' })).toBe(s)
  })
})
