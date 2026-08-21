"""
把 pixel-zoo/sprites.json（111 套精灵图）炸成 src/zoo/ 下一个文件一只动物，
而不是塞一个大 JSON。每个文件是个小的 TS 模块，git diff 按动物走，
以后单独改哪只都是一行文件的事。
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, "src", "zoo")
os.makedirs(OUT, exist_ok=True)

sprites = json.load(open(os.path.join(HERE, "sprites.json")))


def ident(slug):
    """slug 转成合法的 TS 变量名：pets-dachshund-sausage -> petsDachshundSausage"""
    parts = re.split(r"[^a-zA-Z0-9]+", slug)
    return parts[0] + "".join(p.capitalize() for p in parts[1:] if p)


def rows_literal(rows, indent="  "):
    lines = ",\n".join(f'{indent}  {json.dumps(r, ensure_ascii=False)}' for r in rows)
    return f"[\n{lines},\n{indent}]"


HEADER = """// 自动生成 —— 改这个文件本身没问题（就是改这只动物），
// 但如果要批量改画法，去改 pixel-zoo/gen_zoo_ts.py 重新生成，不要手改所有 111 个文件。
import type {{ ZooSprite }} from './types'

const sprite: ZooSprite = {{
  slug: {slug!r},
  runner: {runner!r},
  goal: {goal!r},
  runnerFrames: [
{frames}
  ],
  runnerIdle: {idle},
  goalFrame0: {g0},
  goalFrame45: {g45},
}}

export default sprite
"""


def py_repr_to_ts_string(s):
    return json.dumps(s, ensure_ascii=False)


written = []
for s in sprites:
    frames = ",\n".join(f"    {rows_literal(f, '   ')}" for f in s["runnerFrames"])
    content = f"""// 自动生成 —— 改这个文件本身没问题（就是改这只动物），
// 但如果要批量改画法，去改 pixel-zoo/gen_zoo_ts.py 重新生成，不要手改所有 111 个文件。
import type {{ ZooSprite }} from './types'

const sprite: ZooSprite = {{
  slug: {py_repr_to_ts_string(s['slug'])},
  runner: {py_repr_to_ts_string(s['runner'])},
  goal: {py_repr_to_ts_string(s['goal'])},
  runnerFrames: [
{frames}
  ],
  runnerIdle: {rows_literal(s['runnerIdle'])},
  goalFrame0: {rows_literal(s['goalFrame0'])},
  goalFrame45: {rows_literal(s['goalFrame45'])},
}}

export default sprite
"""
    path = os.path.join(OUT, f"{s['slug']}.ts")
    open(path, "w").write(content)
    written.append(s["slug"])

# types.ts
open(os.path.join(OUT, "types.ts"), "w").write(
    """export type ZooSprite = {
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
"""
)

# index.ts barrel
imports = "\n".join(f"import {ident(s)} from './{s}'" for s in written)
array = ",\n".join(f"  {ident(s)}" for s in written)
open(os.path.join(OUT, "index.ts"), "w").write(
    f"""// 111 只动物，一个文件一个。这个 barrel 是唯一一处把它们全部聚起来的地方。
import type {{ ZooSprite }} from './types'
export type {{ ZooSprite }}

{imports}

export const ZOO: ZooSprite[] = [
{array},
]

/** 挑一个跟上次不一样的 —— 池子够大（111），连续两次撞同一个的概率本来就低，
    但没必要留这点小烦躁给用户。 */
export function pickZooSprite(excludeSlug?: string): ZooSprite {{
  if (ZOO.length <= 1) return ZOO[0]
  let pick = ZOO[Math.floor(Math.random() * ZOO.length)]
  while (pick.slug === excludeSlug) {{
    pick = ZOO[Math.floor(Math.random() * ZOO.length)]
  }}
  return pick
}}
"""
)

print(f"wrote {len(written)} sprite files + types.ts + index.ts -> {OUT}")
