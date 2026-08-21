"""
纯代码的质量体检，不用再开一轮 agent。

两类真问题，人眼在 inspect.html 里已经看到过：
1. 细长目标物转 45 度会拍扁成一条线——用「填充率」抓：真的圆/方/环形状
   filled 像素占比总落在一个稳定区间，被拍扁的形状 45 度那帧填充率会显著低于 0 度那帧。
2. 跑者剪影太淡——4 帧 + idle 里 '#' 像素总数太少，人眼几乎看不出主体。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sprites = json.load(open(os.path.join(HERE, "sprites.json")))


def bbox_density(grid):
    """填充像素占「填充像素外接矩形」的比例。真正旋转不变的形状（球/环/方块）
    在 0 度和 45 度这个数字应该差不多；细长东西转 45 度会摊满一个大外接框但
    里面稀稀拉拉，密度骤降 —— 这比「填充像素占整张图的比例」更能抓住旋转塌陷，
    因为一个居中的小图案哪怕本身稀疏，外接框也小，密度不受影响。"""
    xs, ys = [], []
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch == "#":
                xs.append(x)
                ys.append(y)
    if not xs:
        return 0.0
    w = max(xs) - min(xs) + 1
    h = max(ys) - min(ys) + 1
    return len(xs) / (w * h)


def min_run_frame_fill(sprite):
    """4 帧跑动里最淡的那一帧——动画播放时观众看到的是逐帧闪过，
    平均密度掩盖不了「其中一帧几乎是空的」这种问题。"""
    vals = []
    for f in sprite["runnerFrames"]:
        total = sum(len(row) for row in f)
        filled = sum(row.count("#") + row.count("o") for row in f)
        vals.append(filled / total)
    return min(vals)


# 阈值是拿 inspect.html 里目视确认过的坏例（香肠 d45=0.17、眼镜蛇 min=0.094）
# 和好例（毛线球 d45=0.38、滚珠 d45=0.74）标定出来的，不是拍脑袋定的。
GOAL_D45_MIN = 0.35
RUNNER_MIN_FRAME_FILL = 0.11

flagged_goal = []
flagged_runner = []

for s in sprites:
    d0 = bbox_density(s["goalFrame0"])
    d45 = bbox_density(s["goalFrame45"])
    if d45 < GOAL_D45_MIN:
        flagged_goal.append((s["slug"], s["goal"], round(d0, 3), round(d45, 3)))

    rf = min_run_frame_fill(s)
    if rf < RUNNER_MIN_FRAME_FILL:
        flagged_runner.append((s["slug"], s["runner"], round(rf, 3)))

print(f"目标物疑似「转起来会拍扁」：{len(flagged_goal)}/{len(sprites)}")
for slug, goal, r0, r45 in sorted(flagged_goal, key=lambda x: x[3]):
    print(f"  {slug:<40} {goal:<8} fill0={r0}  fill45={r45}")

print()
print(f"跑者疑似「剪影太淡」：{len(flagged_runner)}/{len(sprites)}")
for slug, runner, rf in sorted(flagged_runner, key=lambda x: x[2]):
    print(f"  {slug:<40} {runner:<8} fill={rf}")

bad_slugs = {s for s, *_ in flagged_goal} | {s for s, *_ in flagged_runner}
json.dump(
    sorted(bad_slugs),
    open(os.path.join(HERE, "flagged_slugs.json"), "w"),
    ensure_ascii=False,
    indent=1,
)
print()
print(f"合计不重复 flagged：{len(bad_slugs)} / {len(sprites)}")
print(f"干净剩下：{len(sprites) - len(bad_slugs)}")
