/**
 * Codex bug verification script
 * Uses @openai/codex-sdk to check if bugs are truly fixed
 */
import { Codex } from "@openai/codex-sdk";
import { homedir } from "os";

const VK_COWORK_PATH = "/Users/zhang/git-repos/VK-Cowork";

async function main() {
  const codex = new Codex({});

  // First bug to check
  const bugInfo = {
    recordId: "1iEuJc5JUn",
    title: "已修复: Bot 模块错误静默(钉钉/飞书)",
    description: "现象：多处使用空 catch 块吞掉错误。用户可见表现：消息发送失败时完全无提示。",
    fixCommit: "cfac5e1",
    fixDescription: "替换所有空 catch 块为警告日志"
  };

  const prompt = `你是代码审查专家。请验证 VK-Cowork 项目中的以下 bug 是否已真正修复：

Bug 标题: ${bugInfo.title}
Bug 现象: ${bugInfo.description}
修复描述: ${bugInfo.fixDescription}
修复 commit: ${bugInfo.fixCommit}

请执行以下步骤：
1. 检查 git log 确认 commit ${bugInfo.fixCommit} 是否存在于代码库中
2. 检查该 commit 的修改内容
3. 搜索当前代码库是否还存在空 catch 块（.catch(() => {}) 或 .catch(function() {}) 等模式）
4. 检查钉钉/飞书 bot 相关文件中是否仍有错误被静默的情况

请给出详细的验证结果，包括：
- 该 commit 是否存在
- 修复内容是什么
- 当前代码是否还存在类似问题
- 最终结论：bug 是否真正修复

工作目录: ${VK_COWORK_PATH}`;

  const thread = codex.startThread({
    model: "gpt-5.3-codex",
    workingDirectory: VK_COWORK_PATH,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  });

  console.log("Running codex check for bug:", bugInfo.title);
  console.log("Using model: gpt-5.3-codex");
  console.log("---");

  const { events } = await thread.runStreamed(prompt, {});

  let fullResponse = "";
  for await (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item.type === "agent_message" &&
      event.item.text
    ) {
      fullResponse += event.item.text;
    } else if (event.type === "item.started" && event.item.type === "command_execution") {
      console.log(`[Codex] Running: ${event.item.command}`);
    } else if (event.type === "item.completed" && event.item.type === "command_execution") {
      const output = event.item.aggregated_output || "";
      if (output.length > 500) {
        console.log(`[Codex] Result: ${output.substring(0, 500)}...`);
      } else if (output) {
        console.log(`[Codex] Result: ${output}`);
      }
    }
  }

  console.log("\n=== Final Response ===");
  console.log(fullResponse || "No response generated");
}

main().catch(console.error);
