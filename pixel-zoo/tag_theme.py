"""给每个精灵图标上主题，preview 页按主题分组要用。"""

import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, "sprites.json")
sprites = json.load(open(path))

THEME_LABEL = {
    "pets": "家养动物与宠物",
    "wild-mammal": "野生哺乳动物",
    "bird": "鸟类",
    "sea": "海洋与水生",
    "bug": "昆虫与节肢",
    "reptile": "爬行/两栖/恐龙",
    "myth": "神话与想象生物",
    "robot": "机器人与机械",
    "vehicle": "交通工具",
    "food": "食物与厨房",
    "desk": "办公与程序员日常",
    "cosmic": "天体/天气/几何",
    "wx": "天体/天气/几何",
}


def theme_of(slug):
    for key in sorted(THEME_LABEL, key=len, reverse=True):
        if slug.startswith(key + "-"):
            return key
    return slug.split("-")[0]


for s in sprites:
    s["theme"] = theme_of(s["slug"])
    s["themeLabel"] = THEME_LABEL.get(s["theme"], s["theme"])

json.dump(sprites, open(path, "w"), ensure_ascii=False, indent=1)
print(collections.Counter(s["themeLabel"] for s in sprites))
