import { useEffect, useState } from 'react'

// ── 像素小狗 ──────────────────────────────────────────────
// 每行一个字符串，'#' 是身体，'o' 是眼睛。16 宽。

const W = 16
const EMPTY = '.'.repeat(W)

const BODY = [
  '.............##.',
  '..#.........####',
  '..##.......##o##',
  '.##############.',
  '.###############',
  '.#############..',
]

/** 三种腿的姿势：伸开、收拢、反向伸开 */
const LEGS_OPEN = ['..#.#.....#..#..', '.#...#....#...#.', '.#...#....#...#.']
const LEGS_TUCK = ['...##......##...', '...##......##...', '...#........#...']
const LEGS_BACK = ['.#..#....#..#...', '#...#...#....#..', '#...#...#....#..']

// 收拢的两帧把身体抬高一格 —— 跑起来才有上下颠的感觉
const RUN_FRAMES = [
  [EMPTY, ...BODY, ...LEGS_OPEN],
  [...BODY, ...LEGS_TUCK, EMPTY],
  [EMPTY, ...BODY, ...LEGS_BACK],
  [...BODY, ...LEGS_TUCK, EMPTY],
]

const SIT = [
  '.............##.',
  '............####',
  '..#........##o##',
  '..##..#########.',
  '..#############.',
  '..############..',
  '..###.....###...',
  '..###.....###...',
  '..####...#####..',
  '................',
]

/** 把像素图压成一条 path：每段连续像素一个矩形，比一堆 <rect> 省得多 */
function toPath(rows: string[], ch: string) {
  let d = ''
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== ch) {
        x++
        continue
      }
      let w = 1
      while (row[x + w] === ch) w++
      d += `M${x} ${y}h${w}v1h-${w}z`
      x += w
    }
  })
  return d
}

const RUN_PATHS = RUN_FRAMES.map((f) => ({ body: toPath(f, '#'), eye: toPath(f, 'o') }))
const SIT_PATH = { body: toPath(SIT, '#'), eye: toPath(SIT, 'o') }

// ── 漏斗 ──────────────────────────────────────────────────
// 每一行的内腔跨度。上腔 y=1..5 越往下越窄，下腔镜像。

const CHAMBER: Array<[number, number]> = [
  [1, 9],
  [2, 8],
  [3, 7],
  [4, 6],
  [5, 5],
]
const GLASS_W = 11
const GLASS_H = 12

function glassFrame() {
  let d = `M0 0h${GLASS_W}v1H0z M0 ${GLASS_H - 1}h${GLASS_W}v1H0z`
  CHAMBER.forEach(([a, b], i) => {
    for (const y of [1 + i, GLASS_H - 2 - i]) {
      d += `M${a - 1} ${y}h1v1h-1z M${b + 1} ${y}h1v1h-1z`
    }
  })
  return d
}
const GLASS_PATH = glassFrame()

/** left = 还剩多少（1 → 满） */
function sandPath(left: number) {
  let d = ''
  // 上腔：沙面从上往下掉，剩下的堆在窄的那头
  CHAMBER.forEach(([a, b], i) => {
    const y = 1 + i
    if (5 - i <= left * 5) d += `M${a} ${y}h${b - a + 1}v1h-${b - a + 1}z`
  })
  // 下腔：从最宽的底部往上堆
  CHAMBER.forEach(([a, b], i) => {
    const y = GLASS_H - 2 - i
    if (i + 1 <= (1 - left) * 5) d += `M${a} ${y}h${b - a + 1}v1h-${b - a + 1}z`
  })
  return d
}

// ── 组装 ──────────────────────────────────────────────────

const TRACK = 92 // viewBox 宽；越小像素越大颗
const DOG_RUN = TRACK - GLASS_W - 6 - W // 给漏斗留出右边

type Props = { progress: number; running: boolean }

export default function Runner({ progress, running }: Props) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setFrame((f) => (f + 1) % RUN_PATHS.length), 130)
    return () => clearInterval(id)
  }, [running])

  const p = Math.max(0, Math.min(1, progress))
  const dog = running ? RUN_PATHS[frame] : SIT_PATH
  const x = Math.round(p * DOG_RUN)

  return (
    <svg className="runner" viewBox={`0 0 ${TRACK} 16`}>
      {/* 地面，跑起来的时候往后滚 */}
      <path
        className={running ? 'ground moving' : 'ground'}
        d={`M0 13.5h${DOG_RUN + W}`}
        strokeDasharray="3 3"
      />

      <g transform={`translate(${x} 3)`}>
        <path className="dog" d={dog.body} />
        <path className="dog-eye" d={dog.eye} />
      </g>

      <g transform={`translate(${TRACK - GLASS_W} 2)`}>
        <path className="glass" d={GLASS_PATH} />
        <path className="sand" d={sandPath(1 - p)} />
        {running && p < 1 && (
          <path className="grain" d={`M5 ${GLASS_H / 2 - 1}h1v2h-1z`} />
        )}
      </g>
    </svg>
  )
}
