import subprocess, json
MCPORTER = r"C:\Users\Administrator\AppData\Roaming\npm\mcporter.cmd"
import os; os.chdir(r"d:\git-repos\VK-Cowork")

# Test with correct param: user_id_list as array
test_uids = ["54791452", "493495986", "170753131", "29249925", "40217584"]
args = json.dumps({"user_id_list": test_uids}, ensure_ascii=False)
r = subprocess.run(
    [MCPORTER, "call", "dingtalk-contacts", "get_user_info_by_user_ids", "--args", args, "--output", "json"],
    capture_output=True, timeout=30, encoding="utf-8", errors="replace"
)
with open("tmp_contacts_result2.json", "w", encoding="utf-8") as f:
    f.write(r.stdout or "null")

# Also test get_current_user_profile
r2 = subprocess.run(
    [MCPORTER, "call", "dingtalk-contacts", "get_current_user_profile", "--output", "json"],
    capture_output=True, timeout=30, encoding="utf-8", errors="replace"
)
with open("tmp_contacts_profile.json", "w", encoding="utf-8") as f:
    f.write(r2.stdout or "null")
print("Done")
