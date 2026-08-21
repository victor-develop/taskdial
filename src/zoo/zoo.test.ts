import { describe, expect, it } from 'vitest'
import { ZOO, pickZooSprite, type ZooSprite } from './index'

/**
 * 111 套手写/生成的像素图，靠肉眼看不出哪一行少了个字符 —— 少一个的后果是
 * 整只动物错位，而且不报错。types.ts 里写明了契约，这里把它执行起来。
 */

const RUNNER_W = 16
const RUNNER_H = 10
const GOAL = 11
const FRAMES = 4

function check(rows: string[], w: number, h: number, allowed: RegExp, where: string) {
  expect(rows, `${where} 行数`).toHaveLength(h)
  rows.forEach((row, i) => {
    expect(row.length, `${where} 第 ${i} 行宽度（"${row}"）`).toBe(w)
    expect(row, `${where} 第 ${i} 行有非法字符`).toMatch(allowed)
  })
}

describe('像素动物园的数据契约', () => {
  it('池子非空，slug 不重复', () => {
    expect(ZOO.length).toBeGreaterThan(100)
    const slugs = ZOO.map((z) => z.slug)
    expect(new Set(slugs).size, '有重复的 slug').toBe(slugs.length)
  })

  it('每只都有名字', () => {
    ZOO.forEach((z) => {
      expect(z.slug, 'slug 不能空').toMatch(/^[a-z0-9-]+$/)
      expect(z.runner.trim(), `${z.slug} 的 runner 名`).not.toBe('')
      expect(z.goal.trim(), `${z.slug} 的 goal 名`).not.toBe('')
    })
  })

  // 111 只逐一点名，挂的时候直接看得出是哪一只
  it.each(ZOO.map((z) => [z.slug, z] as [string, ZooSprite]))(
    '%s 的精灵图尺寸和字符都合规',
    (slug, z) => {
      expect(z.runnerFrames, `${slug} 跑动帧数`).toHaveLength(FRAMES)
      z.runnerFrames.forEach((frame, n) => {
        check(frame, RUNNER_W, RUNNER_H, /^[.#o]+$/, `${slug} runnerFrames[${n}]`)
      })
      check(z.runnerIdle, RUNNER_W, RUNNER_H, /^[.#o]+$/, `${slug} runnerIdle`)
      check(z.goalFrame0, GOAL, GOAL, /^[.#]+$/, `${slug} goalFrame0`)
      check(z.goalFrame45, GOAL, GOAL, /^[.#]+$/, `${slug} goalFrame45`)
    },
  )

  it('每只都画了点东西 —— 不能有全空的帧', () => {
    ZOO.forEach((z) => {
      z.runnerFrames.forEach((frame, n) => {
        expect(frame.join('').includes('#'), `${z.slug} runnerFrames[${n}] 是空的`).toBe(true)
      })
      expect(z.runnerIdle.join('').includes('#'), `${z.slug} runnerIdle 是空的`).toBe(true)
      expect(z.goalFrame0.join('').includes('#'), `${z.slug} goalFrame0 是空的`).toBe(true)
      expect(z.goalFrame45.join('').includes('#'), `${z.slug} goalFrame45 是空的`).toBe(true)
    })
  })

  it('跑动的四帧不能全都一样，否则看着就是不动', () => {
    ZOO.forEach((z) => {
      const distinct = new Set(z.runnerFrames.map((f) => f.join('\n')))
      expect(distinct.size, `${z.slug} 四帧完全相同`).toBeGreaterThan(1)
    })
  })

  it('pickZooSprite 不会挑到被排除的那只', () => {
    for (const z of ZOO.slice(0, 20)) {
      for (let i = 0; i < 30; i++) {
        expect(pickZooSprite(z.slug).slug).not.toBe(z.slug)
      }
    }
  })
})
