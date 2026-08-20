export const MS_MIN = 60_000
export const MS_HOUR = 3_600_000

/** 8 层年轮 = 8h 为一圈，3 圈 = 24h 满片 */
export const RINGS_PER_LAP = 8
export const MAX_LAPS = 3
export const CAP_MS = RINGS_PER_LAP * MAX_LAPS * MS_HOUR

/** 每片一个色相 */
export const HUES = [174, 38, 268, 344, 142, 210, 20, 300]

/** 片长可选的几档，设置面板里那排 chip */
export const LEN_PRESETS = [5, 15, 25, 50]
export const MIN_LEN = 1
export const MAX_LEN = 180

export type Slice = { id: string; name: string; totalMs: number; lenMin: number }
export type Phase = 'idle' | 'running' | 'paused' | 'awaiting'

/** 一次暂停。endedAt 为 null 表示还停着 */
export type PauseRecord = {
  at: number
  endedAt: number | null
  reason?: string
  sliceName: string
}

/** 点一下就走的常见原因，省得每次打字 */
export const PAUSE_REASONS = ['会议', '打断', '休息', '卡住']

/** 暂停日志最多留这么多条，别让存档无限长 */
export const MAX_PAUSES = 200

export type State = {
  slices: Slice[]
  /** 只用来给新片赋初值，不做继承 —— 每片都有自己的显式片长 */
  defaultLenMin: number
  currentIndex: number
  /** 累加的盘面角度，只减不加，保证转向永远一致 */
  rotationDeg: number
  pinned: boolean
  phase: Phase
  /** 当前这一段跑起来的时刻；暂停时为 null */
  roundStartedAt: number | null
  /** 本轮已经累计的投入，跨暂停累加 —— 暂停冻结的是它，不是丢掉 */
  roundElapsedMs: number
  /** 刚跑完的那一片，等确认时用 */
  justFinished: number | null
  pauses: PauseRecord[]
  roundsToday: number
  dayStartedAt: number
}

export type Action =
  | { type: 'start' }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  | { type: 'setPauseReason'; reason: string }
  | { type: 'complete'; at: number }
  | { type: 'confirm'; at: number }
  | { type: 'skip' }
  | { type: 'togglePin' }
  | { type: 'setLen'; id: string; min: number }
  | { type: 'setDefaultLen'; min: number }
  | { type: 'rename'; id: string; name: string }
  | { type: 'addSlice' }
  | { type: 'removeSlice'; id: string }
  | { type: 'finishDay'; at: number }
  | { type: 'replace'; state: State }

const newId = () => Math.random().toString(36).slice(2, 9)
export const makeSlice = (name: string, lenMin: number): Slice => ({
  id: newId(),
  name,
  totalMs: 0,
  lenMin,
})

export const clampLen = (min: number) =>
  Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(min) || MIN_LEN))

export function initialState(now: number): State {
  return {
    slices: [
      makeSlice('写 PRD', 5),
      makeSlice('回 review', 15),
      makeSlice('主线开发', 25),
      makeSlice('杂事', 5),
    ],
    defaultLenMin: 5,
    currentIndex: 0,
    rotationDeg: 0,
    pinned: false,
    phase: 'idle',
    roundStartedAt: null,
    roundElapsedMs: 0,
    justFinished: null,
    pauses: [],
    roundsToday: 0,
    dayStartedAt: now,
  }
}

// 角度只跟片数有关，跟片长无关 —— 片长是「一次给多少」，年轮是「总共给了多少」，
// 压到同一个几何量上，年轮就没法互相比了。
export const sliceAngle = (n: number) => 360 / n

export const lenMsOf = (slice: Slice) => slice.lenMin * MS_MIN
export const roundMs = (s: State) => lenMsOf(s.slices[s.currentIndex])

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

/** 本轮到目前为止的真实投入：已累计 + 正在跑的这一段 */
export function elapsedMs(s: State, now: number) {
  const live = s.phase === 'running' && s.roundStartedAt ? now - s.roundStartedAt : 0
  return Math.max(0, s.roundElapsedMs + live)
}

