#!/bin/bash
# 钉钉图片发送脚本
# 用法: ./send-dingtalk-image.sh "图片路径"

APP_KEY="dingk81tbxkyy6lqmqcb"
APP_SECRET="tk--hEKMESH92ihaGDYFqh6nrAC79M9bZEPHhnKEDwVVn2yeYAVbu_g96uF2YweG"
DEFAULT_USER_ID="1446280924232650"

IMAGE_PATH="${1:-/var/folders/mg/r31531yd7qz0b3x22ws1zm840000gn/T/vk-shot-1772607096271.png}"
USER_ID="${2:-$DEFAULT_USER_ID}"

# 1. 获取 access_token
TOKEN_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
  -H "Content-Type: application/json" \
  -d "{\"appKey\": \"$APP_KEY\", \"appSecret\": \"$APP_SECRET\"}")
ACCESS_TOKEN=$(echo $TOKEN_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Error: Failed to get access token"
  echo "$TOKEN_RESP"
  exit 1
fi

echo "Got access token: ${ACCESS_TOKEN:0:20}..."

# 2. 上传图片获取 media_id
UPLOAD_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/robot/uploadMedia" \
  -H "Content-Type: multipart/form-data" \
  -H "x-acs-dingtalk-access-token: $ACCESS_TOKEN" \
  -F "file=@$IMAGE_PATH;type=image/png")

echo "Upload response: $UPLOAD_RESP"

MEDIA_ID=$(echo $UPLOAD_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('mediaId',''))")

if [ -z "$MEDIA_ID" ]; then
  echo "Error: Failed to upload image"
  exit 1
fi

echo "Got media_id: $MEDIA_ID"

# 3. 发送图片消息
SEND_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend" \
  -H "Content-Type: application/json" \
  -H "x-acs-dingtalk-access-token: $ACCESS_TOKEN" \
  -d "{
    \"robotCode\": \"$APP_KEY\",
    \"msgKey\": \"sampleImageMsg\",
    \"msgParam\": \"{\\\"photoURL\\\": \\\"$MEDIA_ID\\\"}\",
    \"userIds\": [\"$USER_ID\"]
  }")

echo "Send response: $SEND_RESP"
