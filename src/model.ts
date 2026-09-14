import { systemEnv, type Env } from './env'

export const MS_MIN = 60_000
export const MS_HOUR = 3_600_000

/** 8 层年轮 = 8h 为一圈，3 圈 = 24h 满片 */
export const RINGS_PER_LAP = 8
export const MAX_LAPS = 3
export const CAP_MS = RINGS_PER_LAP * MAX_LAPS * MS_HOUR

/** 盘上每个位置一个色相。正好 MAX_VISIBLE 个，所以盘上永远不撞色 */
export const HUES = [174, 38, 268, 344, 142, 210, 20, 300]

/** 片长可选的几档，设置面板里那排 chip */
export const LEN_PRESETS = [5, 15, 25, 50]
export const MIN_LEN = 1
export const MAX_LEN = 180

export type Slice = {
  id: string
  name: string
  totalMs: number
  lenMin: number
  /** 暂时不参与轮转，也不画在盘上。累计时长照留 —— 是「藏起来」不是「删掉」 */
  hidden?: boolean
}

/** 至少得留两片可见，不然「轮转」就没有意义了 */
export const MIN_VISIBLE = 2
/** 盘上最多画这么多片。再多每片就窄到点不中，年轮也挤成一条缝 */
export const MAX_VISIBLE = 8
/** 少于三片就不像个盘了 */
export const MIN_SLICES = 3
/** 库存上限。设置里可以存这么多，但同时只有 MAX_VISIBLE 片能上盘 */
export const MAX_SLICES = 50
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
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setPauseReason'; reason: string }
  | { type: 'complete' }
  | { type: 'confirm' }
  | { type: 'skip' }
  | { type: 'togglePin' }
  | { type: 'setLen'; id: string; min: number }
  | { type: 'setDefaultLen'; min: number }
  | { type: 'toggleHidden'; id: string }
  | { type: 'jump'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'addSlice' }
  | { type: 'removeSlice'; id: string }
  | { type: 'finishDay' }
  | { type: 'replace'; state: State }

export const clampLen = (min: number) =>
  Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(min) || MIN_LEN))

function makeInitial(env: Env, makeSlice: (name: string, lenMin: number) => Slice): State {
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
    dayStartedAt: env.now(),
  }
}

// 角度只跟片数有关，跟片长无关 —— 片长是「一次给多少」，年轮是「总共给了多少」，
// 压到同一个几何量上，年轮就没法互相比了。
export const sliceAngle = (n: number) => 360 / n

/** 可见片在完整数组里的下标，顺序不变 */
export const visibleIndexes = (slices: Slice[]) =>
  slices.reduce<number[]>((acc, sl, i) => (sl.hidden ? acc : [...acc, i]), [])

/** 当前片在可见序列里排第几 —— 盘面几何全都按这个算，不是按完整数组 */
export const visiblePos = (s: State) =>
  Math.max(0, visibleIndexes(s.slices).indexOf(s.currentIndex))

export const visibleCount = (s: State) => Math.max(1, visibleIndexes(s.slices).length)

/**
 * 某片在盘上用什么颜色。按**盘上位置**取，不按原始下标 ——
 * 库存有 50 片而色相只有 8 个，按下标取的话选出来的 8 片可能全是
 * 同一个色相（下标 0/8/16/24…），盘就没法看了。
 *
 * 代价是切换隐藏时颜色会变。可以接受：颜色是盘面的位置区分符，
 * 任务身份靠编号，编号是稳定的。
 */
export function hueOf(s: State, index: number) {
  const pos = visibleIndexes(s.slices).indexOf(index)
  return HUES[(pos < 0 ? 0 : pos) % HUES.length]
}

/** 这一片能不能移出轮转；不能的话返回人话的原因。 */
export function hideBlocker(s: State, id: string): string | null {
  const sl = s.slices.find((x) => x.id === id)
  if (!sl) return `没有这一片：${id}`
  if (sl.hidden) return null // 本来就不在轮转里
  if (visibleIndexes(s.slices).length <= MIN_VISIBLE)
    return `轮转里只剩 ${MIN_VISIBLE} 片了，再藏就转不起来`
  return null
}

