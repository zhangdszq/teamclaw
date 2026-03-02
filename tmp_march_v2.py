import subprocess, json, sys, os
from datetime import datetime, timezone
from collections import defaultdict

MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
DENTRY = "YndMj49yWjPlp1QEFmjYYeDbJ3pmz5aA"
SHEET = "3NuAZfX"
OUT = r"d:\git-repos\VK-Cowork\tmp_march_v2_result.json"
os.chdir(r"d:\git-repos\VK-Cowork")

sys.path.insert(0, r"C:\Users\Administrator\.claude\skills\dingtalk-ai-table\scripts")
from search_records import search, get_field_value, get_raw_field_value, _ts_to_datestr

print("Fetching + filtering...", file=sys.stderr)
records = search(
    dentry_uuid=DENTRY,
    sheet_name=SHEET,
    filters=["需求状态!=已关闭"],
    or_filters=[
        "计划上线日@2026-03",
        "期望上线时间~3月",
        "期望上线时间~2026-03",
        "期望上线时间~2026年3月",
    ],
)
print(f"Matched: {len(records)}", file=sys.stderr)

def get_select_name(val):
    if isinstance(val, dict):
        return val.get("name", "")
    return str(val) if val else ""

def get_user_uids(val):
    if not val:
        return []
    if isinstance(val, list):
        return [u.get("uid", u.get("id", "")) for u in val if isinstance(u, dict)]
    if isinstance(val, dict):
        return [val.get("uid", val.get("id", ""))]
    return []

output_records = []
for rec in records:
    f = rec.get("fields", {})
    plan_ts = f.get("计划上线日")
    plan_date = _ts_to_datestr(plan_ts) if plan_ts else None
    expect_text = f.get("期望上线时间", "")
    matched_by = []
    if plan_date and plan_date.startswith("2026-03"):
        matched_by.append("计划上线日")
    if expect_text and ("3月" in str(expect_text) or "2026-03" in str(expect_text) or "2026年3月" in str(expect_text)):
        matched_by.append("期望上线时间")

    output_records.append({
        "name": f.get("需求名称", "(无名)"),
        "status": get_select_name(f.get("需求状态")),
        "priority": get_select_name(f.get("优先级")),
        "plan_date": plan_date,
        "expect_time": str(expect_text) if expect_text else "",
        "actual_date": _ts_to_datestr(f.get("实际上线日")) if f.get("实际上线日") else None,
        "biz": get_select_name(f.get("一级业务线")),
        "biz2": get_select_name(f.get("二级业务单元")),
        "scale": get_select_name(f.get("需求规模")),
        "moscow": get_select_name(f.get("迭代莫斯科")),
        "main_r": get_user_uids(f.get("主R")),
        "pm": get_user_uids(f.get("产品经理")),
        "progress": f.get("进度说明", ""),
        "matched_by": matched_by,
    })

priority_order = {"P0 - 重要紧急": 0, "P1 - 高优项目": 1, "P2 - 常规项目": 2, "": 3}
output_records.sort(key=lambda x: (priority_order.get(x["priority"], 9), x["plan_date"] or "9999"))

status_counts = defaultdict(int)
priority_counts = defaultdict(int)
biz_counts = defaultdict(int)
match_source = defaultdict(int)
for r in output_records:
    status_counts[r["status"] or "(空)"] += 1
    if r["priority"]: priority_counts[r["priority"]] += 1
    if r["biz"]: biz_counts[r["biz"]] += 1
    for m in r["matched_by"]:
        match_source[m] += 1

output = {
    "filter": "需求状态!=已关闭 AND (计划上线日@2026-03 OR 期望上线时间~3月)",
    "total": len(output_records),
    "match_source": dict(match_source),
    "status_summary": dict(sorted(status_counts.items(), key=lambda x: -x[1])),
    "priority_summary": dict(sorted(priority_counts.items(), key=lambda x: -x[1])),
    "biz_summary": dict(sorted(biz_counts.items(), key=lambda x: -x[1])),
    "records": output_records,
}

with open(OUT, "w", encoding="utf-8") as fp:
    json.dump(output, fp, indent=2, ensure_ascii=False)
print(f"Done -> {OUT}", file=sys.stderr)
