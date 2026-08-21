"""看一眼审查之后还剩多少能用的，以及跑者/目标物的原型池有多大。"""

import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ideas = json.load(open(os.path.join(HERE, "ideas.json")))["ideas"]

clean = [i for i in ideas if i["legible"] == "high" and not i["flagged"]]
usable = [i for i in ideas if i["legible"] in ("high", "med") and not i["flagged"]]

print(f"全集              {len(ideas)}")
print(f"没被标记 + high    {len(clean)}")
print(f"没被标记 + high/med {len(usable)}")
print()
print(f"不同跑者   {len({i['runner'] for i in ideas})}")
print(f"不同目标物 {len({i['goal'] for i in ideas})}")
print()
print("干净 high 的主题分布：")
for key, n in collections.Counter(i["theme"] for i in clean).most_common():
    print(f"  {key:<14}{n}")
print()
print("目标物出现次数最多的（同形撞车的根源）：")
for goal, n in collections.Counter(i["goal"] for i in ideas).most_common(12):
    print(f"  {goal:<8}{n}")
print()
print("干净 high 里的前 15 个：")
for i in clean[:15]:
    print(f"  {i['runner']} → {i['goal']}  |  {i['locomotion']}")