export function reducer(s: State, action: Action): State {
  switch (action.type) {
    case 'start':
      return {
        ...s,
        phase: 'running',
        roundStartedAt: Date.now(),
        roundElapsedMs: 0,
        justFinished: null,
      }

    // 先停表再问原因 —— 紧急暂停要是得先打字才生效，那就不叫紧急
    case 'pause': {
      if (s.phase !== 'running') return s
      return {
        ...s,
        phase: 'paused',
        roundStartedAt: null,
        roundElapsedMs: elapsedMs(s, action.at),
        pauses: [
          { at: action.at, endedAt: null, sliceName: s.slices[s.currentIndex].name },
          ...s.pauses,
        ].slice(0, MAX_PAUSES),
      }
    }

    case 'resume': {
      if (s.phase !== 'paused') return s
      const [open, ...rest] = s.pauses
      return {
        ...s,
        phase: 'running',
        roundStartedAt: action.at,
        pauses: open && open.endedAt === null ? [{ ...open, endedAt: action.at }, ...rest] : s.pauses,
      }
    }

    case 'setPauseReason': {
      const [latest, ...rest] = s.pauses
      if (!latest) return s
      const reason = action.reason.trim().slice(0, 40)
      return { ...s, pauses: [{ ...latest, reason: reason || undefined }, ...rest] }
    }

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
        roundElapsedMs: 0,
      }
    }

    case 'confirm':
      return {
        ...s,
        phase: 'running',
        roundStartedAt: action.at,
        roundElapsedMs: 0,
        justFinished: null,
      }

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

    case 'setLen':
      return {
        ...s,
        slices: s.slices.map((sl) =>
          sl.id === action.id ? { ...sl, lenMin: clampLen(action.min) } : sl,
        ),
      }

    case 'setDefaultLen':
      return { ...s, defaultLenMin: clampLen(action.min) }

    case 'rename':
      return {
        ...s,
        slices: s.slices.map((sl) => (sl.id === action.id ? { ...sl, name: action.name } : sl)),
      }

    case 'addSlice':
      if (s.slices.length >= 8) return s
      return { ...s, slices: [...s.slices, makeSlice('新任务', s.defaultLenMin)] }

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
        roundElapsedMs: 0,
        justFinished: null,
        roundsToday: 0,
        dayStartedAt: action.at,
        currentIndex: 0,
        rotationDeg: 0,
      }
  }
}

type LegacyFields = { defaultLenMin?: number; sliceLenMin?: number }

/**
 * v0.1 的存档只有一个全局 sliceLenMin。把它写进每一片当初值，
 * 行为跟升级前完全一致，不丢东西。
 *
 * 判断依据必须是**原始解析结果**，不能是跟 initialState 合并之后的对象 ——
 * 合并之后 defaultLenMin 总是存在（默认 5），?? 永远短路不到老字段上，
 * 老用户的 25min 片长会被悄悄改成 5min。
 */
function migrate(merged: State, raw: LegacyFields): State {
  const fallback = clampLen(raw.defaultLenMin ?? raw.sliceLenMin ?? merged.defaultLenMin)
  return {
    ...merged,
    defaultLenMin: fallback,
    slices: merged.slices.map((sl) => ({
      ...sl,
      lenMin: typeof sl.lenMin === 'number' ? clampLen(sl.lenMin) : fallback,
    })),
  }
}

const KEY = 'dial.v1'

export function load(now: number): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return initialState(now)
    const parsed = JSON.parse(raw) as Partial<State> & LegacyFields
    const s = migrate({ ...initialState(now), ...parsed } as State, parsed)
    // 关掉 app 后再打开：跑过头太久就不算这一轮，免得白给自己发奖
    // 暂停不算跑飞 —— 那正是「先停着，回头再说」该有的样子
    if (s.phase === 'running' && s.roundStartedAt) {
      const over = now - s.roundStartedAt
      if (over > roundMs(s) * 2) {
        return { ...s, phase: 'idle', roundStartedAt: null, roundElapsedMs: 0 }
      }
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

  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback

  // v0.1 的存档没有 defaultLenMin，只有一个全局 sliceLenMin
  const defaultLenMin = clampLen(num(o.defaultLenMin, num(o.sliceLenMin, 5)))

  const slices: Slice[] = o.slices.map((s: unknown, i: number) => {
    const v = s as Record<string, unknown>
    if (typeof v?.name !== 'string') throw new Error(`第 ${i + 1} 片没有名字`)
    if (typeof v?.totalMs !== 'number' || !Number.isFinite(v.totalMs) || v.totalMs < 0)
      throw new Error(`第 ${i + 1} 片的 totalMs 不对`)
    return {
      id: typeof v.id === 'string' && v.id ? v.id : newId(),
      name: v.name.slice(0, 60),
      totalMs: Math.min(v.totalMs, CAP_MS),
      // 老存档的片没有自己的片长，回落到全局值
      lenMin: clampLen(num(v.lenMin, defaultLenMin)),
    }
  })
  const currentIndex = Math.max(0, Math.min(slices.length - 1, Math.floor(num(o.currentIndex, 0))))

  const pauses: PauseRecord[] = (Array.isArray(o.pauses) ? o.pauses : [])
    .filter((p: unknown) => {
      const v = p as Record<string, unknown>
      return v && typeof v.at === 'number' && Number.isFinite(v.at)
    })
    .slice(0, MAX_PAUSES)
    .map((p: unknown) => {
      const v = p as Record<string, unknown>
      return {
        at: v.at as number,
        endedAt: typeof v.endedAt === 'number' && Number.isFinite(v.endedAt) ? v.endedAt : null,
        reason: typeof v.reason === 'string' ? v.reason.slice(0, 40) : undefined,
        sliceName: typeof v.sliceName === 'string' ? v.sliceName.slice(0, 60) : '',
      }
    })

  return {
    slices,
    defaultLenMin,
    pauses,
    roundElapsedMs: 0,
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
