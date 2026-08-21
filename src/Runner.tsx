import { useEffect, useMemo, useRef, useState } from 'react'
import type { Phase } from './model'
import { pickZooSprite, type ZooSprite } from './zoo'

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

/** 顺时针转 90°：new[y][x] = old[n-1-x][y]。像素图不能靠 transform 转，
    转出来是糊的锯齿，所以只手画 0°/45°，另外两帧靠这个转出来。
    骨头、球、蛋这类形状 180° 对称，四帧连起来就是一整圈。 */
function rot90(rows: string[]) {
  const n = rows.length
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => rows[n - 1 - x][y]).join(''),
  )
}

const W = 16 // 跑者宽
const GOAL_N = 11 // 目标物边长
const SPIN_MS = [210, 170, 130, 95] // 越接近这一轮的终点转得越快

const TRACK = 92 // viewBox 宽；越小像素越大颗
const RUN_TRACK = TRACK - GOAL_N - 5 - W

function buildPaths(sprite: ZooSprite) {
  const runFrames = sprite.runnerFrames.map((f) => ({ body: toPath(f, '#'), eye: toPath(f, 'o') }))
  const idle = { body: toPath(sprite.runnerIdle, '#'), eye: toPath(sprite.runnerIdle, 'o') }
  const goalFrames = [
    sprite.goalFrame0,
    sprite.goalFrame45,
    rot90(sprite.goalFrame0),
    rot90(sprite.goalFrame45),
  ].map((f) => toPath(f, '#'))
  return { runFrames, idle, goalFrames }
}

type Props = { progress: number; phase: Phase }

export default function Runner({ progress, phase }: Props) {
  const running = phase === 'running'
  const p = Math.max(0, Math.min(1, progress))

  // 每次真正开始一轮（不是暂停后恢复）换一只新动物；
  // 池子有 111 个，用完全随机也很难连续撞同一个，但没必要留这点小烦躁给用户。
  const [sprite, setSprite] = useState(() => pickZooSprite())
  const prevPhase = useRef(phase)
  useEffect(() => {
    const freshStart = phase === 'running' && prevPhase.current !== 'running' && prevPhase.current !== 'paused'
    if (freshStart) setSprite((cur) => pickZooSprite(cur.slug))
    prevPhase.current = phase
  }, [phase])

  const paths = useMemo(() => buildPaths(sprite), [sprite])

  const [runFrame, setRunFrame] = useState(0)
  const [goalFrame, setGoalFrame] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setRunFrame((f) => (f + 1) % paths.runFrames.length), 130)
    return () => clearInterval(id)
  }, [running, paths])

  // 用分档的进度当依赖，一轮里只重建 4 次定时器，不是每 250ms 一次
  const speedStep = Math.min(SPIN_MS.length - 1, Math.floor(p * SPIN_MS.length))
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setGoalFrame((f) => (f + 1) % paths.goalFrames.length), SPIN_MS[speedStep])
    return () => clearInterval(id)
  }, [running, speedStep, paths])

  const runner = running ? paths.runFrames[runFrame] : paths.idle
  // 等确认时把跑者放到终点 —— 它刚跑完这一轮，就该在目标物旁边等着。
  // 暂停就地停住，停在跑到哪儿算哪儿。
  const x =
    running || phase === 'paused'
      ? Math.round(p * RUN_TRACK)
      : phase === 'awaiting'
        ? RUN_TRACK
        : 0

  return (
    <svg className="runner" viewBox={`0 0 ${TRACK} 16`}>
      <path
        className={running ? 'ground moving' : 'ground'}
        d={`M0 13.5h${RUN_TRACK + W}`}
        strokeDasharray="3 3"
      />

      <g transform={`translate(${x} 3)`}>
        <path className="zoo-runner" d={runner.body} />
        <path className="zoo-runner-eye" d={runner.eye} />
      </g>

      <g transform={`translate(${TRACK - GOAL_N} 2)`}>
        <path
          className={running ? 'zoo-goal' : 'zoo-goal still'}
          d={paths.goalFrames[running ? goalFrame : 0]}
        />
      </g>
    </svg>
  )
}
