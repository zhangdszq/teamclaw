import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface BotConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistantName: string;
  skillNames?: string[];
  provider?: "claude" | "openai";
  model?: string;
  defaultCwd?: string;
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  userContext?: string;
  initialBots: Partial<Record<BotPlatformType, BotPlatformConfig>>;
  onSave: (bots: Partial<Record<BotPlatformType, BotPlatformConfig>>) => void;
}

type PlatformId = BotPlatformType;

interface PlatformMeta {
  id: PlatformId;
  name: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}

const PLATFORMS: PlatformMeta[] = [
  {
    id: "telegram",
    name: "Telegram",
    description: "通过 @BotFather 创建 Bot 并获取 Token",
    color: "#2AABEE",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.14 13.28l-2.99-.935c-.65-.204-.664-.65.136-.961l11.671-4.5c.543-.196 1.017.13.937.337z" />
      </svg>
    ),
  },
  {
    id: "feishu",
    name: "飞书",
    description: "在飞书开放平台创建应用并获取凭证",
    color: "#00B3F0",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3C7 3 3 7 3 12s4 9 9 9 9-4 9-9-4-9-9-9z" fill="currentColor" stroke="none" opacity="0.15"/>
        <path d="M8 11l3 3 5-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "wecom",
    name: "企业微信",
    description: "在企业微信管理后台创建自建应用",
    color: "#2AA515",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M16.5 9.5a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm-4-2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm-6 8c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v1H6.5v-1z" />
      </svg>
    ),
  },
  {
    id: "discord",
    name: "Discord",
    description: "在 Discord Developer Portal 创建 Bot 应用",
    color: "#5865F2",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
      </svg>
    ),
  },
  {
    id: "dingtalk",
    name: "钉钉",
    description: "在钉钉开发者后台创建机器人应用",
    color: "#1677FF",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.5 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 17c-2.21 0-4-1.34-4-3h8c0 1.66-1.79 3-4 3z" />
      </svg>
    ),
  },
  {
    id: "qqbot",
    name: "QQ",
    description: "在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret",
    color: "#12B7F5",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c2.03 0 3.67 1.91 3.67 4.26 0 .64-.12 1.24-.34 1.79C16.9 11.7 18 13.26 18 14.5c0 .62-.2 1.25-.56 1.77.13.42.37 1.06.37 1.48 0 .55-.3.75-.75.75-.26 0-.53-.08-.82-.23a7.1 7.1 0 01-4.24 1.48c-1.57 0-3.04-.53-4.24-1.48-.29.15-.56.23-.82.23-.45 0-.75-.2-.75-.75 0-.42.24-1.06.37-1.48A3.1 3.1 0 016 14.5c0-1.24 1.1-2.8 2.67-3.45a5.1 5.1 0 01-.34-1.79C8.33 6.91 9.97 5 12 5z" />
      </svg>
    ),
  },
  {
    id: "weixin",
    name: "微信",
    description: "通过扫码登录接入微信账号，并使用该账号收发私聊消息",
    color: "#07C160",
    icon: (
      <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
        <path d="M8.7 5.4c-3.15 0-5.7 2.22-5.7 4.96 0 1.57.85 2.97 2.17 3.89L4.42 17l2.86-1.44c.46.08.93.12 1.42.12 3.15 0 5.7-2.22 5.7-4.96S11.85 5.4 8.7 5.4zm-2.1 4.2a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm4.2 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm5.08 1.14c-2.81 0-5.08 1.98-5.08 4.43 0 .42.07.83.2 1.22L10 18.6l2.19-.88c.52.16 1.08.25 1.69.25 2.81 0 5.08-1.98 5.08-4.43s-2.27-4.43-5.08-4.43zm-1.9 2.66a.62.62 0 1 1 0 1.24.62.62 0 0 1 0-1.24zm3.8 0a.62.62 0 1 1 0 1.24.62.62 0 0 1 0-1.24z" />
      </svg>
    ),
  },
];

type FormState = {
  telegram: {
    token: string;
    proxy: string;
    dmPolicy: "open" | "allowlist";
    groupPolicy: "open" | "allowlist";
    allowFrom: string;
    requireMention: boolean;
    ownerUserIds: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark" | string;
    connectionMode: "websocket" | "webhook";
    webhookPort: string;
    dmPolicy: "open" | "allowlist" | "pairing";
    groupPolicy: "open" | "allowlist" | "disabled";
    allowFrom: string;
    requireMention: boolean;
    renderMode: "auto" | "raw" | "card";
    ownerOpenIds: string;
  };
  wecom: { corpId: string; agentId: string; secret: string };
  discord: { token: string };
  dingtalk: {
    appKey: string;
    appSecret: string;
    robotCode: string;
    messageType: "markdown" | "card";
    cardTemplateId: string;
    cardTemplateKey: string;
    dmPolicy: "open" | "allowlist";
    groupPolicy: "open" | "allowlist";
    allowFrom: string;
    ownerStaffIds: string;
    maxConnectionAttempts: string;
  };
  qqbot: {
    appId: string;
    clientSecret: string;
    dmPolicy: "open" | "allowlist";
    groupPolicy: "open" | "allowlist";
    allowFrom: string;
    ownerOpenIds: string;
  };
  weixin: {
    accountId: string;
    dmPolicy: "open" | "allowlist";
    allowFrom: string;
    ownerUserIds: string;
    mediaEnabled: boolean;
  };
};

function buildDefaultForm(): FormState {
  return {
    telegram: { token: "", proxy: "", dmPolicy: "open", groupPolicy: "open", allowFrom: "", requireMention: true, ownerUserIds: "" },
    feishu: { appId: "", appSecret: "", domain: "feishu", connectionMode: "websocket", webhookPort: "3000", dmPolicy: "open", groupPolicy: "open", allowFrom: "", requireMention: true, renderMode: "auto", ownerOpenIds: "" },
    wecom: { corpId: "", agentId: "", secret: "" },
    discord: { token: "" },
    dingtalk: {
      appKey: "",
      appSecret: "",
      robotCode: "",
      messageType: "markdown",
      cardTemplateId: "",
      cardTemplateKey: "content",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: "",
      ownerStaffIds: "",
      maxConnectionAttempts: "10",
    },
    qqbot: {
      appId: "",
      clientSecret: "",
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: "",
      ownerOpenIds: "",
    },
    weixin: {
      accountId: "",
      dmPolicy: "open",
      allowFrom: "",
      ownerUserIds: "",
      mediaEnabled: true,
    },
  };
}

