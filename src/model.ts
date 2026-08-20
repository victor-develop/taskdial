export const MS_MIN = 60_000
export const MS_HOUR = 3_600_000

/** 8 层年轮 = 8h 为一圈，3 圈 = 24h 满片 */
export const RINGS_PER_LAP = 8
export const MAX_LAPS = 3
export const CAP_MS = RINGS_PER_LAP * MAX_LAPS * MS_HOUR

/** 每片一个色相 */
export const HUES = [174, 38, 268, 344, 142, 210, 20, 300]

export type Slice = { id: string; name: string; totalMs: number }
export type Phase = 'idle' | 'running' | 'awaiting'

export type State = {
  slices: Slice[]
  sliceLenMin: number
  currentIndex: number
  /** 累加的盘面角度，只减不加，保证转向永远一致 */
  rotationDeg: number
  pinned: boolean
  phase: Phase
  roundStartedAt: number | null
  /** 刚跑完的那一片，等确认时用 */
  justFinished: number | null
  roundsToday: number
  dayStartedAt: number
}

export type Action =
  | { type: 'start' }
  | { type: 'complete'; at: number }
  | { type: 'confirm'; at: number }
  | { type: 'skip' }
  | { type: 'togglePin' }
  | { type: 'setSliceLen'; min: number }
  | { type: 'rename'; id: string; name: string }
  | { type: 'addSlice' }
  | { type: 'removeSlice'; id: string }
  | { type: 'finishDay'; at: number }
  | { type: 'replace'; state: State }

const newId = () => Math.random().toString(36).slice(2, 9)
export const makeSlice = (name: string): Slice => ({ id: newId(), name, totalMs: 0 })

export function initialState(now: number): State {
  return {
    slices: [
      makeSlice('写 PRD'),
      makeSlice('回 review'),
      makeSlice('主线开发'),
      makeSlice('杂事'),
    ],
    sliceLenMin: 5,
    currentIndex: 0,
    rotationDeg: 0,
    pinned: false,
    phase: 'idle',
    roundStartedAt: null,
    justFinished: null,
    roundsToday: 0,
    dayStartedAt: now,
  }
}

export const sliceAngle = (n: number) => 360 / n
export const roundMs = (s: State) => s.sliceLenMin * MS_MIN

/** 年轮状态：当前在第几圈、长了几层、当前层长了多少 */
export function rings(totalMs: number) {
  const capped = Math.min(totalMs, CAP_MS)
  const hours = capped / MS_HOUR
  const lap = Math.min(Math.floor(hours / RINGS_PER_LAP), MAX_LAPS - 1)
  const inLap = hours - lap * RINGS_PER_LAP
  return {
    hours: totalMs / MS_HOUR,
    lap,
    full: Math.floor(inLap),
    frac: inLap - Math.floor(inLap),
    notches: Math.floor(hours / RINGS_PER_LAP),
    maxed: capped >= CAP_MS,
  }
}

function advance(s: State, steps = 1): Pick<State, 'currentIndex' | 'rotationDeg'> {
  const a = sliceAngle(s.slices.length)
  return {
    currentIndex: (s.currentIndex + steps) % s.slices.length,
    rotationDeg: s.rotationDeg - a * steps,
  }
}

