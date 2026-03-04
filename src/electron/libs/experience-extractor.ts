import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeCodeEnv } from './claude-settings.js';
import { claudeCodePath, enhancedEnv } from './util.js';

const MAX_DIGEST_CHARS = 6000;

export interface AIExtractionResult {
  title: string;
  scenario: string;
  steps: string;
  result: string;
  risk: string;
}

export function buildConversationDigest(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.type === 'assistant' ? 'A' : msg.type === 'human' ? 'U' : null;
    if (!role) continue;
    const contentArr = msg.message?.content;
    if (!Array.isArray(contentArr)) continue;
    const text = contentArr
      .filter((c: any) => c.type === 'text')
      .map((c: any) => String(c.text))
      .join('\n')
      .trim();
    if (!text) continue;
    parts.push(`[${role}] ${text}`);
  }
  const full = parts.join('\n---\n');
  if (full.length <= MAX_DIGEST_CHARS) return full;
  const half = Math.floor(MAX_DIGEST_CHARS / 2);
  return full.slice(0, half) + '\n...[中间部分省略]...\n' + full.slice(-half);
}

export async function extractExperienceViaAI(
  conversationText: string,
  sessionTitle: string,
): Promise<AIExtractionResult | null> {
  const prompt = `你是一个经验抽取助手。分析以下对话，提取一条结构化经验记录。
经验记录应该是可复用的——当未来遇到类似场景时，这条记录能帮助快速解决问题。

会话标题：${sessionTitle}

对话内容：
${conversationText}

请严格按以下 JSON 格式输出（不要输出其他内容）：
{
  "title": "简洁的经验标题（动词+对象，如'配置SMB文件服务器连接'，不超过30字）",
  "scenario": "什么场景下需要这个经验（描述触发条件和上下文，2-3句话）",
  "steps": "关键步骤（每步一行，用数字序号，只保留核心步骤，不超过8步）",
  "result": "最终结果和解决方案（1-3句话的总结）",
  "risk": "注意事项和潜在风险（如果没有明显风险可以写'无'）"
}`;

  const result: SDKResultMessage = await unstable_v2_prompt(prompt, {
    model: claudeCodeEnv.ANTHROPIC_MODEL,
    env: enhancedEnv,
    pathToClaudeCodeExecutable: claudeCodePath,
  });

  if (result.subtype !== 'success' || !result.result) return null;

  let text = result.result.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) text = objMatch[0];

  try {
    const parsed = JSON.parse(text);
    if (!parsed.title || !parsed.scenario) return null;
    return {
      title: String(parsed.title).slice(0, 100),
      scenario: String(parsed.scenario).slice(0, 500),
      steps: String(parsed.steps || '').slice(0, 2000),
      result: String(parsed.result || '').slice(0, 2000),
      risk: String(parsed.risk || '待人工审核').slice(0, 500),
    };
  } catch {
    console.warn('[ExperienceExtractor] Failed to parse AI extraction result');
    return null;
  }
}
