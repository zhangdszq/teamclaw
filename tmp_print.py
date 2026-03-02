import json, sys
sys.stdout.reconfigure(encoding='utf-8')
with open(r'd:\git-repos\VK-Cowork\tmp_march_v2_result.json', encoding='utf-8') as f:
    data = json.load(f)
for i, r in enumerate(data['records'], 1):
    src = '+'.join(r['matched_by'])
    plan = r['plan_date'] or '-'
    exp = r['expect_time'] or '-'
    pri = r['priority'][:2] if r['priority'] else '--'
    name = r['name'][:55]
    print(f"{i:2d}. [{pri}] [{r['status']}] {name}  plan={plan} expect={exp}  ({src})")
