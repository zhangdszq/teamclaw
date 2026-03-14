import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/mock/user-data",
  },
}));

import { chineseBigrams, extractTriggerPhrases, findBestSkillMatch, type SkillMatchCandidate } from "../../../shared/skill-matcher.js";
import {
  applyAssistantContextToPrompt,
  buildAvailableSkillsSection,
  buildActivatedSkillSection,
  parseSkillMarkdownMetadata,
  partitionInstalledSkillNames,
  resolveSkillCommand,
  resolveSkillPromptContext,
} from "../skill-context.js";

const assistantSkills: SkillMatchCandidate[] = [
  {
    name: "aliyun-sms-bulk",
    label: "阿里云短信",
    description: "使用阿里云 MCP 短信服务发送单条或批量群发短信。当用户需要“发短信”、“群发短信”时触发。",
  },
  {
    name: "adjust-report",
    label: "Adjust 归因分析",
    description: "拉取 Adjust Report API 数据并生成归因分析洞见。支持 SKAN、投放效果、广告渠道对比、Campaign 漏斗分析。",
  },
  {
    name: "dingtalk-docs",
    label: "钉钉文档",
    description: "管理钉钉云文档中的文档、文件夹和内容，适用于创建文档、搜索文档、读取或写入文档内容。",
  },
  {
    name: "dingtalk-ai-table",
    label: "钉钉 AI 表格",
    description: "钉钉 AI 表格（多维表）操作技能，支持读取表结构、批量增删改记录、按模板建表。",
  },
  {
    name: "vipkid-ops",
    label: "VIPKID 运营后台",
    description: "支持商品包查询、新建、修改。用户说「查商品包」「新建课包」「配置库存」时触发。",
  },
];

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

    expect(prompt).not.toContain("/aliyun-sms-bulk");
    expect(prompt).toContain("## 可用技能");
    expect(prompt).toContain("## 当前激活技能");
    expect(prompt).toContain("如果你判断此技能与用户意图不符");
    expect(prompt).toContain("阿里云短信技能");
    expect(prompt).toContain("发短信给用户");
  });

  it("lists available skills without slash prefix when no content is activated", () => {
    const installedSkills = new Map([
      ["aliyun-sms-bulk", { name: "aliyun-sms-bulk", label: "阿里云短信", description: "发送短信通知" }],
      ["adjust-report", { name: "adjust-report", label: "Adjust 归因分析", description: "拉取 Adjust 数据" }],
    ]);

    const prompt = applyAssistantContextToPrompt("帮我拉取数据", {
      skillNames: ["aliyun-sms-bulk", "adjust-report"],
    });
    const section = buildAvailableSkillsSection(["aliyun-sms-bulk", "adjust-report"], installedSkills);

    expect(prompt).toContain("## 可用技能");
    expect(prompt).toContain("aliyun-sms-bulk");
    expect(prompt).toContain("adjust-report");
    expect(prompt).not.toContain("/aliyun-sms-bulk");
    expect(section).toContain("阿里云短信");
    expect(section).toContain("拉取 Adjust 数据");
  });

  it("omits missing skills from the available skills section", () => {
    const installedSkills = new Map([
      ["adjust-report", { name: "adjust-report", label: "Adjust 归因分析", description: "拉取 Adjust 数据" }],
    ]);

    const section = buildAvailableSkillsSection(["adjust-report", "missing-skill"], installedSkills);

    expect(section).toContain("adjust-report");
    expect(section).not.toContain("missing-skill");
  });

  it("auto-activates the best matching skill for plain prompts", () => {
    const installedSkills = new Map([
      ["aliyun-sms-bulk", { name: "aliyun-sms-bulk", label: "阿里云短信", description: "发送短信通知" }],
      ["adjust-report", { name: "adjust-report", label: "Adjust 归因分析", description: "拉取 Adjust 数据并做归因分析" }],
    ]);

    const result = resolveSkillPromptContext(
      "帮我看一下 adjust 渠道归因数据",
      ["aliyun-sms-bulk", "adjust-report"],
      {
        installedSkills,
        contentLoader: (skillName) => `# ${skillName}`,
      },
    );

    expect(result?.skillName).toBe("adjust-report");
    expect(result?.skillContent).toContain("adjust-report");
    expect(result?.userText).toBe("帮我看一下 adjust 渠道归因数据");
  });

  it("prefers assistant skills before falling back to global discovery candidates", () => {
    const installedSkills = new Map([
      ["find-skills", {
        name: "find-skills",
        label: "技能发现助手",
        description: "帮助用户发现和安装技能，适合用户询问如何完成某件事或寻找特定功能时使用。",
      }],
      ["agent-reach", {
        name: "agent-reach",
        label: "Agent Reach",
        description: "Use the internet to search Bilibili、小红书、抖音、YouTube、Twitter/X and the wider web. Triggers: \"B站\", \"bilibili\", \"搜一下\", \"帮我查\", \"全网搜索\".",
      }],
    ]);

    const result = resolveSkillPromptContext(
      "帮我搜索 B 站海外投放视频",
      ["find-skills", "agent-reach"],
      {
        prioritizedSkillNames: ["find-skills"],
        installedSkills,
        contentLoader: (skillName) => `# ${skillName}`,
      },
    );

    expect(result?.skillName).toBe("agent-reach");
    expect(result?.skillContent).toContain("agent-reach");
  });

  it("parses YAML multiline descriptions from skill markdown", () => {
    const literal = parseSkillMarkdownMetadata(`---
name: adjust-report
description: |
  拉取 Adjust Report API 数据并生成归因分析洞见。
  支持 SKAN（iOS）和标准指标（Android）。
---

# Adjust Report 数据分析
`, "fallback-skill");

    const folded = parseSkillMarkdownMetadata(`---
name: vipkid-ops
description: >
  支持商品包查询、新建、修改。
  用户说「查商品包」「新建课包」时触发。
version: 0.1.0
---

# VIPKID 运营后台
`, "fallback-skill");

    expect(literal.label).toBe("adjust-report");
    expect(literal.description).toContain("拉取 Adjust Report API 数据并生成归因分析洞见。");
    expect(literal.description).toContain("支持 SKAN（iOS）和标准指标（Android）。");
    expect(folded.label).toBe("vipkid-ops");
    expect(folded.description).toBe("支持商品包查询、新建、修改。 用户说「查商品包」「新建课包」时触发。");
  });

  it("extracts trigger phrases from mixed quote styles", () => {
    const phrases = extractTriggerPhrases(
      `当用户需要"发短信"、'群发短信'、「短信通知」、『批量发送』时触发。`,
    );

    expect(phrases).toEqual(["发短信", "群发短信", "短信通知", "批量发送"]);
  });

  it("builds Chinese bigrams for fuzzy matching", () => {
    expect([...chineseBigrams("归因分析")]).toEqual(["归因", "因分", "分析"]);
  });

  it("matches real prompts more robustly", () => {
    const cases: Array<{ prompt: string; expected: string | null }> = [
      { prompt: "帮我看一下最近的归因数据", expected: "adjust-report" },
      { prompt: "拉取 Adjust 最近一周的 Android 数据", expected: "adjust-report" },
      { prompt: "帮我发一条短信给用户", expected: "aliyun-sms-bulk" },
      { prompt: "帮我查一下钉钉上的文档", expected: "dingtalk-docs" },
      { prompt: "帮我在多维表里新建一条记录", expected: "dingtalk-ai-table" },
      { prompt: "帮我分析一下最近的投放效果", expected: "adjust-report" },
      { prompt: "帮我看看 SKAN 的转化率", expected: "adjust-report" },
      { prompt: "这个月的广告渠道对比", expected: "adjust-report" },
      { prompt: "查一下商品包", expected: "vipkid-ops" },
      { prompt: "帮我新建课包", expected: "vipkid-ops" },
      { prompt: "你好", expected: null },
    ];

    for (const { prompt, expected } of cases) {
      const match = findBestSkillMatch(prompt, assistantSkills);
      expect(match?.name ?? null).toBe(expected);
    }
  });

  it("does not auto-match a single skill below the threshold", () => {
    const match = findBestSkillMatch("你好", [assistantSkills[1]]);
    expect(match).toBeNull();
  });

  it("avoids weak ambiguous auto-matches when multiple skills tie", () => {
    const match = findBestSkillMatch("帮我看数据", [
      { name: "sales-report", label: "销售报告", description: "查看销售数据" },
      { name: "ops-report", label: "运营报告", description: "查看运营数据" },
    ]);

    expect(match).toBeNull();
  });

  it("reuses the preferred skill on ambiguous follow-up prompts", () => {
    const result = resolveSkillPromptContext(
      "继续",
      ["aliyun-sms-bulk", "adjust-report"],
      {
        preferredSkillName: "adjust-report",
        contentLoader: (skillName) => `# ${skillName}`,
      },
    );

    expect(result?.skillName).toBe("adjust-report");
  });

  it("skips auto activation when disabled", () => {
    const result = resolveSkillPromptContext(
      "帮我看看最近数据",
      ["adjust-report"],
      {
        autoActivate: false,
        contentLoader: () => "# adjust-report",
      },
    );

    expect(result).toBeNull();
  });

  it("matches Chinese prompts against English SKILL.md when enriched with catalog", () => {
    const salesSkills: SkillMatchCandidate[] = [
      {
        name: "megaview-openapi",
        label: "Megaview 销售分析",
        description: "基于 Megaview + StarRocks 的销售能力分析工具。支持员工绩效对比、会话评分、GMV 对比、辅导材料生成、绩效考核优先级排序，为销售管理提供数据驱动的决策支持。",
        triggers: ["megaview", "sales", "analysis", "gmv", "coaching", "starrocks"],
      },
      {
        name: "dingtalk-docs",
        label: "钉钉文档操作",
        description: "管理钉钉云文档中的文档、文件夹和内容。",
        triggers: ["dingtalk", "document"],
      },
      {
        name: "operate-coding-tools",
        label: "操控编程工具",
        description: "",
      },
    ];

    const cases: Array<{ prompt: string; expected: string | null }> = [
      { prompt: "员工表现", expected: "megaview-openapi" },
      { prompt: "Rama Nemer 辅导建议", expected: "megaview-openapi" },
      { prompt: "按GMV倒数排名", expected: "megaview-openapi" },
      { prompt: "帮我看一下销售数据", expected: "megaview-openapi" },
      { prompt: "Amir 的能力分析", expected: "megaview-openapi" },
      { prompt: "帮我查钉钉文档", expected: "dingtalk-docs" },
      { prompt: "你好", expected: null },
      { prompt: "本月", expected: null },
      { prompt: "继续", expected: null },
    ];

    for (const { prompt, expected } of cases) {
      const match = findBestSkillMatch(prompt, salesSkills);
      expect(match?.name ?? null, `prompt: "${prompt}"`).toBe(expected);
    }
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

  it("partitions configured skill names into available and missing lists", () => {
    const installedSkills = new Map([
      ["adjust-report", { name: "adjust-report", label: "Adjust 归因分析", description: "拉取 Adjust 数据" }],
    ]);

    expect(partitionInstalledSkillNames(["adjust-report", "missing-skill"], installedSkills)).toEqual({
      availableSkillNames: ["adjust-report"],
      missingSkillNames: ["missing-skill"],
    });
  });
});
