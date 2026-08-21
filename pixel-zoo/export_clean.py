"""导出「没被标记 + legible=high」的 111 个 idea，给 workflow 当输入。"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ideas = json.load(open(os.path.join(HERE, "ideas.json")))["ideas"]
clean = [i for i in ideas if i["legible"] == "high" and not i["flagged"]]

compact = [
    {
        "slug": i["slug"],
        "runner": i["runner"],
        "goal": i["goal"],
        "locomotion": i["locomotion"],
        "pairing": i["pairing"],
    }
    for i in clean
]

out = os.path.join(HERE, "clean111.json")
json.dump(compact, open(out, "w"), ensure_ascii=False, indent=2)
print(f"{len(compact)} -> {out}")
