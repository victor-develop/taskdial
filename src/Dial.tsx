import { HUES, MAX_LAPS, RINGS_PER_LAP, rings, sliceAngle, type State } from './model'

const C = 120 // 圆心
const R_OUT = 104
const R_IN = 34
const HUB = 30
const BAND = (R_OUT - R_IN) / RINGS_PER_LAP
const GAP = 1.4 // 年轮之间留缝，才像树

/** 0° 指正上方 */
function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

function sector(rIn: number, rOut: number, a0: number, a1: number) {
  const large = a1 - a0 > 180 ? 1 : 0
  const [x0, y0] = polar(rOut, a0)
  const [x1, y1] = polar(rOut, a1)
  const [x2, y2] = polar(rIn, a1)
  const [x3, y3] = polar(rIn, a0)
  return `M${x0} ${y0}A${rOut} ${rOut} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${rIn} ${rIn} 0 ${large} 0 ${x3} ${y3}Z`
}

/** 圈数越多颜色越深，像木头一年年沉下去 */
function ringFill(hue: number, lap: number, band: number) {
  const light = [64, 52, 40][lap] + (band % 2 ? 4 : 0)
  const sat = [55, 62, 70][lap]
  return `hsl(${hue} ${sat}% ${light}%)`
}

type Props = {
  state: State
  /** 每片当前显示的累计时长，含正在跑的这一轮 —— 年轮是连着长的 */
  totals: number[]
  hub: { main: string; sub?: string }
  onDoubleClick: () => void
}

export default function Dial({ state, totals, hub, onDoubleClick }: Props) {
  const n = state.slices.length
  const A = sliceAngle(n)

  return (
    <svg className="dial" viewBox="0 0 240 240" onDoubleClick={onDoubleClick}>
      {/* 指针，不动 */}
      <path
        className={state.pinned ? 'pointer pinned' : 'pointer'}
        d={`M${C - 7} 3L${C + 7} 3L${C} 16Z`}
      />

      <g className="spin" style={{ transform: `rotate(${state.rotationDeg}deg)`, transformOrigin: `${C}px ${C}px` }}>
        {state.slices.map((slice, i) => {
          const a0 = i * A - A / 2
          const a1 = i * A + A / 2
          const hue = HUES[i % HUES.length]
          const r = rings(totals[i])
          const isCurrent = i === state.currentIndex
          const [numX, numY] = polar((R_IN + R_OUT) / 2, i * A)

          return (
            <g key={slice.id} className={isCurrent ? 'slice current' : 'slice'}>
              {/* 底：还没长到的部分 */}
              <path d={sector(R_IN, R_OUT, a0 + 0.6, a1 - 0.6)} className="slice-bg" />

              {/* 已成型的整层年轮 */}
              {Array.from({ length: r.full }, (_, b) => (
                <path
                  key={b}
                  d={sector(R_IN + b * BAND + GAP / 2, R_IN + (b + 1) * BAND - GAP / 2, a0 + 0.6, a1 - 0.6)}
                  fill={ringFill(hue, r.lap, b)}
                />
              ))}

              {/* 正在长的那一层，按角度长出来 */}
              {r.full < RINGS_PER_LAP && r.frac > 0.002 && (
                <path
                  d={sector(
                    R_IN + r.full * BAND + GAP / 2,
                    R_IN + (r.full + 1) * BAND - GAP / 2,
                    a0 + 0.6,
                    a0 + 0.6 + (a1 - a0 - 1.2) * r.frac,
                  )}
                  fill={ringFill(hue, r.lap, r.full)}
                  opacity={0.72}
                />
              )}

              {/* 每满 8h 在弧边刻一道 */}
              {Array.from({ length: Math.min(r.notches, MAX_LAPS) }, (_, k) => {
                const deg = i * A - (Math.min(r.notches, MAX_LAPS) - 1) * 3 + k * 6
                const [x0, y0] = polar(R_OUT + 3, deg)
                const [x1, y1] = polar(R_OUT + 8, deg)
                return <line key={k} x1={x0} y1={y0} x2={x1} y2={y1} className="notch" />
              })}

              <path d={sector(R_IN, R_OUT, a0 + 0.6, a1 - 0.6)} className="slice-edge" />

              {/* 片号跟着盘转，反向转回来才立得正；跟外层同一条 transition 才不会抖 */}
              <g
                className="spin"
                style={{
                  transform: `rotate(${-state.rotationDeg}deg)`,
                  transformOrigin: `${numX}px ${numY}px`,
                }}
              >
                <text x={numX} y={numY} className="slice-num" textAnchor="middle" dominantBaseline="central">
                  {i + 1}
                </text>
              </g>
            </g>
          )
        })}
      </g>

      <circle cx={C} cy={C} r={HUB} className="hub" />
      <text x={C} y={hub.sub ? C - 4 : C} className="hub-main" textAnchor="middle" dominantBaseline="central">
        {hub.main}
      </text>
      {hub.sub && (
        <text x={C} y={C + 11} className="hub-sub" textAnchor="middle" dominantBaseline="central">
          {hub.sub}
        </text>
      )}
    </svg>
  )
}
