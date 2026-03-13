import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/mock/user-data",
  },
}));

import {
  applyAssistantContextToPrompt,
  buildActivatedSkillSection,
  resolveSkillCommand,
} from "../skill-context.js";

describe("skill-context helpers", () => {
  it("resolves an explicit slash skill command", () => {
    const result = resolveSkillCommand(
      "/aliyun-sms-bulk 发短信给 15210231787，内容是你好 测试",
      ["aliyun-sms-bulk", "adjust-report"],
      (skillName) => (skillName === "aliyun-sms-bulk" ? "# 阿里云短信技能" : null),
    );

    expect(result).not.toBeNull();
    expect(result?.skillName).toBe("aliyun-sms-bulk");
    expect(result?.skillContent).toContain("阿里云短信技能");
    expect(result?.userText).toBe("发短信给 15210231787，内容是你好 测试");
  });

  it("supports bare slash invocation without arguments", () => {
    const result = resolveSkillCommand(
      "/aliyun-sms-bulk",
      ["aliyun-sms-bulk"],
      () => "# 阿里云短信技能",
    );

    expect(result?.userText).toBe("请执行技能 aliyun-sms-bulk");
  });

  it("injects the activated skill section into assistant context", () => {
    const prompt = applyAssistantContextToPrompt("发短信给用户", {
      skillNames: ["aliyun-sms-bulk"],
      activatedSkillContent: "# 阿里云短信技能",
    });

    expect(prompt).toContain("/aliyun-sms-bulk");
    expect(prompt).toContain("## 当前激活技能");
    expect(prompt).toContain("阿里云短信技能");
    expect(prompt).toContain("发短信给用户");
  });

  it("adds auth warning when referenced MCP server needs OAuth", () => {
    const section = buildActivatedSkillSection(
      "MCP 服务器 `mcp_sms` 已预装配置。\n直接调用 `mcp_sms` 服务器上的 MCP 工具即可发送短信。",
      { authNeededServers: ["mcp_sms"] },
    );

    expect(section).toContain("## MCP 认证状态");
    expect(section).toContain("`mcp_sms`");
    expect(section).toContain("OAuth");
    expect(section).toContain("不要误判为工具不存在");
  });
});