/**
 * 这一片能不能放回轮转；不能的话返回人话的原因。
 * 跟 removeBlocker 一样，一份规则给 reducer / 按钮 / API 三处用。
 */
export function unhideBlocker(s: State, id: string): string | null {
  const sl = s.slices.find((x) => x.id === id)
  if (!sl) return `没有这一片：${id}`
  if (!sl.hidden) return null // 本来就在轮转里
  if (visibleIndexes(s.slices).length >= MAX_VISIBLE)
    return `盘上已经有 ${MAX_VISIBLE} 片了，先藏掉一片再放这片回来`
  return null
}

/**
 * 这一片现在能不能删；不能的话返回人话的原因。
 *
 * 一份规则三个用处：reducer 拦、按钮置灰 + tooltip、API 返 422。
 * 之前散成三处，结果按钮没置灰（点了没反应）、API 少一条（返回 ok
 * 但状态没变）—— 同一条规则抄三遍就是这个下场。
 */
export function removeBlocker(s: State, id: string): string | null {
  const i = s.slices.findIndex((sl) => sl.id === id)
  if (i < 0) return `没有这一片：${id}`
  if (s.slices.length <= MIN_SLICES) return `只剩 ${s.slices.length} 片了，下限 ${MIN_SLICES}，删不掉`
  if (!s.slices[i].hidden && visibleIndexes(s.slices).length <= MIN_VISIBLE)
    return `轮转里只剩 ${MIN_VISIBLE} 片，删了就转不起来。先放回来几片，或者先把这片藏起来`
  return null
}

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

/**
 * 把盘面角度重新对齐到「当前片正对指针」。
 *
 * rotationDeg 是个累加器，单位是当时的 360/片数。片数一变，之前累加的角度
 * 就是按旧几何算的，指针会指到别的片上去。这里保留已经转过的整圈数
 * （不然会凭空转回去一大截），只把这一圈里的角度修正到新几何下的正确值。
 */
function normalizeRotation(rotationDeg: number, currentIndex: number, n: number) {
  const target = -sliceAngle(n) * currentIndex
  const laps = Math.round((rotationDeg - target) / 360)
  return target + laps * 360
}

/** 只在可见片之间转，隐藏的直接跳过 */
function advance(s: State, steps = 1): Pick<State, 'currentIndex' | 'rotationDeg'> {
  const vis = visibleIndexes(s.slices)
  if (vis.length === 0) return { currentIndex: s.currentIndex, rotationDeg: s.rotationDeg }
  const a = sliceAngle(vis.length)
  const pos = Math.max(0, vis.indexOf(s.currentIndex))
  return {
    currentIndex: vis[(pos + steps) % vis.length],
    rotationDeg: s.rotationDeg - a * steps,
  }
}

/** 片数或可见性变了之后，把角度和 currentIndex 一起对齐回可见序列 */
function realign(s: State, slices: Slice[], preferIndex: number): State {
  let vis = visibleIndexes(slices)
  // 修复：可见片不够就转不起来，超上限盘上画不下。用户操作走不到这里
  // （各 case 都先拦了），只有手改的存档 / 导入的文件会撞上。
  if (vis.length < Math.min(MIN_VISIBLE, slices.length)) {
    slices = slices.map((sl) => ({ ...sl, hidden: undefined }))
    vis = visibleIndexes(slices)
  }
  if (vis.length > MAX_VISIBLE) {
    // 留前 MAX_VISIBLE 片在盘上，其余收进库存
    const keep = new Set(vis.slice(0, MAX_VISIBLE))
    slices = slices.map((sl, i) => (keep.has(i) ? sl : { ...sl, hidden: true }))
    vis = visibleIndexes(slices)
  }
  const currentIndex = vis.includes(preferIndex)
    ? preferIndex
    : (vis.find((i) => i > preferIndex) ?? vis[0])
  return {
    ...s,
    slices,
    currentIndex,
    rotationDeg: normalizeRotation(
      s.rotationDeg,
      Math.max(0, vis.indexOf(currentIndex)),
      vis.length,
    ),
  }
}

