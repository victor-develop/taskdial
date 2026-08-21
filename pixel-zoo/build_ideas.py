"""把 workflow 出的 485 个 idea 整理成 ideas.json + ideas.md，并打印统计。"""

import collections
import json
import os

SRC = (
    "/private/tmp/claude-501/-Users-victorzhou-temp/"
    "a269c8d6-6c6f-437b-ad7e-35d10f07aad5/tasks/w90zgsatu.output"
)
OUT = os.path.dirname(os.path.abspath(__file__))

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
}


def theme_of(slug):
    for key in sorted(THEME_LABEL, key=len, reverse=True):
        if slug.startswith(key + "-"):
            return key
    return slug.split("-")[0]


res = json.load(open(SRC))["result"]
ideas = res["ideas"]
flagged = res.get("flagged", [])
notes = res.get("notes", {})
flag_by_slug = {f["slug"]: f["issues"] for f in flagged}

for idea in ideas:
    idea["theme"] = theme_of(idea["slug"])
    idea["flagged"] = idea["slug"] in flag_by_slug

with open(os.path.join(OUT, "ideas.json"), "w") as fh:
    json.dump(
        {"total": len(ideas), "ideas": ideas, "flagged": flagged, "notes": notes},
        fh,
        ensure_ascii=False,
        indent=2,
    )

by_theme = collections.defaultdict(list)
for idea in ideas:
    by_theme[idea["theme"]].append(idea)

lines = [
    f"# 像素动画 idea 清单（实得 {len(ideas)}）",
    "",
    "每套 = 一个跑者（16×10 单色剪影）+ 一个终点目标物（11×11，逐帧旋转播放）。",
    "",
    "- `legible` 是生成时的自评：high 剪影一眼认得出，med 勉强，low 概念有趣但这个尺寸下大概立不住",
    "- ⚠️ 是被审查 agent 标记出问题的（剪影撞车、旋转后不可辨、跨主题近重复）",
    "",
    "---",
    "",
]

for key, label in THEME_LABEL.items():
    group = by_theme.get(key, [])
    if not group:
        continue
    lines += [
        f"## {label} ({len(group)})",
        "",
        "| | 跑者 → 目标 | 移动方式 | 配对理由 | 辨识 |",
        "|---|---|---|---|---|",
    ]
    for idea in group:
        mark = "⚠️" if idea["flagged"] else ""
        lines.append(
            f"| {mark} | {idea['runner']} → {idea['goal']} | {idea['locomotion']}"
            f" | {idea['pairing']} | {idea['legible']} |"
        )
    lines.append("")

if flagged:
    lines += ["---", "", "## 审查标记明细", ""]
    for f in flagged:
        for issue in f["issues"]:
            tail = f" ｜ 建议：{issue['suggestion']}" if issue.get("suggestion") else ""
            lines.append(f"- **{f['slug']}** — {issue.get('problem', '')}{tail}")
    lines.append("")

lines += [
    "---",
    "",
    "## 审查 agent 的整体意见",
    "",
    "### 可读性",
    "",
    str(notes.get("legibility") or "(无)"),
    "",
    "### 重复",
    "",
    str(notes.get("dupes") or "(无)"),
    "",
]

with open(os.path.join(OUT, "ideas.md"), "w") as fh:
    fh.write("\n".join(lines))

leg = collections.Counter(i["legible"] for i in ideas)
print(f"总数 {len(ideas)}   被标记 {len(flag_by_slug)}")
print(f"辨识度  high {leg['high']}   med {leg['med']}   low {leg['low']}")
print()
print(f"{'主题':<16}{'数量':>5}{'high':>6}{'med':>5}{'low':>5}{'标记':>6}")
for key, label in THEME_LABEL.items():
    group = by_theme.get(key, [])
    c = collections.Counter(i["legible"] for i in group)
    n_flag = sum(1 for i in group if i["flagged"])
    print(f"{label:<16}{len(group):>5}{c['high']:>6}{c['med']:>5}{c['low']:>5}{n_flag:>6}")
