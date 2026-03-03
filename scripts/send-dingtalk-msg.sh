#!/bin/bash
# 钉钉消息发送脚本
# 用法: ./send-dingtalk-msg.sh "消息内容" [userId]

APP_KEY="dingk81tbxkyy6lqmqcb"
APP_SECRET="tk--hEKMESH92ihaGDYFqh6nrAC79M9bZEPHhnKEDwVVn2yeYAVbu_g96uF2YweG"
DEFAULT_USER_ID="1446280924232650"

MSG="${1:-测试一下}"
USER_ID="${2:-$DEFAULT_USER_ID}"

# 1. 获取 access_token
TOKEN_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
  -H "Content-Type: application/json" \
  -d "{\"appKey\": \"$APP_KEY\", \"appSecret\": \"$APP_SECRET\"}")
ACCESS_TOKEN=$(echo $TOKEN_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Error: Failed to get access token"
  exit 1
fi

# 2. 发送文本消息
SEND_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend" \
  -H "Content-Type: application/json" \
  -H "x-acs-dingtalk-access-token: $ACCESS_TOKEN" \
  -d "{
    \"robotCode\": \"$APP_KEY\",
    \"msgKey\": \"sampleText\",
    \"msgParam\": \"{\\\"content\\\": \\\"$MSG\\\"}\",
    \"userIds\": [\"$USER_ID\"]
  }")

echo "$SEND_RESP"
