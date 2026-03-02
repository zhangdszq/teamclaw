import subprocess, json, sys, os
from datetime import datetime, timezone

MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
DENTRY = "YndMj49yWjPlp1QEFmjYYeDbJ3pmz5aA"
SHEET = "3NuAZfX"
OUT = r"d:\git-repos\VK-Cowork\tmp_march_result.json"
os.chdir(r"d:\git-repos\VK-Cowork")

def call_mcp(server, tool, args):
    args_json = json.dumps(args, ensure_ascii=False)
    cmd = [MCPORTER, "call", server, tool, "--args", args_json, "--output", "json"]
    r = subprocess.run(cmd, capture_output=True, timeout=30, encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout) if r.stdout else None
    except:
        return None

def fetch_all_records():
    all_records = []
    cursor = None
    page = 0
    while page < 200:
        page += 1
        args = {"dentryUuid": DENTRY, "sheetIdOrName": SHEET}
        if cursor:
            args["cursor"] = cursor
        r = call_mcp("dingtalk-ai-table", "search_base_record", args)
        if not r:
            break
        result = r.get("result", {})
        records = result.get("records", [])
        all_records.extend(records)
        print(f"  [page {page}] {len(records)}, total {len(all_records)}", file=sys.stderr)
        if not result.get("hasMore") or not result.get("cursor"):
            break
        cursor = result["cursor"]
    return all_records

def ts_to_date(ts):
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except:
        return None

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

print("Fetching all records...", file=sys.stderr)
records = fetch_all_records()
print(f"Total: {len(records)}\n", file=sys.stderr)

# Filter: 计划上线日 in March 2026 (2026-03-01 ~ 2026-03-31)
march_start = datetime(2026, 3, 1, tzinfo=timezone.utc).timestamp() * 1000
march_end = datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp() * 1000

march_records = []
for rec in records:
    f = rec.get("fields", {})
    plan_ts = f.get("计划上线日")
    if not plan_ts:
        continue
    if march_start <= plan_ts < march_end:
        status = get_select_name(f.get("需求状态"))
        # Exclude already closed
        if status in ("已关闭",):
            continue
        march_records.append({
            "name": f.get("需求名称", "(无名)"),
            "status": status,
            "priority": get_select_name(f.get("优先级")),
            "plan_date": ts_to_date(plan_ts),
            "actual_date": ts_to_date(f.get("实际上线日")),
            "biz": get_select_name(f.get("一级业务线")),
            "biz2": get_select_name(f.get("二级业务单元")),
            "scale": get_select_name(f.get("需求规模")),
            "main_r": get_user_uids(f.get("主R")),
            "pm": get_user_uids(f.get("产品经理")),
            "progress": f.get("进度说明", ""),
            "moscow": get_select_name(f.get("迭代莫斯科")),
        })

# Sort by priority then plan_date
priority_order = {"P0 - 重要紧急": 0, "P1 - 高优项目": 1, "P2 - 常规项目": 2, "": 3}
march_records.sort(key=lambda x: (priority_order.get(x["priority"], 9), x["plan_date"] or ""))

# Stats summary
from collections import defaultdict
status_counts = defaultdict(int)
priority_counts = defaultdict(int)
biz_counts = defaultdict(int)
for r in march_records:
    status_counts[r["status"] or "(空)"] += 1
    if r["priority"]: priority_counts[r["priority"]] += 1
    if r["biz"]: biz_counts[r["biz"]] += 1

output = {
    "filter": "计划上线日 in 2026-03, 排除已关闭",
    "total": len(march_records),
    "status_summary": dict(sorted(status_counts.items(), key=lambda x: -x[1])),
    "priority_summary": dict(sorted(priority_counts.items(), key=lambda x: -x[1])),
    "biz_summary": dict(sorted(biz_counts.items(), key=lambda x: -x[1])),
    "records": march_records,
}

with open(OUT, "w", encoding="utf-8") as fp:
    json.dump(output, fp, indent=2, ensure_ascii=False)
print(f"March records: {len(march_records)}", file=sys.stderr)
print(f"Done -> {OUT}", file=sys.stderr)