/** 本轮到目前为止的真实投入：已累计 + 正在跑的这一段 */
export function elapsedMs(s: State, now: number) {
  const live = s.phase === 'running' && s.roundStartedAt ? now - s.roundStartedAt : 0
  return Math.max(0, s.roundElapsedMs + live)
}

/**
 * 时间和 id 从 env 拿，不从 action 里传 —— 换个 env 就能把整套逻辑
 * 放到假时钟上跑，调用方也不用每次记得塞时间戳。
 */
export function createModel(env: Env) {
  /** 给还开着的那条暂停记录收尾 */
  const closePause = (pauses: PauseRecord[]): PauseRecord[] => {
    const [open, ...rest] = pauses
    return open && open.endedAt === null ? [{ ...open, endedAt: env.now() }, ...rest] : pauses
  }

  const makeSlice = (name: string, lenMin: number): Slice => ({
    id: env.newId(),
    name,
    totalMs: 0,
    lenMin,
  })

  const initialState = (): State => makeInitial(env, makeSlice)

  function reducer(s: State, action: Action): State {
    switch (action.type) {
    case 'start':
      return {
        ...s,
        phase: 'running',
        roundStartedAt: env.now(),
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
        roundElapsedMs: elapsedMs(s, env.now()),
        pauses: [
          { at: env.now(), endedAt: null, sliceName: s.slices[s.currentIndex].name },
          ...s.pauses,
        ].slice(0, MAX_PAUSES),
      }
    }

    case 'resume': {
      if (s.phase !== 'paused') return s
      return { ...s, phase: 'running', roundStartedAt: env.now(), pauses: closePause(s.pauses) }
    }

    /**
     * 直接跳到某一片，不等当前这轮跑完。**当前这轮直接作废** ——
     * 不记时长、不算一轮，因为你根本没把它做完。
     *
     * 跳过去立刻开跑：1.5s 的可取消窗口已经是确认了，不该再要一次。
     * 顺手解锁：锁是锁在旧片上的，手动跳走就是要离开。
     */
    case 'jump': {
      const target = s.slices.findIndex((sl) => sl.id === action.id)
      if (target < 0 || s.slices[target].hidden || target === s.currentIndex) return s
      const vis = visibleIndexes(s.slices)
      const from = Math.max(0, vis.indexOf(s.currentIndex))
      const steps = (vis.indexOf(target) - from + vis.length) % vis.length
      return {
        ...s,
        currentIndex: target,
        // 只往一个方向转，跟正常轮转一致（累加器只减不加）
        rotationDeg: s.rotationDeg - sliceAngle(vis.length) * steps,
        phase: 'running',
        roundStartedAt: env.now(),
        roundElapsedMs: 0,
        justFinished: null,
        pinned: false,
        // 从暂停里跳走的话，那条暂停记录得收尾，不然永远挂着
        pauses: closePause(s.pauses),
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
        roundStartedAt: env.now(),
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

    // 临时把某片挪出轮转。累计不动，随时能放回来。
    case 'toggleHidden': {
      const target = s.slices.find((sl) => sl.id === action.id)
      if (!target) return s
      const hiding = !target.hidden
      if (hiding && visibleIndexes(s.slices).length <= MIN_VISIBLE) return s
      if (!hiding && unhideBlocker(s, action.id)) return s
      const slices = s.slices.map((sl) =>
        sl.id === action.id ? { ...sl, hidden: hiding || undefined } : sl,
      )
      return realign(s, slices, s.currentIndex)
    }

    case 'rename':
      return {
        ...s,
        slices: s.slices.map((sl) => (sl.id === action.id ? { ...sl, name: action.name } : sl)),
      }

    case 'addSlice': {
      if (s.slices.length >= MAX_SLICES) return s
      const fresh = makeSlice('新任务', s.defaultLenMin)
      // 盘上满了就先收进库存（建成隐藏的），而不是拒绝加 ——
      // 库存 50 片的意义就在这儿：想加随时加，上不上盘另说
      if (visibleIndexes(s.slices).length >= MAX_VISIBLE) fresh.hidden = true
      // 可见片数变了每格的角度就变了，不重新对齐指针会指到别的片上
      return realign(s, [...s.slices, fresh], s.currentIndex)
    }

    case 'removeSlice': {
      if (removeBlocker(s, action.id)) return s
      const gone = s.slices.findIndex((sl) => sl.id === action.id)
      const slices = s.slices.filter((sl) => sl.id !== action.id)
      // 删掉的在当前片前面的话，当前片的下标要往前挪一位
      const prefer = Math.min(
        s.currentIndex > gone ? s.currentIndex - 1 : s.currentIndex,
        slices.length - 1,
      )
      return realign(s, slices, prefer)
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
        dayStartedAt: env.now(),
        currentIndex: 0,
        rotationDeg: 0,
      }
    }
  }

  /** 从一段存档文本恢复。localStorage 和 Rust 管的 state.json 走同一条路。 */
  function restore(raw: string | null): State {
    try {
      if (!raw) return initialState()
      const parsed = JSON.parse(raw) as Partial<State> & LegacyFields
      let s = migrate({ ...initialState(), ...parsed } as State, parsed)
      // 老存档里可能存着按旧片数算的角度；也可能被手改成一片都不可见。
      // realign 两件事一起兜住。
      s = realign(s, s.slices, s.currentIndex)
      // 关掉 app 后再打开：跑过头太久就不算这一轮，免得白给自己发奖。
      // 暂停不算跑飞 —— 那正是「先停着，回头再说」该有的样子。
      if (s.phase === 'running' && s.roundStartedAt) {
        if (env.now() - s.roundStartedAt > roundMs(s) * 2) {
          return { ...s, phase: 'idle', roundStartedAt: null, roundElapsedMs: 0 }
        }
      }
      return s
    } catch {
      return initialState()
    }
  }

  function load(): State {
    return restore(localStorage.getItem(KEY))
  }

  /**
   * 解析导入的存档。外面来的东西一律不可信，逐字段验，坏的直接抛。
   * 一律落回 idle：别拿另一台机器上没跑完的那一轮接着计时。
   */
  function parseSnapshot(text: string): State {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) throw new Error('不是一个存档对象')
    const o = raw as Record<string, unknown>

    if (!Array.isArray(o.slices) || o.slices.length < MIN_SLICES || o.slices.length > MAX_SLICES)
      throw new Error(`slices 得是 ${MIN_SLICES}–${MAX_SLICES} 片`)

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
        id: typeof v.id === 'string' && v.id ? v.id : env.newId(),
        name: v.name.slice(0, 60),
        totalMs: Math.min(v.totalMs, CAP_MS),
        // 老存档的片没有自己的片长，回落到全局值
        lenMin: clampLen(num(v.lenMin, defaultLenMin)),
        hidden: v.hidden === true ? true : undefined,
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

    // 导入的存档可能藏得只剩一片（转不起来），也可能一片没藏（50 片全上盘，
    // 画不下）。两头都夹一下。
    let safe = slices
    if (visibleIndexes(safe).length < MIN_VISIBLE) {
      safe = safe.map((sl) => ({ ...sl, hidden: undefined }))
    }
    if (visibleIndexes(safe).length > MAX_VISIBLE) {
      const keep = new Set(visibleIndexes(safe).slice(0, MAX_VISIBLE))
      safe = safe.map((sl, i) => (keep.has(i) ? sl : { ...sl, hidden: true }))
    }
    const vis = visibleIndexes(safe)

    return {
      slices: safe,
      defaultLenMin,
      pauses,
      roundElapsedMs: 0,
      currentIndex: vis.includes(currentIndex) ? currentIndex : vis[0],
      rotationDeg:
        -sliceAngle(vis.length) *
        Math.max(0, vis.indexOf(vis.includes(currentIndex) ? currentIndex : vis[0])),
      pinned: false,
      phase: 'idle',
      roundStartedAt: null,
      justFinished: null,
      roundsToday: Math.max(0, Math.floor(num(o.roundsToday, 0))),
      dayStartedAt: num(o.dayStartedAt, env.now()),
    }
  }

  return { initialState, makeSlice, reducer, load, restore, save, parseSnapshot }
}

export type Model = ReturnType<typeof createModel>

/** app 用的那一份 */
export const model = createModel(systemEnv)

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

export function save(s: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 存不下就算了，不该因为存档挂掉计时 */
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
