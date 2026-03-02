import subprocess, json, sys, os
from datetime import datetime, timezone

MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
DENTRY = "YndMj49yWjPlp1QEFmjYYeDbJ3pmz5aA"
SHEET = "3NuAZfX"
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

print("Fetching...", file=sys.stderr)
records = fetch_all_records()
print(f"Total: {len(records)}", file=sys.stderr)

keyword = "韩国Dino"
matches = []
for rec in records:
    f = rec.get("fields", {})
    name = f.get("需求名称", "")
    if keyword in name or "Dino AI" in name and "韩国" in name:
        matches.append({
            "id": rec.get("id"),
            "name": name,
            "status": f.get("需求状态"),
            "priority": f.get("优先级"),
            "plan_date_raw": f.get("计划上线日"),
            "plan_date": ts_to_date(f.get("计划上线日")),
            "actual_date": ts_to_date(f.get("实际上线日")),
            "biz": f.get("一级业务线"),
            "expect_time": f.get("期望上线时间"),
            "progress": f.get("进度说明"),
        })

# Also search broader
keyword2 = "售卖及履约"
for rec in records:
    f = rec.get("fields", {})
    name = f.get("需求名称", "")
    if keyword2 in name:
        already = any(m["id"] == rec.get("id") for m in matches)
        if not already:
            matches.append({
                "id": rec.get("id"),
                "name": name,
                "status": f.get("需求状态"),
                "priority": f.get("优先级"),
                "plan_date_raw": f.get("计划上线日"),
                "plan_date": ts_to_date(f.get("计划上线日")),
                "actual_date": ts_to_date(f.get("实际上线日")),
                "biz": f.get("一级业务线"),
                "expect_time": f.get("期望上线时间"),
                "progress": f.get("进度说明"),
            })

with open("tmp_find_result.json", "w", encoding="utf-8") as fp:
    json.dump(matches, fp, indent=2, ensure_ascii=False)
print(f"Found: {len(matches)} matches", file=sys.stderr)
