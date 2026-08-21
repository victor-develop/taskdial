export type ZooSprite = {
  slug: string
  runner: string
  goal: string
  /** 4 帧一个循环，16 宽 x10 高，字符 . # o（o 是眼睛） */
  runnerFrames: string[][]
  /** 停下等待的姿势，同样 16x10 */
  runnerIdle: string[]
  /** 11x11，字符 . #。另外两帧（90°/135°）程序自己用 rot90 转出来 */
  goalFrame0: string[]
  goalFrame45: string[]
}
