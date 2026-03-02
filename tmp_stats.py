import subprocess, json, sys, os
from collections import defaultdict
from datetime import datetime, timezone

MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
DENTRY = "YndMj49yWjPlp1QEFmjYYeDbJ3pmz5aA"
SHEET = "3NuAZfX"
OUT = r"d:\git-repos\VK-Cowork\tmp_stats_result.json"
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
        print(f"  [page {page}] {len(records)} records, total {len(all_records)}", file=sys.stderr)
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
print(f"Total: {len(records)} records\n", file=sys.stderr)

today = datetime.now().strftime("%Y-%m-%d")
today_ts = datetime.now().timestamp() * 1000

status_counts = defaultdict(int)
priority_counts = defaultdict(int)
biz_counts = defaultdict(int)
biz2_counts = defaultdict(int)
scale_counts = defaultdict(int)
moscow_counts = defaultdict(int)
monthly_counts = defaultdict(int)

person_stats = defaultdict(lambda: {"total": 0, "statuses": defaultdict(int), "mandays": 0.0})
overdue = []

active_statuses = {"待跟进", "已跟进", "已评审", "调研中", "开发中", "待测试", "测试中", "验收中"}
done_statuses = {"已上线", "测试完成"}
closed_statuses = {"已关闭", "挂起"}

for rec in records:
    f = rec.get("fields", {})
    status = get_select_name(f.get("需求状态"))
    priority = get_select_name(f.get("优先级"))
    biz = get_select_name(f.get("一级业务线"))
    biz2 = get_select_name(f.get("二级业务单元"))
    scale = get_select_name(f.get("需求规模"))
    moscow = get_select_name(f.get("迭代莫斯科"))
    name = f.get("需求名称", "(无名)")
    plan_date = f.get("计划上线日")
    actual_date = f.get("实际上线日")
    mandays = f.get("实际总人日")
    submit_ts = f.get("需求提出日")

    status_counts[status or "(空)"] += 1
    if priority: priority_counts[priority] += 1
    if biz: biz_counts[biz] += 1
    if biz2: biz2_counts[biz2] += 1
    if scale: scale_counts[scale] += 1
    if moscow: moscow_counts[moscow] += 1

    if submit_ts:
        month = ts_to_date(submit_ts)
        if month:
            monthly_counts[month[:7]] += 1

    main_r_uids = get_user_uids(f.get("主R"))
    for uid in main_r_uids:
        person_stats[uid]["total"] += 1
        person_stats[uid]["statuses"][status or "(空)"] += 1
        if mandays:
            try: person_stats[uid]["mandays"] += float(mandays)
            except: pass

    if plan_date and status and status in active_statuses:
        plan_str = ts_to_date(plan_date)
        if plan_str and plan_str < today:
            overdue.append({
                "name": name,
                "main_r": main_r_uids[0] if main_r_uids else "(未分配)",
                "plan_date": plan_str,
                "status": status,
                "priority": priority,
                "biz": biz,
            })

total = len(records)
active_count = sum(v for k, v in status_counts.items() if k in active_statuses)
done_count = sum(v for k, v in status_counts.items() if k in done_statuses)
closed_count = sum(v for k, v in status_counts.items() if k in closed_statuses)

output = {
    "report_date": today,
    "total_records": total,
    "summary": {
        "active": active_count,
        "done": done_count,
        "closed": closed_count,
        "other": total - active_count - done_count - closed_count,
    },
    "status_distribution": dict(sorted(status_counts.items(), key=lambda x: -x[1])),
    "priority_distribution": dict(sorted(priority_counts.items(), key=lambda x: -x[1])),
    "business_line_distribution": dict(sorted(biz_counts.items(), key=lambda x: -x[1])),
    "business_unit_distribution": dict(sorted(biz2_counts.items(), key=lambda x: -x[1])),
    "scale_distribution": dict(sorted(scale_counts.items(), key=lambda x: -x[1])),
    "moscow_distribution": dict(sorted(moscow_counts.items(), key=lambda x: -x[1])),
    "monthly_submission": dict(sorted(monthly_counts.items())),
    "top_owners_by_count": {k: {"total": v["total"], "done": v["statuses"].get("已上线", 0) + v["statuses"].get("测试完成", 0), "active": sum(v["statuses"].get(s, 0) for s in active_statuses), "mandays": round(v["mandays"], 1)} for k, v in sorted(person_stats.items(), key=lambda x: -x[1]["total"])[:30]},
    "overdue_count": len(overdue),
    "overdue_by_priority": sorted(overdue, key=lambda x: (x["priority"], x["plan_date"]))[:30],
}

with open(OUT, "w", encoding="utf-8") as fp:
    json.dump(output, fp, indent=2, ensure_ascii=False)
print(f"Done -> {OUT}", file=sys.stderr)