function botsToForm(bots: Partial<Record<BotPlatformType, BotPlatformConfig>>): FormState {
  const form = buildDefaultForm();
  const t = bots.telegram as any;
  if (t) {
    form.telegram = {
      token: t.token ?? "",
      proxy: t.proxy ?? "",
      dmPolicy: t.dmPolicy ?? "open",
      groupPolicy: t.groupPolicy ?? "open",
      allowFrom: (t.allowFrom ?? []).join(","),
      requireMention: t.requireMention ?? true,
      ownerUserIds: (t.ownerUserIds ?? []).join(","),
    };
  }
  const f = bots.feishu as any;
  if (f) {
    form.feishu = {
      appId: f.appId ?? "",
      appSecret: f.appSecret ?? "",
      domain: f.domain ?? "feishu",
      connectionMode: f.connectionMode ?? "websocket",
      webhookPort: String(f.webhookPort ?? "3000"),
      dmPolicy: f.dmPolicy ?? "open",
      groupPolicy: f.groupPolicy ?? "open",
      allowFrom: (f.allowFrom ?? []).join(","),
      requireMention: f.requireMention ?? true,
      renderMode: f.renderMode ?? "auto",
      ownerOpenIds: (f.ownerOpenIds ?? []).join(","),
    };
  }
  const w = bots.wecom as any;
  if (w) {
    form.wecom = { corpId: w.corpId ?? "", agentId: w.agentId ?? "", secret: w.secret ?? "" };
  }
  const d = bots.discord as any;
  if (d) {
    form.discord = { token: d.token ?? "" };
  }
  const dt = bots.dingtalk as any;
  if (dt) {
    form.dingtalk = {
      appKey: dt.appKey ?? "",
      appSecret: dt.appSecret ?? "",
      robotCode: dt.robotCode ?? "",
      messageType: dt.messageType ?? "markdown",
      cardTemplateId: dt.cardTemplateId ?? "",
      cardTemplateKey: dt.cardTemplateKey ?? "content",
      dmPolicy: dt.dmPolicy ?? "open",
      groupPolicy: dt.groupPolicy ?? "open",
      allowFrom: (dt.allowFrom ?? []).join(","),
      ownerStaffIds: (dt.ownerStaffIds ?? []).join(","),
      maxConnectionAttempts: String(dt.maxConnectionAttempts ?? 10),
    };
  }
  const qq = bots.qqbot as any;
  if (qq) {
    form.qqbot = {
      appId: qq.appId ?? "",
      clientSecret: qq.clientSecret ?? "",
      dmPolicy: qq.dmPolicy ?? "open",
      groupPolicy: qq.groupPolicy ?? "open",
      allowFrom: (qq.allowFrom ?? []).join(","),
      ownerOpenIds: (qq.ownerOpenIds ?? []).join(","),
    };
  }
  const wx = bots.weixin as any;
  if (wx) {
    form.weixin = {
      accountId: wx.accountId ?? "",
      dmPolicy: wx.dmPolicy ?? "open",
      allowFrom: (wx.allowFrom ?? []).join(","),
      ownerUserIds: (wx.ownerUserIds ?? []).join(","),
      mediaEnabled: wx.mediaEnabled !== false,
    };
  }
  return form;
}

function formToPlatformConfig(
  platform: PlatformId,
  form: FormState,
  connected: boolean
): BotPlatformConfig {
  if (platform === "telegram") {
    return {
      platform: "telegram",
      token: form.telegram.token,
      proxy: form.telegram.proxy || undefined,
      dmPolicy: form.telegram.dmPolicy,
      groupPolicy: form.telegram.groupPolicy,
      allowFrom: form.telegram.allowFrom
        ? form.telegram.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      requireMention: form.telegram.requireMention,
      ownerUserIds: form.telegram.ownerUserIds
        ? form.telegram.ownerUserIds.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      connected,
    };
  }
  if (platform === "feishu") {
    return {
      platform: "feishu",
      appId: form.feishu.appId,
      appSecret: form.feishu.appSecret,
      domain: form.feishu.domain,
      connectionMode: form.feishu.connectionMode,
      webhookPort: form.feishu.connectionMode === "webhook" ? parseInt(form.feishu.webhookPort, 10) || 3000 : undefined,
      dmPolicy: form.feishu.dmPolicy,
      groupPolicy: form.feishu.groupPolicy,
      allowFrom: form.feishu.allowFrom ? form.feishu.allowFrom.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
      requireMention: form.feishu.requireMention,
      renderMode: form.feishu.renderMode,
      ownerOpenIds: form.feishu.ownerOpenIds ? form.feishu.ownerOpenIds.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
      connected,
    };
  }
  if (platform === "wecom") {
    return { platform: "wecom", corpId: form.wecom.corpId, agentId: form.wecom.agentId, secret: form.wecom.secret, connected };
  }
  if (platform === "discord") {
    return { platform: "discord", token: form.discord.token, connected };
  }
  if (platform === "qqbot") {
    return {
      platform: "qqbot",
      appId: form.qqbot.appId,
      clientSecret: form.qqbot.clientSecret,
      dmPolicy: form.qqbot.dmPolicy,
      groupPolicy: form.qqbot.groupPolicy,
      allowFrom: form.qqbot.allowFrom
        ? form.qqbot.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      ownerOpenIds: form.qqbot.ownerOpenIds
        ? form.qqbot.ownerOpenIds.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      connected,
    };
  }
  if (platform === "weixin") {
    return {
      platform: "weixin",
      accountId: form.weixin.accountId,
      dmPolicy: form.weixin.dmPolicy,
      allowFrom: form.weixin.allowFrom
        ? form.weixin.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      ownerUserIds: form.weixin.ownerUserIds
        ? form.weixin.ownerUserIds.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      mediaEnabled: form.weixin.mediaEnabled,
      connected,
    };
  }
  return {
    platform: "dingtalk",
    appKey: form.dingtalk.appKey,
    appSecret: form.dingtalk.appSecret,
    robotCode: form.dingtalk.robotCode || undefined,
    messageType: form.dingtalk.messageType,
    cardTemplateId: form.dingtalk.cardTemplateId || undefined,
    cardTemplateKey: form.dingtalk.cardTemplateKey || undefined,
    dmPolicy: form.dingtalk.dmPolicy,
    groupPolicy: form.dingtalk.groupPolicy,
    allowFrom: form.dingtalk.allowFrom
      ? form.dingtalk.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    ownerStaffIds: form.dingtalk.ownerStaffIds
      ? form.dingtalk.ownerStaffIds.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    maxConnectionAttempts: parseInt(form.dingtalk.maxConnectionAttempts, 10) || undefined,
    connected,
  };
}

