import { sendProactiveDingtalkMessage } from './src/electron/libs/dingtalk-bot.ts';

const result = await sendProactiveDingtalkMessage(
  'assistant-1772102257743',
  '测试一下',
  { targets: ['1446280924232650'] }
);
console.log(JSON.stringify(result, null, 2));
