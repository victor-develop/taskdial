import { useEffect, useState } from 'react'
import type { Phase } from './model'

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

// ── 转动的骨头 ────────────────────────────────────────────
// 像素图不能靠 transform 转 —— 转出来是糊的锯齿。手画 0° 和 45°，
// 另外两帧转置得到。骨头 180° 对称，四帧连起来就是一整圈。

const BONE_0 = [
  '...........',
  '...........',
  '...........',
  '.##.....##.',
  '####...####',
  '###########',
  '####...####',
  '.##.....##.',
  '...........',
  '...........',
  '...........',
]

const BONE_45 = [
  '........##.',
  '.......####',
  '.......###.',
  '......###..',
  '.....###...',
  '....###....',
  '...###.....',
  '..###......',
  '.###.......',
  '####.......',
  '.##........',
]

/** 顺时针转 90°：new[y][x] = old[n-1-x][y] */
function rot90(rows: string[]) {
  const n = rows.length
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => rows[n - 1 - x][y]).join(''),
  )
}

const BONE_SIZE = BONE_0.length
const BONE_PATHS = [BONE_0, BONE_45, rot90(BONE_0), rot90(BONE_45)].map((f) => toPath(f, '#'))

/** 越接近这一轮的终点转得越快 */
const SPIN_MS = [210, 170, 130, 95]

// ── 组装 ──────────────────────────────────────────────────

const TRACK = 92 // viewBox 宽；越小像素越大颗
const DOG_RUN = TRACK - BONE_SIZE - 5 - W

type Props = { progress: number; phase: Phase }

export default function Runner({ progress, phase }: Props) {
  const running = phase === 'running'
  const p = Math.max(0, Math.min(1, progress))

  const [dogFrame, setDogFrame] = useState(0)
  const [boneFrame, setBoneFrame] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setDogFrame((f) => (f + 1) % RUN_PATHS.length), 130)
    return () => clearInterval(id)
  }, [running])

  // 用分档的进度当依赖，一轮里只重建 4 次定时器，不是每 250ms 一次
  const speedStep = Math.min(SPIN_MS.length - 1, Math.floor(p * SPIN_MS.length))
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setBoneFrame((f) => (f + 1) % BONE_PATHS.length), SPIN_MS[speedStep])
    return () => clearInterval(id)
  }, [running, speedStep])

  const dog = running ? RUN_PATHS[dogFrame] : SIT_PATH
  // 等确认时把狗放到终点 —— 它刚跑完这一轮，就该在骨头旁边坐着。
  // 暂停就地坐下，停在跑到哪儿算哪儿。
  const x =
    running || phase === 'paused'
      ? Math.round(p * DOG_RUN)
      : phase === 'awaiting'
        ? DOG_RUN
        : 0

  return (
    <svg className="runner" viewBox={`0 0 ${TRACK} 16`}>
      <path
        className={running ? 'ground moving' : 'ground'}
        d={`M0 13.5h${DOG_RUN + W}`}
        strokeDasharray="3 3"
      />

      <g transform={`translate(${x} 3)`}>
        <path className="dog" d={dog.body} />
        <path className="dog-eye" d={dog.eye} />
      </g>

      <g transform={`translate(${TRACK - BONE_SIZE} 2)`}>
        <path className={running ? 'bone' : 'bone still'} d={BONE_PATHS[running ? boneFrame : 0]} />
      </g>
    </svg>
  )
}