export function reducer(s: State, action: Action): State {
  switch (action.type) {
    case 'start':
      return { ...s, phase: 'running', roundStartedAt: Date.now(), justFinished: null }

    case 'complete': {
      const finished = s.currentIndex
      const slices = s.slices.map((sl, i) =>
        i === finished ? { ...sl, totalMs: sl.totalMs + roundMs(s) } : sl,
      )
      const moved = s.pinned ? {} : advance(s)
      return {
        ...s,
        ...moved,
        slices,
        roundsToday: s.roundsToday + 1,
        justFinished: finished,
        phase: 'awaiting',
        roundStartedAt: null,
      }
    }

    case 'confirm':
      return { ...s, phase: 'running', roundStartedAt: action.at, justFinished: null }

    // 等确认时再往前跳一片，被跳过的那片不计时间
    case 'skip':
      return s.phase === 'awaiting' && !s.pinned ? { ...s, ...advance(s) } : s

    // 锁片：把指针退回刚跑完的那片，盘不再转
    case 'togglePin': {
      if (s.pinned) {
        const back = s.phase === 'awaiting' ? advance(s) : {}
        return { ...s, ...back, pinned: false }
      }
      const a = sliceAngle(s.slices.length)
      const back =
        s.phase === 'awaiting' && s.justFinished !== null
          ? { currentIndex: s.justFinished, rotationDeg: s.rotationDeg + a }
          : {}
      return { ...s, ...back, pinned: true }
    }

    case 'setSliceLen':
      return { ...s, sliceLenMin: Math.max(1, Math.min(120, action.min)) }

    case 'rename':
      return {
        ...s,
        slices: s.slices.map((sl) => (sl.id === action.id ? { ...sl, name: action.name } : sl)),
      }

    case 'addSlice':
      if (s.slices.length >= 8) return s
      return { ...s, slices: [...s.slices, makeSlice('新任务')] }

    case 'removeSlice': {
      if (s.slices.length <= 3) return s
      const slices = s.slices.filter((sl) => sl.id !== action.id)
      const currentIndex = Math.min(s.currentIndex, slices.length - 1)
      return { ...s, slices, currentIndex, rotationDeg: -sliceAngle(slices.length) * currentIndex }
    }

    case 'replace':
      return action.state

    case 'finishDay':
      return {
        ...s,
        slices: s.slices.map((sl) => ({ ...sl, totalMs: 0 })),
        phase: 'idle',
        pinned: false,
        roundStartedAt: null,
        justFinished: null,
        roundsToday: 0,
        dayStartedAt: action.at,
        currentIndex: 0,
        rotationDeg: 0,
      }
  }
}

const KEY = 'dial.v1'

export function load(now: number): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return initialState(now)
    const s = { ...initialState(now), ...(JSON.parse(raw) as State) }
    // 关掉 app 后再打开：跑过头太久就不算这一轮，免得白给自己发奖
    if (s.phase === 'running' && s.roundStartedAt) {
      const over = now - s.roundStartedAt
      if (over > roundMs(s) * 2) return { ...s, phase: 'idle', roundStartedAt: null }
    }
    return s
  } catch {
    return initialState(now)
  }
}

export function save(s: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 存不下就算了，不该因为存档挂掉计时 */
  }
}

/**
 * 解析导入的存档。外面来的东西一律不可信，逐字段验，坏的直接抛。
 * 一律落回 idle：别拿另一台机器上没跑完的那一轮接着计时。
 */
export function parseSnapshot(text: string, now: number): State {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null) throw new Error('不是一个存档对象')
  const o = raw as Record<string, unknown>

  if (!Array.isArray(o.slices) || o.slices.length < 3 || o.slices.length > 8)
    throw new Error('slices 得是 3–8 片')

  const slices: Slice[] = o.slices.map((s: unknown, i: number) => {
    const v = s as Record<string, unknown>
    if (typeof v?.name !== 'string') throw new Error(`第 ${i + 1} 片没有名字`)
    if (typeof v?.totalMs !== 'number' || !Number.isFinite(v.totalMs) || v.totalMs < 0)
      throw new Error(`第 ${i + 1} 片的 totalMs 不对`)
    return {
      id: typeof v.id === 'string' && v.id ? v.id : newId(),
      name: v.name.slice(0, 60),
      totalMs: Math.min(v.totalMs, CAP_MS),
    }
  })

  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback

  const sliceLenMin = Math.max(1, Math.min(120, num(o.sliceLenMin, 5)))
  const currentIndex = Math.max(0, Math.min(slices.length - 1, Math.floor(num(o.currentIndex, 0))))

  return {
    slices,
    sliceLenMin,
    currentIndex,
    rotationDeg: -sliceAngle(slices.length) * currentIndex,
    pinned: false,
    phase: 'idle',
    roundStartedAt: null,
    justFinished: null,
    roundsToday: Math.max(0, Math.floor(num(o.roundsToday, 0))),
    dayStartedAt: num(o.dayStartedAt, now),
  }
}

export function fmtClock(ms: number) {
  const t = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export function fmtDur(ms: number) {
  const m = Math.round(ms / MS_MIN)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
}