const INPUT_CLASS =
  "w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-3.5 py-2 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors";

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">
        {label}
        {hint && <span className="font-normal text-muted-light ml-1">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

// Platform-specific status indicator
type DingtalkStatus = DingtalkBotStatus | null;
type FeishuStatus = FeishuBotStatus | null;
type TgStatus = TelegramBotStatus | null;
type WeixinStatus = WeixinBotStatus | null;

type WeixinAccount = {
  accountId: string;
  userId: string;
  name: string;
  baseUrl: string;
  cdnBaseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  lastLoginAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export function BotConfigModal({
  open,
  onOpenChange,
  assistantName,
  skillNames,
  assistantId,
  provider,
  model,
  defaultCwd,
  persona,
  coreValues,
  relationship,
  cognitiveStyle,
  operatingGuidelines,
  userContext,
  initialBots,
  onSave,
}: BotConfigModalProps & { assistantId: string }) {
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId>("telegram");
  const [bots, setBots] = useState<Partial<Record<BotPlatformType, BotPlatformConfig>>>(initialBots);
  const [form, setForm] = useState<FormState>(buildDefaultForm());
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dingtalkStatus, setDingtalkStatus] = useState<DingtalkStatus>(null);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>(null);
  const [telegramStatus, setTelegramStatus] = useState<TgStatus>(null);
  const [qqbotStatus, setQqbotStatus] = useState<QQBotStatus | null>(null);
  const [weixinStatus, setWeixinStatus] = useState<WeixinStatus>(null);
  const [weixinAccounts, setWeixinAccounts] = useState<WeixinAccount[]>([]);
  const [weixinQrSessionId, setWeixinQrSessionId] = useState<string | null>(null);
  const [weixinQrImage, setWeixinQrImage] = useState<string>("");
  const [weixinQrStatus, setWeixinQrStatus] = useState<WeixinQrLoginStatus | "">("");
  const [weixinQrLoading, setWeixinQrLoading] = useState(false);
  const [weixinDeleteConfirmId, setWeixinDeleteConfirmId] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const unsubFeishuRef = useRef<(() => void) | null>(null);
  const unsubTelegramRef = useRef<(() => void) | null>(null);
  const unsubQqbotRef = useRef<(() => void) | null>(null);
  const unsubWeixinRef = useRef<(() => void) | null>(null);
  const weixinPollRef = useRef<number | null>(null);
  const weixinQrSessionIdRef = useRef<string | null>(null);

  const refreshWeixinAccounts = useCallback(async () => {
    const accounts = await window.electron.listWeixinAccounts();
    setWeixinAccounts(accounts);
    setForm((prev) => {
      if (prev.weixin.accountId) return prev;
      const defaultAccount = accounts.find((item) => item.enabled && item.hasToken) ?? accounts[0];
      if (!defaultAccount) return prev;
      return {
        ...prev,
        weixin: {
          ...prev.weixin,
          accountId: defaultAccount.accountId,
        },
      };
    });
  }, []);

  // Load initial status and subscribe to updates for real-time bot platforms
  useEffect(() => {
    if (!open) return;
    setBots(initialBots);
    const f = botsToForm(initialBots);
    setForm(f);
    setTestResult(null);
    // Auto-expand advanced section if any advanced field has a value
    const dt = initialBots.dingtalk as any;
    if (dt && (dt.ownerStaffIds?.length || dt.allowFrom?.length || dt.maxConnectionAttempts)) {
      setDingtalkAdvanced(true);
    }

    // Get current Telegram status
    window.electron.getTelegramBotStatus(assistantId).then((r) => {
      setTelegramStatus(r.status);
    });

    // Get current DingTalk status
    window.electron.getDingtalkBotStatus(assistantId).then((r) => {
      setDingtalkStatus(r.status);
    });

    // Get current Feishu status
    window.electron.getFeishuBotStatus(assistantId).then((r) => {
      setFeishuStatus(r.status);
    });

    // Get current QQ Bot status
    window.electron.getQQBotStatus(assistantId).then((r) => {
      setQqbotStatus(r.status);
    });

    window.electron.getWeixinBotStatus(assistantId).then((r) => {
      setWeixinStatus(r.status);
    });
    void refreshWeixinAccounts();

    // Subscribe to Telegram live status updates
    const unsubTg = window.electron.onTelegramBotStatus((id, status, detail) => {
      if (id !== assistantId) return;
      setTelegramStatus(status);
      if (status === "error" && detail) {
        setTestResult({ success: false, message: detail });
      }
      if (status === "connected") {
        setTestResult({ success: true, message: "Telegram 连接成功，机器人正在监听消息" });
      }
    });
    unsubTelegramRef.current = unsubTg;

    // Subscribe to DingTalk live status updates
    const unsubDt = window.electron.onDingtalkBotStatus((id, status, detail) => {
      if (id !== assistantId) return;
      setDingtalkStatus(status);
      if (status === "error" && detail) {
        setTestResult({ success: false, message: detail });
      }
      if (status === "connected") {
        setTestResult({ success: true, message: "连接成功，机器人正在监听消息" });
      }
    });
    unsubRef.current = unsubDt;

    // Subscribe to Feishu live status updates
    const unsubFs = window.electron.onFeishuBotStatus((id, status, detail) => {
      if (id !== assistantId) return;
      setFeishuStatus(status);
      if (status === "error" && detail) {
        setTestResult({ success: false, message: detail });
      }
      if (status === "connected") {
        setTestResult({ success: true, message: "飞书连接成功，机器人正在监听消息" });
      }
    });
    unsubFeishuRef.current = unsubFs;

    // Subscribe to QQ Bot live status updates
    const unsubQq = window.electron.onQQBotStatus((id, status, detail) => {
      if (id !== assistantId) return;
      setQqbotStatus(status);
      if (status === "error" && detail) {
        setTestResult({ success: false, message: detail });
      }
      if (status === "connected") {
        setTestResult({ success: true, message: "QQ Bot 连接成功，机器人正在监听消息" });
      }
    });
    unsubQqbotRef.current = unsubQq;

    const unsubWx = window.electron.onWeixinBotStatus((id, status, detail) => {
      if (id !== assistantId) return;
      setWeixinStatus(status);
      if (status === "error" && detail) {
        setTestResult({ success: false, message: detail });
      }
      if (status === "connected") {
        setTestResult({ success: true, message: "微信连接成功，机器人正在监听消息" });
      }
    });
    unsubWeixinRef.current = unsubWx;

    // Subscribe to auto-populated ownerUserIds/ownerStaffIds changes
    const unsubOwner = window.electron.onAssistantBotOwnerIdsChanged((id, platform) => {
      if (id !== assistantId) return;
      // Re-fetch the latest assistant config from main process and update the form
      window.electron.getAssistantsConfig().then((cfg: any) => {
        const assistant = cfg?.assistants?.find((a: any) => a.id === assistantId);
        if (!assistant?.bots) return;
        const updatedBots = assistant.bots as Partial<Record<BotPlatformType, BotPlatformConfig>>;
        setBots(updatedBots);
        setForm((prev) => {
          const updated = botsToForm(updatedBots);
          // Only patch the changed platform field, keep user's other edits intact
          if (platform === "telegram") {
            return { ...prev, telegram: { ...prev.telegram, ownerUserIds: updated.telegram.ownerUserIds } };
          }
          if (platform === "dingtalk") {
            return { ...prev, dingtalk: { ...prev.dingtalk, ownerStaffIds: updated.dingtalk.ownerStaffIds } };
          }
          return prev;
        });
        // Auto-expand advanced section for DingTalk if ownerStaffIds just got set
        if (platform === "dingtalk") setDingtalkAdvanced(true);
      });
    });

    return () => {
      unsubTg();
      unsubDt();
      unsubFs();
      unsubQq();
      unsubWx();
      unsubOwner();
      unsubTelegramRef.current = null;
      unsubRef.current = null;
      unsubFeishuRef.current = null;
      unsubQqbotRef.current = null;
      unsubWeixinRef.current = null;
      if (weixinPollRef.current) {
        window.clearInterval(weixinPollRef.current);
        weixinPollRef.current = null;
      }
      const sid = weixinQrSessionIdRef.current;
      if (sid) {
        weixinQrSessionIdRef.current = null;
        void window.electron.cancelWeixinQrLogin(sid);
      }
    };
  }, [open, assistantId, initialBots, refreshWeixinAccounts]);

  useEffect(() => {
    setTestResult(null);
  }, [selectedPlatform]);

  const currentPlatformCfg = bots[selectedPlatform];
  const isConnected = currentPlatformCfg?.connected ?? false;

  // For real-time platforms, use live status; for others, use config flag
  const effectiveStatus =
    selectedPlatform === "telegram"
      ? telegramStatus ?? (isConnected ? "connected" : "disconnected")
      : selectedPlatform === "dingtalk"
      ? dingtalkStatus ?? (isConnected ? "connected" : "disconnected")
      : selectedPlatform === "feishu"
      ? feishuStatus ?? (isConnected ? "connected" : "disconnected")
      : selectedPlatform === "qqbot"
      ? qqbotStatus ?? (isConnected ? "connected" : "disconnected")
      : selectedPlatform === "weixin"
      ? weixinStatus ?? (isConnected ? "connected" : "disconnected")
      : isConnected
      ? "connected"
      : "disconnected";

  const handleSave = async () => {
    setSaving(true);
    try {
      const platformCfg = formToPlatformConfig(selectedPlatform, form, isConnected);
      const nextBots = { ...bots, [selectedPlatform]: platformCfg };
      setBots(nextBots);
      onSave(nextBots);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const platformCfg = formToPlatformConfig(selectedPlatform, form, false);
      const result = await window.electron.testBotConnection(platformCfg);
      setTestResult(result);
    } catch {
      setTestResult({ success: false, message: "测试失败，请检查网络" });
    } finally {
      setTesting(false);
    }
  };

  const stopWeixinQrPolling = () => {
    if (weixinPollRef.current) {
      window.clearInterval(weixinPollRef.current);
      weixinPollRef.current = null;
    }
  };

  const closeWeixinQrPanel = async () => {
    stopWeixinQrPolling();
    const sid = weixinQrSessionIdRef.current;
    if (sid) {
      weixinQrSessionIdRef.current = null;
      await window.electron.cancelWeixinQrLogin(sid);
    }
    setWeixinQrSessionId(null);
    setWeixinQrImage("");
    setWeixinQrStatus("");
  };

  const startWeixinQrFlow = async () => {
    setWeixinQrLoading(true);
    setTestResult(null);
    try {
      const result = await window.electron.startWeixinQrLogin();
      setWeixinQrSessionId(result.sessionId);
      weixinQrSessionIdRef.current = result.sessionId;
      setWeixinQrImage(result.qrImage);
      setWeixinQrStatus("waiting");
      stopWeixinQrPolling();
      weixinPollRef.current = window.setInterval(async () => {
        const statusResult = await window.electron.pollWeixinQrLogin(result.sessionId);
        setWeixinQrStatus(statusResult.status);
        if (statusResult.qrImage) {
          setWeixinQrImage(statusResult.qrImage);
        }
        if (statusResult.status === "confirmed") {
          stopWeixinQrPolling();
          weixinQrSessionIdRef.current = null;
          void refreshWeixinAccounts();
          if (statusResult.accountId) {
            updateWeixin({ accountId: statusResult.accountId });
          }
        }
        if (statusResult.status === "failed") {
          stopWeixinQrPolling();
          weixinQrSessionIdRef.current = null;
          setTestResult({
            success: false,
            message: statusResult.error || "微信扫码登录失败",
          });
        }
      }, 3000);
    } catch (err) {
      setTestResult({
        success: false,
        message: `扫码登录失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setWeixinQrLoading(false);
    }
  };

  const handleDeleteWeixinAccount = async (accountId: string) => {
    if (weixinDeleteConfirmId !== accountId) {
      setWeixinDeleteConfirmId(accountId);
      return;
    }
    setWeixinDeleteConfirmId(null);
    await window.electron.deleteWeixinAccount(accountId);
    await refreshWeixinAccounts();
    if (form.weixin.accountId === accountId) {
      updateWeixin({ accountId: "" });
    }
  };

  const handleToggleWeixinAccount = async (accountId: string, enabled: boolean) => {
    await window.electron.setWeixinAccountEnabled(accountId, enabled);
    await refreshWeixinAccounts();
  };

  const [telegramAdvanced, setTelegramAdvanced] = useState(false);

  const handleToggleConnect = async () => {
    if (selectedPlatform === "telegram") {
      if (effectiveStatus === "connected" || effectiveStatus === "connecting") {
        await window.electron.stopTelegramBot(assistantId);
        const platformCfg = formToPlatformConfig("telegram", form, false);
        const nextBots = { ...bots, telegram: platformCfg };
        setBots(nextBots);
        onSave(nextBots);
      } else {
        const tg = form.telegram;
        if (!tg.token) {
          setTestResult({ success: false, message: "请先填写 Bot Token" });
          return;
        }
        setConnecting(true);
        setTestResult(null);
        try {
          const result = await window.electron.startTelegramBot({
            token: tg.token,
            proxy: tg.proxy || undefined,
            assistantId,
            assistantName,
            skillNames,
            provider,
            model,
            defaultCwd,
            persona,
            coreValues,
            relationship,
            cognitiveStyle,
            operatingGuidelines,
            userContext,
            dmPolicy: tg.dmPolicy,
            groupPolicy: tg.groupPolicy,
            allowFrom: tg.allowFrom
              ? tg.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            requireMention: tg.requireMention,
            ownerUserIds: tg.ownerUserIds
              ? tg.ownerUserIds.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
          if (result.status === "error") {
            setTestResult({ success: false, message: result.detail ?? "连接失败" });
          } else {
            const platformCfg = formToPlatformConfig("telegram", form, true);
            const nextBots = { ...bots, telegram: platformCfg };
            setBots(nextBots);
            onSave(nextBots);
          }
        } catch (err) {
          setTestResult({ success: false, message: `连接异常: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          setConnecting(false);
        }
      }
    } else if (selectedPlatform === "dingtalk") {
      if (effectiveStatus === "connected" || effectiveStatus === "connecting") {
        await window.electron.stopDingtalkBot(assistantId);
        const platformCfg = formToPlatformConfig("dingtalk", form, false);
        const nextBots = { ...bots, dingtalk: platformCfg };
        setBots(nextBots);
        onSave(nextBots);
      } else {
        const dt = form.dingtalk;
        if (!dt.appKey || !dt.appSecret) {
          setTestResult({ success: false, message: "请先填写 AppKey 和 AppSecret" });
          return;
        }
        setConnecting(true);
        setTestResult(null);
        try {
          const result = await window.electron.startDingtalkBot({
            appKey: dt.appKey,
            appSecret: dt.appSecret,
            robotCode: dt.robotCode || undefined,
            assistantId,
            assistantName,
            provider,
            model,
            defaultCwd,
            persona,
            coreValues,
            relationship,
            cognitiveStyle,
            operatingGuidelines,
            userContext,
            messageType: dt.messageType,
            cardTemplateId: dt.cardTemplateId || undefined,
            cardTemplateKey: dt.cardTemplateKey || undefined,
            dmPolicy: dt.dmPolicy,
            groupPolicy: dt.groupPolicy,
            allowFrom: dt.allowFrom
              ? dt.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            ownerStaffIds: dt.ownerStaffIds
              ? dt.ownerStaffIds.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            maxConnectionAttempts: parseInt(dt.maxConnectionAttempts, 10) || undefined,
          });
          if (result.status === "error") {
            setTestResult({ success: false, message: result.detail ?? "连接失败" });
          } else {
            const platformCfg = formToPlatformConfig("dingtalk", form, true);
            const nextBots = { ...bots, dingtalk: platformCfg };
            setBots(nextBots);
            onSave(nextBots);
          }
        } finally {
          setConnecting(false);
        }
      }
    } else if (selectedPlatform === "feishu") {
      if (effectiveStatus === "connected" || effectiveStatus === "connecting") {
        await window.electron.stopFeishuBot(assistantId);
        const platformCfg = formToPlatformConfig("feishu", form, false);
        const nextBots = { ...bots, feishu: platformCfg };
        setBots(nextBots);
        onSave(nextBots);
      } else {
        const fs = form.feishu;
        if (!fs.appId || !fs.appSecret) {
          setTestResult({ success: false, message: "请先填写 App ID 和 App Secret" });
          return;
        }
        setConnecting(true);
        setTestResult(null);
        try {
          const result = await window.electron.startFeishuBot({
            appId: fs.appId,
            appSecret: fs.appSecret,
            domain: fs.domain,
            assistantId,
            assistantName,
            provider,
            model,
            defaultCwd,
            persona,
            coreValues,
            relationship,
            cognitiveStyle,
            operatingGuidelines,
            userContext,
            connectionMode: fs.connectionMode,
            webhookPort: fs.connectionMode === "webhook" ? parseInt(fs.webhookPort, 10) || 3000 : undefined,
            dmPolicy: fs.dmPolicy,
            groupPolicy: fs.groupPolicy,
            allowFrom: fs.allowFrom ? fs.allowFrom.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
            requireMention: fs.requireMention,
            renderMode: fs.renderMode,
            ownerOpenIds: fs.ownerOpenIds ? fs.ownerOpenIds.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
          });
          if (result.status === "error") {
            setTestResult({ success: false, message: result.detail ?? "连接失败" });
          } else {
            const platformCfg = formToPlatformConfig("feishu", form, true);
            const nextBots = { ...bots, feishu: platformCfg };
            setBots(nextBots);
            onSave(nextBots);
          }
        } finally {
          setConnecting(false);
        }
      }
    } else if (selectedPlatform === "qqbot") {
      if (effectiveStatus === "connected" || effectiveStatus === "connecting") {
        await window.electron.stopQQBot(assistantId);
        const platformCfg = formToPlatformConfig("qqbot", form, false);
        const nextBots = { ...bots, qqbot: platformCfg };
        setBots(nextBots);
        onSave(nextBots);
      } else {
        const qq = form.qqbot;
        if (!qq.appId || !qq.clientSecret) {
          setTestResult({ success: false, message: "请先填写 App ID 和 App Secret" });
          return;
        }
        setConnecting(true);
        setTestResult(null);
        try {
          const result = await window.electron.startQQBot({
            appId: qq.appId,
            clientSecret: qq.clientSecret,
            assistantId,
            assistantName,
            provider,
            model,
            defaultCwd,
            persona,
            coreValues,
            relationship,
            cognitiveStyle,
            operatingGuidelines,
            userContext,
            dmPolicy: qq.dmPolicy,
            groupPolicy: qq.groupPolicy,
            allowFrom: qq.allowFrom
              ? qq.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            ownerOpenIds: qq.ownerOpenIds
              ? qq.ownerOpenIds.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
          if (result.status === "error") {
            setTestResult({ success: false, message: result.detail ?? "连接失败" });
          } else {
            const platformCfg = formToPlatformConfig("qqbot", form, true);
            const nextBots = { ...bots, qqbot: platformCfg };
            setBots(nextBots);
            onSave(nextBots);
          }
        } catch (err) {
          setTestResult({ success: false, message: `连接异常: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          setConnecting(false);
        }
      }
    } else if (selectedPlatform === "weixin") {
      if (effectiveStatus === "connected" || effectiveStatus === "connecting") {
        await window.electron.stopWeixinBot(assistantId);
        const platformCfg = formToPlatformConfig("weixin", form, false);
        const nextBots = { ...bots, weixin: platformCfg };
        setBots(nextBots);
        onSave(nextBots);
      } else {
        const wx = form.weixin;
        if (!wx.accountId) {
          setTestResult({ success: false, message: "请先选择一个已登录的微信账号" });
          return;
        }
        setConnecting(true);
        setTestResult(null);
        try {
          const result = await window.electron.startWeixinBot({
            accountId: wx.accountId,
            assistantId,
            assistantName,
            skillNames,
            provider,
            model,
            defaultCwd,
            persona,
            coreValues,
            relationship,
            cognitiveStyle,
            operatingGuidelines,
            userContext,
            dmPolicy: wx.dmPolicy,
            allowFrom: wx.allowFrom
              ? wx.allowFrom.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
          if (result.status === "error") {
            setTestResult({ success: false, message: result.detail ?? "连接失败" });
          } else {
            const platformCfg = formToPlatformConfig("weixin", form, true);
            const nextBots = { ...bots, weixin: platformCfg };
            setBots(nextBots);
            onSave(nextBots);
          }
        } catch (err) {
          setTestResult({ success: false, message: `连接异常: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          setConnecting(false);
        }
      }
    } else {
      const newConnected = !isConnected;
      const platformCfg = formToPlatformConfig(selectedPlatform, form, newConnected);
      const nextBots = { ...bots, [selectedPlatform]: platformCfg };
      setBots(nextBots);
      onSave(nextBots);
    }
  };

  const updateTelegram = (u: Partial<FormState["telegram"]>) =>
    setForm((f) => ({ ...f, telegram: { ...f.telegram, ...u } }));
  const updateFeishu = (u: Partial<FormState["feishu"]>) =>
    setForm((f) => ({ ...f, feishu: { ...f.feishu, ...u } }));
  const updateWecom = (u: Partial<FormState["wecom"]>) =>
    setForm((f) => ({ ...f, wecom: { ...f.wecom, ...u } }));
  const updateDiscord = (u: Partial<FormState["discord"]>) =>
    setForm((f) => ({ ...f, discord: { ...f.discord, ...u } }));
  const updateDingtalk = (u: Partial<FormState["dingtalk"]>) =>
    setForm((f) => ({ ...f, dingtalk: { ...f.dingtalk, ...u } }));
  const updateQqbot = (u: Partial<FormState["qqbot"]>) =>
    setForm((f) => ({ ...f, qqbot: { ...f.qqbot, ...u } }));
  const updateWeixin = (u: Partial<FormState["weixin"]>) =>
    setForm((f) => ({ ...f, weixin: { ...f.weixin, ...u } }));

  const [dingtalkAdvanced, setDingtalkAdvanced] = useState(false);
  const [feishuAdvanced, setFeishuAdvanced] = useState(false);
  const [qqbotAdvanced, setQqbotAdvanced] = useState(false);
  const [weixinAdvanced, setWeixinAdvanced] = useState(false);

  const connectedCount = Object.values(bots).filter((b) => b?.connected).length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface shadow-elevated flex flex-col overflow-hidden"
          style={{ height: "580px" }}
        >
          <Dialog.Description className="sr-only">
            配置并管理当前助手在各个 IM 平台的机器人连接参数与状态。
          </Dialog.Description>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-ink-900/6 flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <Dialog.Title className="text-base font-semibold text-ink-800">
                机器人对话
              </Dialog.Title>
              <span className="rounded-full bg-surface-secondary border border-ink-900/8 px-2 py-0.5 text-[11px] text-muted">
                {assistantName}
              </span>
              {connectedCount > 0 && (
                <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] text-emerald-700">
                  {connectedCount} 已连接
                </span>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* Left sidebar */}
            <div className="w-[200px] flex-shrink-0 border-r border-ink-900/6 p-3 flex flex-col gap-0.5">
              <p className="text-[10px] font-semibold text-muted uppercase tracking-wider px-2 pb-2">
                平台
              </p>
              {PLATFORMS.map((platform) => {
                const cfg = bots[platform.id];
                const connected = cfg?.connected ?? false;
                const isActive = selectedPlatform === platform.id;
                return (
                  <button
                    key={platform.id}
                    onClick={() => setSelectedPlatform(platform.id)}
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors w-full ${
                      isActive ? "bg-ink-900/8 text-ink-800" : "text-ink-700 hover:bg-surface-secondary"
                    }`}
                  >
                    <div
                      className="h-6 w-6 flex-shrink-0 rounded-lg flex items-center justify-center p-1"
                      style={{ backgroundColor: platform.color + "1A", color: platform.color }}
                    >
                      {platform.icon}
                    </div>
                    <span className="text-sm font-medium leading-none flex-1">{platform.name}</span>
                    {(platform.id === "telegram"
                      ? telegramStatus === "connected"
                      : platform.id === "dingtalk"
                      ? dingtalkStatus === "connected"
                      : platform.id === "feishu"
                      ? feishuStatus === "connected"
                      : platform.id === "qqbot"
                      ? qqbotStatus === "connected"
                      : platform.id === "weixin"
                      ? weixinStatus === "connected"
                      : connected) && (
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                    )}
                    {platform.id === "telegram" && telegramStatus === "connecting" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    )}
                    {platform.id === "telegram" && telegramStatus === "error" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                    {platform.id === "dingtalk" && dingtalkStatus === "connecting" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    )}
                    {platform.id === "dingtalk" && dingtalkStatus === "error" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                    {platform.id === "feishu" && feishuStatus === "connecting" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    )}
                    {platform.id === "feishu" && feishuStatus === "error" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                    {platform.id === "qqbot" && qqbotStatus === "connecting" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    )}
                    {platform.id === "qqbot" && qqbotStatus === "error" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                    {platform.id === "weixin" && weixinStatus === "connecting" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                    )}
                    {platform.id === "weixin" && weixinStatus === "error" && (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Right content */}
            {PLATFORMS.map((platform) => {
              if (platform.id !== selectedPlatform) return null;
              return (
                <div key={platform.id} className="flex-1 flex flex-col min-h-0 overflow-y-auto p-5">
                  {/* Platform header */}
                  <div className="flex items-center gap-3 pb-4 border-b border-ink-900/6">
                    <div
                      className="h-10 w-10 flex-shrink-0 rounded-xl flex items-center justify-center p-2"
                      style={{ backgroundColor: platform.color + "1A", color: platform.color }}
                    >
                      {platform.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-ink-800">{platform.name}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div className={`h-1.5 w-1.5 rounded-full ${
                          effectiveStatus === "connected" ? "bg-emerald-500" :
                          effectiveStatus === "connecting" ? "bg-amber-400 animate-pulse" :
                          effectiveStatus === "error" ? "bg-red-500" :
                          "bg-ink-900/20"
                        }`} />
                        <span className="text-[11px] text-muted">
                          {effectiveStatus === "connected" ? "已连接" :
                           effectiveStatus === "connecting" ? "连接中…" :
                           effectiveStatus === "error" ? "连接失败" : "未连接"}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={handleToggleConnect}
                      disabled={connecting || effectiveStatus === "connecting"}
                      className={`relative inline-flex h-6 w-10 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-60 ${
                        effectiveStatus === "connected" ? "bg-accent" :
                        effectiveStatus === "connecting" ? "bg-amber-400" : "bg-ink-900/15"
                      }`}
                      role="switch"
                      aria-checked={effectiveStatus === "connected"}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform ${
                          effectiveStatus === "connected" || effectiveStatus === "connecting" ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Description */}
                  <div className="mt-3 mb-4 rounded-xl bg-surface-secondary/80 px-3.5 py-2.5">
                    <p className="text-xs text-muted">{platform.description}</p>
                  </div>

                  {/* Credentials */}
                  <div className="flex flex-col gap-3">
                    <p className="text-xs font-semibold text-ink-800">凭证配置</p>

                    {selectedPlatform === "telegram" && (
                      <>
                        <FormField label="Bot Token">
                          <input type="password" className={INPUT_CLASS} placeholder="123456:ABC-DEF..."
                            value={form.telegram.token} onChange={(e) => updateTelegram({ token: e.target.value })} />
                        </FormField>
                        <FormField label="代理地址" hint="（国内网络必填）">
                          <input className={INPUT_CLASS} placeholder="http://127.0.0.1:7890"
                            value={form.telegram.proxy} onChange={(e) => updateTelegram({ proxy: e.target.value })} />
                        </FormField>

                        {/* Advanced settings toggle */}
                        <button
                          type="button"
                          onClick={() => setTelegramAdvanced((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink-700 transition-colors mt-1"
                        >
                          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${telegramAdvanced ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                          高级设置（访问控制 / 群组行为）
                        </button>

                        {telegramAdvanced && (
                          <div className="flex flex-col gap-3 pl-3 border-l-2 border-ink-900/8">
                            <FormField label="群组中需要 @提及">
                              <select className={INPUT_CLASS} value={form.telegram.requireMention ? "true" : "false"}
                                onChange={(e) => updateTelegram({ requireMention: e.target.value === "true" })}>
                                <option value="true">是 — 在群组中需要 @机器人 或回复才响应</option>
                                <option value="false">否 — 响应群组中的所有消息</option>
                              </select>
                            </FormField>
                            <FormField label="私聊策略 (dmPolicy)">
                              <select className={INPUT_CLASS} value={form.telegram.dmPolicy}
                                onChange={(e) => updateTelegram({ dmPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何人可私聊</option>
                                <option value="allowlist">allowlist — 仅白名单用户</option>
                              </select>
                            </FormField>
                            <FormField label="群聊策略 (groupPolicy)">
                              <select className={INPUT_CLASS} value={form.telegram.groupPolicy}
                                onChange={(e) => updateTelegram({ groupPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何群可使用</option>
                                <option value="allowlist">allowlist — 仅白名单群</option>
                              </select>
                            </FormField>
                            {(form.telegram.dmPolicy === "allowlist" || form.telegram.groupPolicy === "allowlist") && (
                              <FormField label="白名单 ID" hint="（逗号分隔，Telegram User ID 或 Group Chat ID）">
                                <input className={INPUT_CLASS} placeholder="123456789,-1001234567890,..."
                                  value={form.telegram.allowFrom} onChange={(e) => updateTelegram({ allowFrom: e.target.value })} />
                              </FormField>
                            )}
                            <FormField label="我的 User ID（主动推送）" hint="填入你的 Telegram User ID，机器人才能主动发消息给你。发 /myid 给机器人可获取。逗号分隔多人。">
                              <input className={INPUT_CLASS} placeholder="123456789"
                                value={form.telegram.ownerUserIds} onChange={(e) => updateTelegram({ ownerUserIds: e.target.value })} />
                            </FormField>
                          </div>
                        )}
                      </>
                    )}

                    {selectedPlatform === "feishu" && (
                      <>
                        <FormField label="App ID">
                          <input className={INPUT_CLASS} placeholder="cli_xxxx"
                            value={form.feishu.appId} onChange={(e) => updateFeishu({ appId: e.target.value })} />
                        </FormField>
                        <FormField label="App Secret">
                          <input type="password" className={INPUT_CLASS} placeholder="xxxx"
                            value={form.feishu.appSecret} onChange={(e) => updateFeishu({ appSecret: e.target.value })} />
                        </FormField>
                        <FormField label="域名">
                          <select className={INPUT_CLASS} value={form.feishu.domain}
                            onChange={(e) => updateFeishu({ domain: e.target.value as "feishu" | "lark" })}>
                            <option value="feishu">飞书 (feishu.cn)</option>
                            <option value="lark">Lark (larksuite.com)</option>
                          </select>
                        </FormField>
                        <FormField label="连接模式">
                          <select className={INPUT_CLASS} value={form.feishu.connectionMode}
                            onChange={(e) => updateFeishu({ connectionMode: e.target.value as "websocket" | "webhook" })}>
                            <option value="websocket">WebSocket 长连接（推荐，无需公网地址）</option>
                            <option value="webhook">Webhook（需公网可访问 URL）</option>
                          </select>
                        </FormField>
                        {form.feishu.connectionMode === "webhook" && (
                          <FormField label="Webhook 端口" hint="（默认 3000）">
                            <input type="number" className={INPUT_CLASS} placeholder="3000"
                              value={form.feishu.webhookPort} onChange={(e) => updateFeishu({ webhookPort: e.target.value })} />
                          </FormField>
                        )}

                        <button
                          type="button"
                          onClick={() => setFeishuAdvanced((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink-700 transition-colors mt-1"
                        >
                          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${feishuAdvanced ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                          高级设置（访问控制 / 渲染模式）
                        </button>

                        {feishuAdvanced && (
                          <div className="flex flex-col gap-3 pl-3 border-l-2 border-ink-900/8">
                            <FormField label="群聊中需要 @提及">
                              <select className={INPUT_CLASS} value={form.feishu.requireMention ? "true" : "false"}
                                onChange={(e) => updateFeishu({ requireMention: e.target.value === "true" })}>
                                <option value="true">是 — 需要 @机器人 才响应</option>
                                <option value="false">否 — 响应所有群消息</option>
                              </select>
                            </FormField>
                            <FormField label="私聊策略 (dmPolicy)">
                              <select className={INPUT_CLASS} value={form.feishu.dmPolicy}
                                onChange={(e) => updateFeishu({ dmPolicy: e.target.value as "open" | "allowlist" | "pairing" })}>
                                <option value="open">open — 任何人可私聊</option>
                                <option value="pairing">pairing — 需配对审批</option>
                                <option value="allowlist">allowlist — 仅白名单用户</option>
                              </select>
                            </FormField>
                            <FormField label="群聊策略 (groupPolicy)">
                              <select className={INPUT_CLASS} value={form.feishu.groupPolicy}
                                onChange={(e) => updateFeishu({ groupPolicy: e.target.value as "open" | "allowlist" | "disabled" })}>
                                <option value="open">open — 任何群可使用</option>
                                <option value="allowlist">allowlist — 仅白名单群/用户</option>
                                <option value="disabled">disabled — 禁用群聊</option>
                              </select>
                            </FormField>
                            {(form.feishu.dmPolicy === "allowlist" || form.feishu.groupPolicy === "allowlist") && (
                              <FormField label="白名单 ID" hint="（逗号分隔，open_id 或 chat_id）">
                                <input className={INPUT_CLASS} placeholder="ou_xxx,oc_xxx,..."
                                  value={form.feishu.allowFrom} onChange={(e) => updateFeishu({ allowFrom: e.target.value })} />
                              </FormField>
                            )}
                            <FormField label="回复渲染模式 (renderMode)">
                              <select className={INPUT_CLASS} value={form.feishu.renderMode}
                                onChange={(e) => updateFeishu({ renderMode: e.target.value as "auto" | "raw" | "card" })}>
                                <option value="auto">auto — 自动（有代码/表格时用卡片）</option>
                                <option value="card">card — 始终使用卡片（支持语法高亮）</option>
                                <option value="raw">raw — 纯文本</option>
                              </select>
                            </FormField>
                            <FormField label="我的 open_id（主动推送）" hint="填入你的 open_id，机器人才能主动发消息给你。逗号分隔多人。">
                              <input className={INPUT_CLASS} placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                                value={form.feishu.ownerOpenIds} onChange={(e) => updateFeishu({ ownerOpenIds: e.target.value })} />
                            </FormField>
                          </div>
                        )}
                      </>
                    )}

                    {selectedPlatform === "wecom" && (
                      <>
                        <FormField label="Corp ID">
                          <input className={INPUT_CLASS} placeholder="ww..."
                            value={form.wecom.corpId} onChange={(e) => updateWecom({ corpId: e.target.value })} />
                        </FormField>
                        <FormField label="Agent ID">
                          <input className={INPUT_CLASS} placeholder="1000001"
                            value={form.wecom.agentId} onChange={(e) => updateWecom({ agentId: e.target.value })} />
                        </FormField>
                        <FormField label="Secret">
                          <input type="password" className={INPUT_CLASS} placeholder="xxxx"
                            value={form.wecom.secret} onChange={(e) => updateWecom({ secret: e.target.value })} />
                        </FormField>
                      </>
                    )}

                    {selectedPlatform === "discord" && (
                      <FormField label="Bot Token">
                        <input type="password" className={INPUT_CLASS} placeholder="MTxxxx..."
                          value={form.discord.token} onChange={(e) => updateDiscord({ token: e.target.value })} />
                      </FormField>
                    )}

                    {selectedPlatform === "dingtalk" && (
                      <>
                        <FormField label="Client ID (AppKey)">
                          <input className={INPUT_CLASS} placeholder="dingxxxxxxxx"
                            value={form.dingtalk.appKey} onChange={(e) => updateDingtalk({ appKey: e.target.value })} />
                        </FormField>
                        <FormField label="Client Secret (AppSecret)">
                          <input type="password" className={INPUT_CLASS} placeholder="xxxx"
                            value={form.dingtalk.appSecret} onChange={(e) => updateDingtalk({ appSecret: e.target.value })} />
                        </FormField>

                        {/* Reply mode */}
                        <FormField label="回复模式">
                          <select className={INPUT_CLASS} value={form.dingtalk.messageType}
                            onChange={(e) => updateDingtalk({ messageType: e.target.value as "markdown" | "card" })}>
                            <option value="markdown">Markdown（普通格式）</option>
                            <option value="card">AI 互动卡片（流式输出）</option>
                          </select>
                        </FormField>

                        {form.dingtalk.messageType === "card" && (
                          <>
                            <FormField label="Robot Code" hint="（通常与 AppKey 相同）">
                              <input className={INPUT_CLASS} placeholder="dingxxxxxxxx（留空则用 AppKey）"
                                value={form.dingtalk.robotCode} onChange={(e) => updateDingtalk({ robotCode: e.target.value })} />
                            </FormField>
                            <FormField label="Card Template ID">
                              <input className={INPUT_CLASS} placeholder="xxxxx-xxxxx-xxxxx.schema"
                                value={form.dingtalk.cardTemplateId} onChange={(e) => updateDingtalk({ cardTemplateId: e.target.value })} />
                            </FormField>
                            <FormField label="Card Template Key" hint="（默认 content）">
                              <input className={INPUT_CLASS} placeholder="content"
                                value={form.dingtalk.cardTemplateKey} onChange={(e) => updateDingtalk({ cardTemplateKey: e.target.value })} />
                            </FormField>
                          </>
                        )}

                        {/* Advanced settings toggle */}
                        <button
                          type="button"
                          onClick={() => setDingtalkAdvanced((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink-700 transition-colors mt-1"
                        >
                          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${dingtalkAdvanced ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                          高级设置（访问控制 / 重连策略）
                        </button>

                        {dingtalkAdvanced && (
                          <div className="flex flex-col gap-3 pl-3 border-l-2 border-ink-900/8">
                            <FormField label="私聊策略 (dmPolicy)">
                              <select className={INPUT_CLASS} value={form.dingtalk.dmPolicy}
                                onChange={(e) => updateDingtalk({ dmPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何人可私聊</option>
                                <option value="allowlist">allowlist — 仅白名单用户</option>
                              </select>
                            </FormField>
                            <FormField label="群聊策略 (groupPolicy)">
                              <select className={INPUT_CLASS} value={form.dingtalk.groupPolicy}
                                onChange={(e) => updateDingtalk({ groupPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何群可使用</option>
                                <option value="allowlist">allowlist — 仅白名单群</option>
                              </select>
                            </FormField>
                            {(form.dingtalk.dmPolicy === "allowlist" || form.dingtalk.groupPolicy === "allowlist") && (
                              <FormField label="白名单 ID" hint="（逗号分隔，Staff ID 或 ConversationId）">
                                <input className={INPUT_CLASS} placeholder="userId1,userId2,..."
                                  value={form.dingtalk.allowFrom} onChange={(e) => updateDingtalk({ allowFrom: e.target.value })} />
                              </FormField>
                            )}
                            <FormField label="我的 StaffId（主动推送）" hint="填入你的钉钉 staffId，机器人才能主动发消息给你。也支持群 conversationId（cid...）或 user:/group: 前缀。逗号分隔多人。">
                              <input className={INPUT_CLASS} placeholder="staff_xxxxx 或 cidXXX"
                                value={form.dingtalk.ownerStaffIds} onChange={(e) => updateDingtalk({ ownerStaffIds: e.target.value })} />
                            </FormField>
                            <FormField label="最大重连次数" hint="（默认 10）">
                              <input type="number" min="1" max="100" className={INPUT_CLASS} placeholder="10"
                                value={form.dingtalk.maxConnectionAttempts} onChange={(e) => updateDingtalk({ maxConnectionAttempts: e.target.value })} />
                            </FormField>
                          </div>
                        )}
                      </>
                    )}

                    {selectedPlatform === "qqbot" && (
                      <>
                        <FormField label="App ID">
                          <input className={INPUT_CLASS} placeholder="102xxxxxx"
                            value={form.qqbot.appId} onChange={(e) => updateQqbot({ appId: e.target.value })} />
                        </FormField>
                        <FormField label="App Secret">
                          <input type="password" className={INPUT_CLASS} placeholder="xxxx"
                            value={form.qqbot.clientSecret} onChange={(e) => updateQqbot({ clientSecret: e.target.value })} />
                        </FormField>

                        <button
                          type="button"
                          onClick={() => setQqbotAdvanced((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink-700 transition-colors mt-1"
                        >
                          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${qqbotAdvanced ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                          高级设置（访问控制）
                        </button>

                        {qqbotAdvanced && (
                          <div className="flex flex-col gap-3 pl-3 border-l-2 border-ink-900/8">
                            <FormField label="私聊策略 (dmPolicy)">
                              <select className={INPUT_CLASS} value={form.qqbot.dmPolicy}
                                onChange={(e) => updateQqbot({ dmPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何人可私聊</option>
                                <option value="allowlist">allowlist — 仅白名单用户</option>
                              </select>
                            </FormField>
                            <FormField label="群聊策略 (groupPolicy)">
                              <select className={INPUT_CLASS} value={form.qqbot.groupPolicy}
                                onChange={(e) => updateQqbot({ groupPolicy: e.target.value as "open" | "allowlist" })}>
                                <option value="open">open — 任何群可使用</option>
                                <option value="allowlist">allowlist — 仅白名单群</option>
                              </select>
                            </FormField>
                            {(form.qqbot.dmPolicy === "allowlist" || form.qqbot.groupPolicy === "allowlist") && (
                              <FormField label="白名单 ID" hint="（逗号分隔，user_openid 或 group_openid）">
                                <input className={INPUT_CLASS} placeholder="xxx,yyy,..."
                                  value={form.qqbot.allowFrom} onChange={(e) => updateQqbot({ allowFrom: e.target.value })} />
                              </FormField>
                            )}
                            <FormField label="我的 OpenID（主动推送）" hint="填入你的 QQ user_openid，机器人才能主动发消息给你。发 /myid 给机器人可获取。逗号分隔多人。">
                              <input className={INPUT_CLASS} placeholder="xxxxxx"
                                value={form.qqbot.ownerOpenIds} onChange={(e) => updateQqbot({ ownerOpenIds: e.target.value })} />
                            </FormField>
                          </div>
                        )}
                      </>
                    )}

                    {selectedPlatform === "weixin" && (
                      <>
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-xs text-emerald-800">
                          微信仅支持私聊消息。首次使用请先扫码登录一个微信账号，再把该账号绑定到当前助手。
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={startWeixinQrFlow}
                            disabled={weixinQrLoading}
                            className="rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2 text-sm text-ink-700 hover:bg-surface-tertiary transition-colors disabled:opacity-50"
                          >
                            {weixinQrLoading ? "生成中…" : "扫码登录微信"}
                          </button>
                          {weixinQrSessionId && (
                            <button
                              type="button"
                              onClick={() => void closeWeixinQrPanel()}
                              className="rounded-xl border border-ink-900/10 bg-surface-secondary px-3 py-2 text-sm text-ink-700 hover:bg-surface-tertiary transition-colors"
                            >
                              关闭二维码
                            </button>
                          )}
                        </div>

                        {weixinQrImage && (
                          <div className="rounded-xl border border-ink-900/8 bg-surface-secondary/70 p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-sm font-medium text-ink-800">微信扫码登录</p>
                                <p className="mt-1 text-xs text-muted">
                                  {weixinQrStatus === "waiting" && "请使用手机微信扫码"}
                                  {weixinQrStatus === "scanned" && "已扫码，请在手机上确认登录"}
                                  {weixinQrStatus === "confirmed" && "登录成功，已同步账号列表"}
                                  {weixinQrStatus === "expired" && "二维码已过期，正在刷新"}
                                  {weixinQrStatus === "failed" && "二维码登录失败"}
                                </p>
                              </div>
                              <img src={weixinQrImage} alt="微信二维码" className="h-32 w-32 rounded-lg border border-ink-900/8 bg-white p-2" />
                            </div>
                          </div>
                        )}

                        <FormField label="已登录账号">
                          <select
                            className={INPUT_CLASS}
                            value={form.weixin.accountId}
                            onChange={(e) => updateWeixin({ accountId: e.target.value })}
                          >
                            <option value="">请选择一个微信账号</option>
                            {weixinAccounts.map((account) => (
                              <option key={account.accountId} value={account.accountId}>
                                {account.name || account.accountId}
                                {!account.enabled ? "（已停用）" : ""}
                                {!account.hasToken ? "（已失效）" : ""}
                              </option>
                            ))}
                          </select>
                        </FormField>

                        {weixinAccounts.length > 0 && (
                          <div className="rounded-xl border border-ink-900/8 bg-surface-secondary/70 p-3">
                            <div className="text-xs font-semibold text-ink-800 mb-2">账号池</div>
                            <div className="flex flex-col gap-2">
                              {weixinAccounts.map((account) => (
                                <div key={account.accountId} className="flex items-center justify-between gap-3 rounded-lg border border-ink-900/8 bg-white/70 px-3 py-2">
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-ink-800 truncate">{account.name || account.accountId}</div>
                                    <div className="text-[11px] text-muted space-x-1">
                                      {account.userId && <span>{account.userId}</span>}
                                      {account.userId && <span>·</span>}
                                      <span>{account.accountId}</span>
                                      {!account.enabled && <span>· 已停用</span>}
                                      {!account.hasToken && <span>· Token 失效</span>}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void handleToggleWeixinAccount(account.accountId, !account.enabled)}
                                      className="rounded-lg border border-ink-900/10 px-2.5 py-1.5 text-xs text-ink-700 hover:bg-surface-tertiary transition-colors"
                                    >
                                      {account.enabled ? "停用" : "启用"}
                                    </button>
                                    {weixinDeleteConfirmId === account.accountId ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => void handleDeleteWeixinAccount(account.accountId)}
                                          className="rounded-lg border border-red-400 bg-red-100 px-2.5 py-1.5 text-xs text-red-700 hover:bg-red-200 transition-colors font-medium"
                                        >
                                          确认删除
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setWeixinDeleteConfirmId(null)}
                                          className="rounded-lg border border-ink-900/10 px-2.5 py-1.5 text-xs text-ink-600 hover:bg-surface-tertiary transition-colors"
                                        >
                                          取消
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => void handleDeleteWeixinAccount(account.accountId)}
                                        className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-100 transition-colors"
                                      >
                                        删除
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => setWeixinAdvanced((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink-700 transition-colors mt-1"
                        >
                          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${weixinAdvanced ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                          高级设置（访问控制 &amp; 媒体）
                        </button>

                        {weixinAdvanced && (
                          <div className="flex flex-col gap-3 pl-3 border-l-2 border-ink-900/8">
                            <FormField label="私聊策略 (dmPolicy)">
                              <select
                                className={INPUT_CLASS}
                                value={form.weixin.dmPolicy}
                                onChange={(e) => updateWeixin({ dmPolicy: e.target.value as "open" | "allowlist" })}
                              >
                                <option value="open">open — 任何人可私聊</option>
                                <option value="allowlist">allowlist — 仅白名单用户</option>
                              </select>
                            </FormField>
                            {form.weixin.dmPolicy === "allowlist" && (
                              <FormField label="白名单 ID" hint="（逗号分隔，微信 peer user id）">
                                <input
                                  className={INPUT_CLASS}
                                  placeholder="wxid_xxx,wxid_yyy"
                                  value={form.weixin.allowFrom}
                                  onChange={(e) => updateWeixin({ allowFrom: e.target.value })}
                                />
                              </FormField>
                            )}
                            <FormField label="管理员 ID (ownerUserIds)" hint="拥有截图、脚本等敏感工具权限（逗号分隔，发 /myid 获取）">
                              <input
                                className={INPUT_CLASS}
                                placeholder="wxid_xxx,wxid_yyy"
                                value={form.weixin.ownerUserIds}
                                onChange={(e) => updateWeixin({ ownerUserIds: e.target.value })}
                              />
                            </FormField>
                            <div className="flex items-center justify-between py-1">
                              <div>
                                <div className="text-xs font-medium text-ink-800">接收媒体附件</div>
                                <div className="text-[11px] text-muted">开启后自动下载并转发图片、文件、语音、视频</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => updateWeixin({ mediaEnabled: !form.weixin.mediaEnabled })}
                                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                                  form.weixin.mediaEnabled ? "bg-accent" : "bg-ink-900/15"
                                }`}
                              >
                                <span
                                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${
                                    form.weixin.mediaEnabled ? "translate-x-4" : "translate-x-0"
                                  }`}
                                />
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* Test result */}
                    {testResult && (
                      <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                        testResult.success
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-red-50 text-red-700 border border-red-200"
                      }`}>
                        {testResult.success ? (
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
                          </svg>
                        )}
                        {testResult.message}
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="mt-auto pt-5 flex items-center gap-3">
                    <button onClick={handleSave} disabled={saving}
                      className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:opacity-50">
                      {saving ? "保存中…" : "保存配置"}
                    </button>
                    <button onClick={handleTestConnection} disabled={testing}
                      className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2 text-sm text-ink-700 hover:bg-surface-tertiary transition-colors disabled:opacity-50">
                      {testing ? "测试中…" : "测试连接"}
                    </button>
                    <button
                      onClick={handleToggleConnect}
                      disabled={connecting || effectiveStatus === "connecting"}
                      className={`rounded-xl border px-4 py-2 text-sm transition-colors disabled:opacity-50 ${
                        effectiveStatus === "connected"
                          ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                          : "border-ink-900/10 bg-surface-secondary text-ink-700 hover:bg-surface-tertiary"
                      }`}>
                      {connecting || effectiveStatus === "connecting" ? "连接中…" :
                       effectiveStatus === "connected" ? "断开" : "连接"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex justify-end px-5 py-3 border-t border-ink-900/6 flex-shrink-0">
            <Dialog.Close asChild>
              <button className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors">
                完成
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
