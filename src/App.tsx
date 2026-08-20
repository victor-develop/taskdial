import { useEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import { autoSizeWindow } from './autosize'
import Dial from './Dial'
import Runner from './Runner'
import { openPip, pipSupported } from './pip'
import {
  HUES,
  LEN_PRESETS,
  MAX_LEN,
  MIN_LEN,
  MS_HOUR,
  MS_MIN,
  fmtClock,
  fmtDur,
  load,
  parseSnapshot,
  reducer,
  rings,
  roundMs,
  save,
  type State,
} from './model'

const TICKS = 12 // 一层年轮 = 1 小时 = 12 个 5 分钟刻度

function tone(notes: number[]) {
  try {
    const ctx = new AudioContext()
    notes.forEach((freq, i) => {
      const at = ctx.currentTime + i * 0.16
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55)
      osc.start(at)
      osc.stop(at + 0.6)
    })
    setTimeout(() => ctx.close(), 400 + notes.length * 200)
  } catch {
    /* 没声音不影响用 */
  }
}

const dingRoundOver = () => tone([620])
const dingRingClosed = () => tone([620, 830, 1040])

/** 存档跟着 origin 走，换域名/换端口就换了个桶 —— 所以要能搬 */
function exportSnapshot(state: State) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `dial-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, 0, () => load(Date.now()))
  const [now, setNow] = useState(() => Date.now())
  const [sheet, setSheet] = useState<'none' | 'settings' | 'summary'>('none')
  const [pipWin, setPipWin] = useState<Window | null>(null)
  const [ioMsg, setIoMsg] = useState<string | null>(null)
  const [openLen, setOpenLen] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => save(state), [state])

  // 窗口高度跟着内容走，见 autosize.ts
  useEffect(() => (cardRef.current ? autoSizeWindow(cardRef.current) : undefined), [])

  // 计时只在跑的时候走；时间一律拿 Date.now() 现算，后台降频也不会走慢
  useEffect(() => {
    if (state.phase !== 'running') return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.phase])

  const total = roundMs(state)
  const remaining =
    state.phase === 'running' && state.roundStartedAt
      ? state.roundStartedAt + total - now
      : total

  useEffect(() => {
    if (state.phase === 'running' && remaining <= 0) {
      dingRoundOver()
      dispatch({ type: 'complete', at: Date.now() })
    }
  }, [state.phase, remaining])

  // 正在跑的这一轮实时算进当前片，年轮是连着长的；确认那一刻不会跳
  const liveMs =
    state.phase === 'running' && state.roundStartedAt
      ? Math.max(0, Math.min(now - state.roundStartedAt, total))
      : 0
  const totals = state.slices.map((s, i) => s.totalMs + (i === state.currentIndex ? liveMs : 0))

  // 长满一整层年轮的那一下，给个不一样的声音
  const ringMark = useRef({ id: state.slices[state.currentIndex].id, h: -1 })
  useEffect(() => {
    const id = state.slices[state.currentIndex].id
    const h = Math.floor(totals[state.currentIndex] / MS_HOUR)
    if (ringMark.current.id === id && h > ringMark.current.h && ringMark.current.h >= 0) {
      dingRingClosed()
    }
    ringMark.current = { id, h }
  })

  // 回车 = 确认/开始。搬进 PiP 之后按键落在那个窗口里，所以两边都挂
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || sheet !== 'none') return
      if (state.phase === 'idle') dispatch({ type: 'start' })
      if (state.phase === 'awaiting') dispatch({ type: 'confirm', at: Date.now() })
    }
    const docs = [document, pipWin?.document].filter(Boolean) as Document[]
    docs.forEach((d) => d.addEventListener('keydown', onKey))
    return () => docs.forEach((d) => d.removeEventListener('keydown', onKey))
  }, [state.phase, sheet, pipWin])

  const current = state.slices[state.currentIndex]
  const finished = state.justFinished !== null ? state.slices[state.justFinished] : null
  const shownIndex = state.justFinished ?? state.currentIndex
  const shown = finished ?? current
  const shownMs = totals[shownIndex]
  const r = rings(shownMs)
  const minInHour = (shownMs % MS_HOUR) / MS_MIN
  const roundsToRing = Math.max(1, Math.ceil((60 - minInHour) / shown.lenMin))
  const todayMs = totals.reduce((a, ms) => a + ms, 0)

  const hub =
    state.phase === 'running'
      ? { main: fmtClock(remaining) }
      : state.phase === 'awaiting'
        ? { main: '⏎', sub: '确认' }
        : { main: '开始' }

  async function importSnapshot(file: File) {
    try {
      const next = parseSnapshot(await file.text(), Date.now())
      dispatch({ type: 'replace', state: next })
      setIoMsg(`已导入 ${next.slices.length} 片`)
    } catch (e) {
      setIoMsg(`导入失败：${e instanceof Error ? e.message : '文件读不了'}`)
    }
  }

  async function toPip() {
    const win = await openPip(240, 397)
    setPipWin(win)
    win.addEventListener('pagehide', () => setPipWin(null))
  }

  return (
      <div className="card" ref={cardRef}>
        {/* 无边框窗口靠这块拖动；在浏览器里这个属性没有副作用 */}
        <header data-tauri-drag-region>
          <span className="today" data-tauri-drag-region>
            今日 {fmtDur(todayMs)} · {state.roundsToday} 轮
          </span>
          <span className="tools">
            {pipSupported() && !pipWin && (
              <button className="icon" onClick={toPip} title="浮到桌面">
                ⧉
              </button>
            )}
            <button className="icon" onClick={() => setSheet('settings')} title="设置">
              ⚙
            </button>
          </span>
        </header>

        <h1
          data-tauri-drag-region
          className={state.pinned ? 'title pinned' : 'title'}
          style={{ '--hue': HUES[shownIndex % HUES.length] } as CSSProperties}
          title={shown.name}
        >
          <span className="badge">{shownIndex + 1}</span>
          <span className="task">{shown.name}</span>
          {state.pinned && <span className="lock">🔒</span>}
          {/* 不带加号：右边那个累计已经把这一轮算进去了，写「+5m」会读成还要再加一次 */}
          {state.phase === 'awaiting' && <span className="plus">{shown.lenMin}m</span>}
          <span className="dur">{fmtDur(shownMs)}</span>
        </h1>

        <Dial
          state={state}
          totals={totals}
          hub={hub}
          onDoubleClick={() => dispatch({ type: 'togglePin' })}
        />

        <Runner progress={liveMs / total} phase={state.phase} />

        <footer>
          <div className="row">
            <span className="ticks">
              {Array.from({ length: TICKS }, (_, i) => (
                <i key={i} className={i < Math.floor(minInHour / 5) ? 'on' : ''} />
              ))}
            </span>
            <span className="hint">
              {shown.lenMin}m · {r.maxed ? '满片' : `再 ${roundsToRing} 轮成环`}
            </span>
          </div>
        </footer>

        {state.phase === 'idle' && sheet === 'none' && (
          <div className="sheet">
            <p className="sheet-title">
              <span className="ellip">从 {state.currentIndex + 1} · {current.name} 开始</span>
              <span className="len-chip">⏱ {current.lenMin}m</span>
            </p>
            <div className="btns">
              <button className="primary" onClick={() => dispatch({ type: 'start' })}>
                开始 ⏎
              </button>
            </div>
          </div>
        )}

        {state.phase === 'awaiting' && sheet === 'none' && (
          <div className="sheet">
            <p className="sheet-title">
              <span className="ellip">
                {state.pinned
                  ? '锁定中 · 连续投喂本片'
                  : `→ ${state.currentIndex + 1} · ${current.name}`}
              </span>
              <span className="len-chip">⏱ {current.lenMin}m</span>
            </p>
            <div className="btns">
              <button className="primary" onClick={() => dispatch({ type: 'confirm', at: Date.now() })}>
                开始 ⏎
              </button>
              <button onClick={() => dispatch({ type: 'skip' })} disabled={state.pinned}>
                跳过
              </button>
              <button className={state.pinned ? 'on' : ''} onClick={() => dispatch({ type: 'togglePin' })}>
                🔒
              </button>
            </div>
          </div>
        )}

        {sheet === 'settings' && (
          <div className="panel">
            <div className="panel-head">
              <span>轮盘</span>
              <button className="icon" onClick={() => setSheet('none')}>
                ✕
              </button>
            </div>
            <label className="len">
              新片默认
              <input
                type="number"
                min={MIN_LEN}
                max={MAX_LEN}
                value={state.defaultLenMin}
                onChange={(e) => dispatch({ type: 'setDefaultLen', min: Number(e.target.value) })}
              />
              min
            </label>
            <ul className="slices">
              {state.slices.map((s, i) => (
                <li key={s.id} className={openLen === s.id ? 'open' : undefined}>
                  <div className="slice-row">
                    <span className="idx">{i + 1}</span>
                    <input
                      value={s.name}
                      onChange={(e) => dispatch({ type: 'rename', id: s.id, name: e.target.value })}
                    />
                    <button
                      className="len-chip tap"
                      onClick={() => setOpenLen(openLen === s.id ? null : s.id)}
                      title="改这一片的片长"
                    >
                      {s.lenMin}m
                    </button>
                    <button
                      className="icon"
                      disabled={state.slices.length <= 3}
                      onClick={() => dispatch({ type: 'removeSlice', id: s.id })}
                    >
                      ✕
                    </button>
                  </div>
                  {openLen === s.id && (
                    <div className="len-presets">
                      {LEN_PRESETS.map((min) => (
                        <button
                          key={min}
                          className={s.lenMin === min ? 'on' : undefined}
                          onClick={() => dispatch({ type: 'setLen', id: s.id, min })}
                        >
                          {min}
                        </button>
                      ))}
                      <input
                        type="number"
                        min={MIN_LEN}
                        max={MAX_LEN}
                        value={s.lenMin}
                        aria-label="自定义片长"
                        onChange={(e) => dispatch({ type: 'setLen', id: s.id, min: Number(e.target.value) })}
                      />
                      <span className="dur">{fmtDur(s.totalMs)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {ioMsg && <p className="io-msg">{ioMsg}</p>}
            <div className="panel-foot">
              <button onClick={() => dispatch({ type: 'addSlice' })} disabled={state.slices.length >= 8}>
                + 加一片
              </button>
              <button onClick={() => exportSnapshot(state)}>导出</button>
              <button onClick={() => fileRef.current?.click()}>导入</button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void importSnapshot(f)
                }}
              />
            </div>
            <div className="panel-foot">
              <button onClick={() => setSheet('summary')}>收工</button>
            </div>
          </div>
        )}

        {sheet === 'summary' && <Summary state={state} onBack={() => setSheet('settings')} onFinish={() => { dispatch({ type: 'finishDay', at: Date.now() }); setSheet('none') }} />}
    </div>
  )
}

function Summary({ state, onBack, onFinish }: { state: State; onBack: () => void; onFinish: () => void }) {
  const total = state.slices.reduce((a, s) => a + s.totalMs, 0)
  const max = Math.max(1, ...state.slices.map((s) => s.totalMs))
  return (
    <div className="panel">
      <div className="panel-head">
        <span>收工</span>
        <button className="icon" onClick={onBack}>
          ✕
        </button>
      </div>
      <p className="big">{fmtDur(total)}</p>
      <p className="sheet-sub">{state.roundsToday} 轮 · {state.slices.length} 片</p>
      <ul className="bars">
        {state.slices.map((s, i) => (
          <li key={s.id}>
            <span className="idx">{i + 1}</span>
            <span className="bar-name">
              <span className="name">{s.name}</span>
              <span className="bar">
                <i style={{ width: `${(s.totalMs / max) * 100}%` }} />
              </span>
            </span>
            <span className="dur">{fmtDur(s.totalMs)}</span>
          </li>
        ))}
      </ul>
      <div className="panel-foot">
        <button className="primary" onClick={onFinish}>
          确认收工，年轮清零
        </button>
      </div>
    </div>
  )
}
