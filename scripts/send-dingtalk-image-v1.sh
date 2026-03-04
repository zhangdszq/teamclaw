#!/bin/bash
# 钉钉图片发送脚本 - 使用 V1 API
# 用法: ./send-dingtalk-image-v1.sh "图片路径"

APP_KEY="dingk81tbxkyy6lqmqcb"
APP_SECRET="tk--hEKMESH92ihaGDYFqh6nrAC79M9bZEPHhnKEDwVVn2yeYAVbu_g96uF2YweG"
DEFAULT_USER_ID="1446280924232650"

IMAGE_PATH="${1:-/var/folders/mg/r31531yd7qz0b3x22ws1zm840000gn/T/vk-shot-compressed.jpg}"
USER_ID="${2:-$DEFAULT_USER_ID}"

# 1. 获取 V1 access_token (oapi.dingtalk.com)
TOKEN_RESP=$(curl -s "https://oapi.dingtalk.com/gettoken?appkey=$APP_KEY&appsecret=$APP_SECRET")
echo "Token response: $TOKEN_RESP"
ACCESS_TOKEN=$(echo $TOKEN_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Error: Failed to get access token"
  exit 1
fi

echo "Got access token: ${ACCESS_TOKEN:0:20}..."

# 2. 上传图片获取 media_id (V1 API)
UPLOAD_RESP=$(curl -s -X POST "https://oapi.dingtalk.com/media/upload?access_token=$ACCESS_TOKEN&type=image" \
  -H "Content-Type: multipart/form-data" \
  -F "media=@$IMAGE_PATH")

echo "Upload response: $UPLOAD_RESP"

MEDIA_ID=$(echo $UPLOAD_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('media_id',''))")

if [ -z "$MEDIA_ID" ]; then
  echo "Error: Failed to upload image"
  exit 1
fi

echo "Got media_id: $MEDIA_ID"

# 3. 发送图片消息 (V2 API)
# 先获取 V2 token
V2_TOKEN_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
  -H "Content-Type: application/json" \
  -d "{\"appKey\": \"$APP_KEY\", \"appSecret\": \"$APP_SECRET\"}")
V2_ACCESS_TOKEN=$(echo $V2_TOKEN_RESP | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")

echo "Got V2 access token: ${V2_ACCESS_TOKEN:0:20}..."

SEND_RESP=$(curl -s -X POST "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend" \
  -H "Content-Type: application/json" \
  -H "x-acs-dingtalk-access-token: $V2_ACCESS_TOKEN" \
  -d "{
    \"robotCode\": \"$APP_KEY\",
    \"msgKey\": \"sampleImageMsg\",
    \"msgParam\": \"{\\\"photoURL\\\": \\\"$MEDIA_ID\\\"}\",
    \"userIds\": [\"$USER_ID\"]
  }")

echo "Send response: $SEND_RESP"
