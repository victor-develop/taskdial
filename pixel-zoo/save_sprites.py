"""把 workflow 返回的完整精灵图数据存成 sprites.json，并做一次结构体检。"""

import json
import os

SRC = (
    "/private/tmp/claude-501/-Users-victorzhou-temp/"
    "a269c8d6-6c6f-437b-ad7e-35d10f07aad5/tasks/w8jbq6xa7.output"
)
HERE = os.path.dirname(os.path.abspath(__file__))

raw = json.load(open(SRC))["result"]
sprites = raw["sprites"]

print(f"total={raw['total']} drawn={raw['drawn']} missingSlugs={raw.get('missingSlugs')}")

W, H, N = 16, 10, 11
bad = []
for s in sprites:
    if len(s["runnerFrames"]) != 4:
        bad.append((s["slug"], "frames!=4"))
        continue
    for f in s["runnerFrames"]:
        if len(f) != H or any(len(r) != W for r in f):
            bad.append((s["slug"], "frame shape"))
    if len(s["runnerIdle"]) != H or any(len(r) != W for r in s["runnerIdle"]):
        bad.append((s["slug"], "idle shape"))
    for key in ("goalFrame0", "goalFrame45"):
        g = s[key]
        if len(g) != N or any(len(r) != N for r in g):
            bad.append((s["slug"], f"{key} shape"))

print(f"shape check: {len(bad)} problems" if bad else "shape check: all good")
for b in bad[:20]:
    print("  ", b)

json.dump(sprites, open(os.path.join(HERE, "sprites.json"), "w"), ensure_ascii=False, indent=1)
print(f"wrote {len(sprites)} sprites -> {os.path.join(HERE, 'sprites.json')}")
