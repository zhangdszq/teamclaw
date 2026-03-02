import subprocess, json, sys, os

MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
OUT = r"d:\git-repos\VK-Cowork\tmp_result.json"

def call_mcp(tool, args):
    args_json = json.dumps(args, ensure_ascii=False)
    cmd = [MCPORTER, "call", "dingtalk-ai-table", tool, "--args", args_json, "--output", "json"]
    r = subprocess.run(cmd, capture_output=True, timeout=30, encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout) if r.stdout else None
    except:
        return {"_raw": (r.stdout or "")[:500]}

uuid = "YndMj49yWjPlp1QEFmjYYeDbJ3pmz5aA"
results = {}

results["list_base_tables"] = call_mcp("list_base_tables", {"dentryUuid": uuid})
results["list_base_field"] = call_mcp("list_base_field", {"dentryUuid": uuid, "sheetIdOrName": "3NuAZfX"})
results["search_base_record"] = call_mcp("search_base_record", {"dentryUuid": uuid, "sheetIdOrName": "3NuAZfX"})

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print("Done -> " + OUT)
