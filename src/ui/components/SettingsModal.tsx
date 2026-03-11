import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  defaultAssistantUsesProvider,
  maybeSwitchDefaultAssistantToOpenAI,
} from "../lib/openai-default-assistant";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowSplash?: () => void;
  darkMode?: boolean;
  onDarkModeChange?: (enabled: boolean) => void;
}

type SectionId = "personalize" | "models" | "usage" | "proxy" | "google" | "memory" | "shortcut" | "alert" | "debug";

interface NavItem {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "personalize",
    label: "个性化",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "经验",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <path d="M12 11v6M9 14h6" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "模型设置",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 6V4M10 6V4M14 6V4M18 6V4M6 18v2M10 18v2M14 18v2M18 18v2" />
        <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "usage",
    label: "使用统计",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 3v18h18" />
        <path d="M7 14l3-3 3 2 4-5" />
        <circle cx="7" cy="14" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="10" cy="11" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="13" cy="13" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="17" cy="8" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "proxy",
    label: "代理设置",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: "shortcut",
    label: "快捷键",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h4M14 8h4M8 12h8M10 16h4" />
      </svg>
    ),
  },
  {
    id: "google",
    label: "账号",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
        <polyline points="10 17 15 12 10 7" />
        <line x1="15" y1="12" x2="3" y2="12" />
      </svg>
    ),
  },
  {
    id: "alert",
    label: "告警",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    ),
  },
  {
    id: "debug",
    label: "调试",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v8a6 6 0 0 0 12 0v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />
        <path d="M9 14h6M9 18h6M2 10h4M18 10h4M2 14h4M18 14h4" />
      </svg>
    ),
  },
];

export function SettingsModal({ open, onOpenChange, onShowSplash, darkMode, onDarkModeChange }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("personalize");

  // Personalization
  const [userName, setUserName] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [userContext, setUserContext] = useState("");

  // API settings
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [modelName, setModelName] = useState("claude-opus-4-6-thinking");
  const [showToken, setShowToken] = useState(false);

  // Proxy settings
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");

  // Model tab
  const [modelTab, setModelTab] = useState<"anthropic" | "openai">("anthropic");

  // Usage statistics state
  const [usageRange, setUsageRange] = useState<UsageRange>("24h");
  const [usageTab, setUsageTab] = useState<"logs" | "providers">("logs");
  const [usageStatusFilter, setUsageStatusFilter] = useState<"all" | "ok" | "error">("all");
  const [usageModelFilter, setUsageModelFilter] = useState("");
  const [usageSummary, setUsageSummary] = useState<UsageSummary>({
    totalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  const [usageLogs, setUsageLogs] = useState<UsageRecord[]>([]);
  const [providerStats, setProviderStats] = useState<ProviderStat[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  // OpenAI auth state
  const [openaiLoggedIn, setOpenaiLoggedIn] = useState(false);
  const [openaiEmail, setOpenaiEmail] = useState<string | undefined>();
  const [openaiExpiresAt, setOpenaiExpiresAt] = useState<number | undefined>();
  const [openaiLoggingIn, setOpenaiLoggingIn] = useState(false);
  const [openaiError, setOpenaiError] = useState<string | null>(null);
  const [openaiAuthMode, setOpenaiAuthMode] = useState<"oauth" | "api">("oauth");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [openaiDefaultAssistantReady, setOpenaiDefaultAssistantReady] = useState(false);

  // Google auth state
  const [googleLoggedIn, setGoogleLoggedIn] = useState(false);
  const [googleEmail, setGoogleEmail] = useState<string | undefined>();
  const [googleName, setGoogleName] = useState<string | undefined>();
  const [googlePicture, setGooglePicture] = useState<string | undefined>();
  const [avatarError, setAvatarError] = useState(false);
  const [googleLoggingIn, setGoogleLoggingIn] = useState(false);
  const [googleLoginError, setGoogleLoginError] = useState<string | null>(null);

  // Memory state
  const [memoryDir, setMemoryDir] = useState("");
  const [kbPath, setKbPath] = useState("");

  // Shortcut state
  const [quickShortcut, setQuickShortcut] = useState("Alt+Space");
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [shortcutSaved, setShortcutSaved] = useState(false);

  // Alert settings
  const [alertWebhook, setAlertWebhook] = useState("");
  const [alertSecret, setAlertSecret] = useState("");
  const [showAlertSecret, setShowAlertSecret] = useState(false);
  const [alertTestResult, setAlertTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // UI state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const loadOpenAIStatus = async () => {
    try {
      const status = await window.electron.openaiAuthStatus();
      setOpenaiLoggedIn(status.loggedIn);
      setOpenaiEmail(status.email);
      setOpenaiExpiresAt(status.expiresAt);
    } catch {
      // Ignore
    }
  };

  const loadOpenAIRoutingStatus = async () => {
    try {
      const config = await window.electron.getAssistantsConfig();
      setOpenaiDefaultAssistantReady(defaultAssistantUsesProvider(config, "openai"));
    } catch {
      setOpenaiDefaultAssistantReady(false);
    }
  };

  const loadGoogleStatus = async () => {
    try {
      const status = await window.electron.googleAuthStatus();
      setGoogleLoggedIn(status.loggedIn);
      setGoogleEmail(status.email);
      setGoogleName(status.name);
      setGooglePicture(status.picture);
      setAvatarError(false);
    } catch {
      // Ignore
    }
  };

  const loadMemoryDir = async () => {
    try {
      const list = await window.electron.memoryList();
      setMemoryDir(list.memoryDir);
    } catch {
      // Ignore
    }
  };

  const loadUsageStats = useCallback(async () => {
    setUsageLoading(true);
    try {
      const filter: UsageFilter = {
        range: usageRange,
        status: usageStatusFilter === "all" ? undefined : usageStatusFilter,
        model: usageModelFilter.trim() || undefined,
      };
      const [summary, logs, providers] = await Promise.all([
        window.electron.getUsageSummary(filter),
        window.electron.getUsageLogs({ ...filter, limit: 200, offset: 0 }),
        window.electron.getProviderStats(filter),
      ]);
      setUsageSummary(summary);
      setUsageLogs(logs);
      setProviderStats(providers);
    } catch (error) {
      console.error("Failed to load usage stats:", error);
      setUsageSummary({
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      setUsageLogs([]);
      setProviderStats([]);
    } finally {
      setUsageLoading(false);
    }
  }, [usageRange, usageStatusFilter, usageModelFilter]);

  useEffect(() => {
    if (open) {
      window.electron.getUserSettings().then((settings) => {
        setUserName(settings.userName ?? "");
        setWorkDescription(settings.workDescription ?? "");
        setGlobalPrompt(settings.globalPrompt ?? "");
        setBaseUrl(settings.anthropicBaseUrl ?? "");
        setAuthToken(settings.anthropicAuthToken ?? "");
        setModelName(settings.anthropicModel ?? "claude-opus-4-6-thinking");
        setProxyEnabled(settings.proxyEnabled ?? false);
        setProxyUrl(settings.proxyUrl ?? "");
        setAlertWebhook(settings.alertDingtalkWebhook ?? "");
        setAlertSecret(settings.alertDingtalkSecret ?? "");
        setOpenaiApiKey(settings.openaiApiKey ?? "");
        setOpenaiBaseUrl(settings.openaiBaseUrl ?? "");
        setOpenaiModel(settings.openaiModel ?? "");
        if (settings.openaiApiKey) setOpenaiAuthMode("api");
        setSaved(false);
        setValidationError(null);
        setAlertTestResult(null);
      });
      window.electron.getAssistantsConfig().then((config) => {
        setUserContext(config.userContext ?? "");
      });
      loadOpenAIStatus();
      loadOpenAIRoutingStatus();
      loadGoogleStatus();
      loadMemoryDir();
      window.electron.getKnowledgeBasePath().then(setKbPath).catch(() => {});
      window.electron.getQuickWindowShortcut().then(setQuickShortcut).catch(() => {});
      setShortcutSaved(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && activeSection === "usage") {
      loadUsageStats();
    }
  }, [open, activeSection, loadUsageStats]);

  const handleSave = async () => {
    setValidationError(null);

    if (activeSection === "models") {
      const hasCustomConfig = baseUrl.trim() || authToken.trim();
      if (hasCustomConfig) {
        setValidating(true);
        try {
          const result = await window.electron.validateApiConfig(
            baseUrl.trim() || undefined,
            authToken.trim() || undefined,
            modelName.trim() || undefined
          );
          if (!result.valid) {
            setValidationError(result.message);
            setValidating(false);
            return;
          }
        } catch (error) {
          setValidationError("验证失败: " + (error instanceof Error ? error.message : String(error)));
          setValidating(false);
          return;
        }
        setValidating(false);
      }
    }

    if (activeSection === "proxy" && proxyEnabled && proxyUrl.trim()) {
      const proxyPattern = /^(https?|socks5?):\/\/[^\s]+$/i;
      if (!proxyPattern.test(proxyUrl.trim())) {
        setValidationError("代理地址格式无效，应为 http://host:port 或 socks5://host:port");
        return;
      }
    }

    setSaving(true);
    try {
      if (activeSection === "shortcut") {
        await window.electron.saveQuickWindowShortcut(quickShortcut);
        setShortcutSaved(true);
        setTimeout(() => setShortcutSaved(false), 2000);
      } else {
        await window.electron.saveUserSettings({
          anthropicBaseUrl: baseUrl.trim() || undefined,
          anthropicAuthToken: authToken.trim() || undefined,
          anthropicModel: modelName.trim() || undefined,
          proxyEnabled,
          proxyUrl: proxyUrl.trim() || undefined,
          userName: userName.trim(),
          workDescription: workDescription.trim(),
          globalPrompt: globalPrompt.trim(),
          alertDingtalkWebhook: alertWebhook.trim() || undefined,
          alertDingtalkSecret: alertSecret.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || undefined,
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
          openaiModel: openaiModel.trim() || undefined,
        });
        if (activeSection === "personalize") {
          const assistantsConfig = await window.electron.getAssistantsConfig();
          await window.electron.saveAssistantsConfig({
            ...assistantsConfig,
            userContext: userContext.trim() || undefined,
          });
        }
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);

      if (activeSection === "alert" && alertWebhook.trim()) {
        setAlertTestResult(null);
        try {
          const result = await window.electron.testAlertWebhook(
            alertWebhook.trim(),
            alertSecret.trim() || undefined,
          );
          setAlertTestResult(result);
        } catch {
          setAlertTestResult({ ok: false, error: "测试请求发送失败" });
        }
      }
    } catch (error) {
      console.error("Failed to save settings:", error);
      setValidationError("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleClearApi = () => {
    setBaseUrl("");
    setAuthToken("");
  };

  const handleClearProxy = () => {
    setProxyEnabled(false);
    setProxyUrl("");
  };

  const hasApiChanges = baseUrl.trim() !== "" || authToken.trim() !== "";
  const hasProxyChanges = proxyEnabled || proxyUrl.trim() !== "";
  const showSaveButton = activeSection === "personalize" || activeSection === "models" || activeSection === "proxy" || activeSection === "shortcut" || activeSection === "alert";

  const currentNavItem = NAV_ITEMS.find((item) => item.id === activeSection);
  const providerLabel = (provider: "anthropic" | "openai") => {
    if (provider === "openai") return "OpenAI";
    return "Anthropic";
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/25 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[960px] h-[680px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/8 shadow-elevated overflow-hidden flex flex-col bg-surface-secondary" style={{ fontFamily: '"Söhne", ui-sans-serif, system-ui, -apple-system, sans-serif' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-ink-900/8 flex-shrink-0">
            <Dialog.Title className="text-[16px] font-semibold text-ink-900 tracking-tight">
              {currentNavItem?.label ?? "设置"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-full p-1.5 text-ink-400 hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {/* Body: sidebar + content */}
          <div className="flex flex-1 overflow-hidden">

            {/* Left sidebar */}
            <nav className="w-[192px] border-r border-ink-900/8 flex-shrink-0 overflow-y-auto py-3 px-2.5 bg-surface-secondary">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveSection(item.id);
                    setValidationError(null);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-[13px] transition-all text-left mb-0.5 ${
                    activeSection === item.id
                      ? "font-medium text-white"
                      : "text-ink-600 hover:bg-black/5 hover:text-ink-900"
                  }`}
                  style={activeSection === item.id ? { background: 'var(--color-accent)' } : {}}
                >
                  <span className={activeSection === item.id ? "text-white/80" : "text-ink-400"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Right content area */}
            <main className={`flex-1 px-6 py-5 bg-surface-secondary ${activeSection === "usage" ? "overflow-hidden flex flex-col" : "overflow-y-auto"}`}>

              {/* Personalization */}
              {activeSection === "personalize" && (
                <div className="grid gap-6">
                  <label className="grid gap-2">
                    <div>
                      <span className="text-[14px] font-medium text-ink-800">姓名</span>
                      <p className="text-[12px] text-ink-400 mt-0.5">让 AI 知道你是谁</p>
                    </div>
                    <input
                      type="text"
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="输入你的名字"
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-2">
                    <div>
                      <span className="text-[14px] font-medium text-ink-800">工作描述</span>
                      <p className="text-[12px] text-ink-400 mt-0.5">帮助 AI 理解你的背景，以便提供更贴合的回答</p>
                    </div>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors resize-none leading-relaxed"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="例如：我是一名前端工程师，主要使用 React 和 TypeScript 开发 Web 应用"
                      rows={3}
                      value={workDescription}
                      onChange={(e) => setWorkDescription(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-2">
                    <div>
                      <span className="text-[14px] font-medium text-ink-800">全局提示词</span>
                      <p className="text-[12px] text-ink-400 mt-0.5">自定义指令会附加到每次对话的系统提示词中</p>
                    </div>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors resize-none leading-relaxed"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="给 AI 的自定义指令，例如：请用中文回答，代码注释用英文"
                      rows={4}
                      value={globalPrompt}
                      onChange={(e) => setGlobalPrompt(e.target.value)}
                    />
                  </label>

                  <label className="grid gap-2">
                    <div>
                      <span className="text-[14px] font-medium text-ink-800">关于我</span>
                      <p className="text-[12px] text-ink-400 mt-0.5">所有助理共享的用户信息，注入到每次对话中</p>
                    </div>
                    <textarea
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors resize-none leading-relaxed"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="所有助理共享的用户信息：姓名、时区、工作领域、沟通偏好等"
                      rows={3}
                      value={userContext}
                      onChange={(e) => setUserContext(e.target.value)}
                    />
                  </label>

                  {/* Dark mode toggle */}
                  <div className="flex items-center justify-between rounded-xl border border-ink-900/8 bg-surface/70 px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900/5">
                        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-ink-600" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      </div>
                      <div>
                        <span className="text-[14px] font-medium text-ink-800">夜间模式</span>
                        <p className="text-[12px] text-ink-400 mt-0.5">降低屏幕亮度，保护眼睛</p>
                      </div>
                    </div>
                    <label className="relative cursor-pointer">
                      <input
                        type="checkbox"
                        checked={darkMode ?? false}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          onDarkModeChange?.(enabled);
                          window.electron.saveUserSettings({ darkMode: enabled }).catch(console.error);
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-6 rounded-full transition-colors" style={{ background: (darkMode ?? false) ? 'var(--color-accent)' : 'var(--color-toggle-off)' }} />
                      <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform" style={{ transform: (darkMode ?? false) ? 'translateX(16px)' : 'translateX(0)' }} />
                    </label>
                  </div>
                </div>
              )}

              {/* Model / API Settings */}
              {activeSection === "models" && (
                <div className="grid gap-5">
                  {/* Underline tab switcher */}
                  <div className="flex border-b border-ink-900/8">
                    <button
                      type="button"
                      onClick={() => setModelTab("anthropic")}
                      className={`relative px-4 py-2.5 text-[14px] font-medium transition-colors ${modelTab === "anthropic" ? "text-ink-900" : "text-ink-400 hover:text-ink-600"}`}
                    >
                      Anthropic
                      {modelTab === "anthropic" && (
                        <span className="absolute bottom-0 left-4 right-4 h-[2px] rounded-full" style={{ background: "var(--color-accent)" }} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setModelTab("openai")}
                      className={`relative px-4 py-2.5 text-[14px] font-medium transition-colors flex items-center gap-1.5 ${modelTab === "openai" ? "text-ink-900" : "text-ink-400 hover:text-ink-600"}`}
                    >
                      OpenAI
                      {(openaiLoggedIn || openaiApiKey.trim()) && (
                        <span className="h-1.5 w-1.5 rounded-full bg-success flex-shrink-0" />
                      )}
                      {modelTab === "openai" && (
                        <span className="absolute bottom-0 left-4 right-4 h-[2px] rounded-full" style={{ background: "var(--color-accent)" }} />
                      )}
                    </button>
                  </div>

                  {/* Anthropic tab */}
                  {modelTab === "anthropic" && (
                    <div className="grid gap-5">
                      <label className="grid gap-2">
                        <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">API 地址</span>
                        <input
                          type="url"
                          className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors"
                          onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                          onBlur={(e) => e.currentTarget.style.borderColor = ''}
                          placeholder="https://api.anthropic.com （可选）"
                          value={baseUrl}
                          onChange={(e) => setBaseUrl(e.target.value)}
                        />
                        <span className="text-[12px] text-ink-400">自定义 API 端点，用于第三方兼容服务</span>
                      </label>

                      <label className="grid gap-2">
                        <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">API Token</span>
                        <div className="relative">
                          <input
                            type={showToken ? "text" : "password"}
                            className="w-full rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 pr-12 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                            onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                            onBlur={(e) => e.currentTarget.style.borderColor = ''}
                            placeholder="sk-ant-..."
                            value={authToken}
                            onChange={(e) => setAuthToken(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => setShowToken(!showToken)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-400 hover:text-ink-700 transition-colors"
                            aria-label={showToken ? "Hide token" : "Show token"}
                          >
                            {showToken ? (
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <span className="text-[12px] text-ink-400">
                          从{" "}
                          <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
                            console.anthropic.com
                          </a>
                          {" "}获取 API Key
                        </span>
                      </label>

                      <label className="grid gap-2">
                        <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">模型</span>
                        <input
                          type="text"
                          className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                          onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                          onBlur={(e) => e.currentTarget.style.borderColor = ''}
                          placeholder="claude-opus-4-6-thinking"
                          value={modelName}
                          onChange={(e) => setModelName(e.target.value)}
                        />
                        <span className="text-[12px] text-ink-400">
                          Claude 模型名称，如 claude-opus-4-6-thinking、claude-sonnet-4-20250514 等
                        </span>
                      </label>

                      {hasApiChanges && (
                        <button
                          type="button"
                          onClick={handleClearApi}
                          className="text-left text-[12px] text-ink-400 hover:text-error transition-colors"
                        >
                          清除 API 设置
                        </button>
                      )}

                      <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                        <p className="text-[13px] text-info leading-relaxed">
                          <strong>注意：</strong>这里的设置优先于环境变量。修改后对新会话生效。
                        </p>
                      </div>
                    </div>
                  )}

                  {/* OpenAI tab */}
                  {modelTab === "openai" && (
                    <div className="grid gap-5">
                      {/* Segmented control */}
                      <div className="flex rounded-xl bg-ink-900/5 p-1">
                        {(["oauth", "api"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setOpenaiAuthMode(mode)}
                            className={`flex-1 rounded-lg px-4 py-2 text-[13px] font-medium transition-all ${
                              openaiAuthMode === mode
                                ? "bg-surface text-ink-900 shadow-sm"
                                : "text-ink-400 hover:text-ink-600"
                            }`}
                          >
                            {mode === "oauth" ? "网页授权" : "API 密钥"}
                          </button>
                        ))}
                      </div>

                      {/* OAuth mode */}
                      {openaiAuthMode === "oauth" && (
                        <>
                          {openaiLoggedIn ? (
                            <>
                              <div className="rounded-xl border border-success/20 bg-success/5 p-4">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 flex-shrink-0">
                                    <svg viewBox="0 0 24 24" className="h-5 w-5 text-success" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M5 12l4 4L19 6" />
                                    </svg>
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[14px] font-medium text-ink-800">已登录 OpenAI</p>
                                    {openaiEmail && (
                                      <p className="text-[13px] text-ink-500 truncate">{openaiEmail}</p>
                                    )}
                                    {openaiExpiresAt && (
                                      <p className="text-[12px] text-ink-400 mt-0.5">
                                        Token 过期: {new Date(openaiExpiresAt).toLocaleString("zh-CN")}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.electron.openaiLogout();
                                  setOpenaiLoggedIn(false);
                                  setOpenaiEmail(undefined);
                                  setOpenaiExpiresAt(undefined);
                                }}
                                className="w-full rounded-xl border border-error/20 bg-surface px-4 py-3 text-[14px] font-medium text-error hover:bg-error/5 transition-colors"
                              >
                                退出登录
                              </button>

                              <div className="rounded-xl border border-ink-900/8 bg-surface/60 p-4 grid gap-3">
                                <p className="text-[13px] font-semibold text-ink-800">
                                  {openaiDefaultAssistantReady ? "当前已可直接开始 Codex 对话" : "如何让 Claude Agent 使用 OpenAI API"}
                                </p>
                                {openaiDefaultAssistantReady ? (
                                  <div className="rounded-xl border border-success/20 bg-success/5 px-4 py-3">
                                    <p className="text-[13px] text-success leading-relaxed">
                                      当前默认助手已经使用 OpenAI。直接开始一个新对话，请求就会通过本地代理转发到 OpenAI，并使用当前登录的 ChatGPT 令牌。
                                    </p>
                                  </div>
                                ) : (
                                  <ol className="grid gap-2 list-none">
                                    {[
                                      { n: "1", text: "前往「助手管理」，新建或编辑一个助手" },
                                      { n: "2", text: "将 Provider 下拉改为「OpenAI」" },
                                      { n: "3", text: "保存后，该助手的所有对话将通过本地代理转发至 OpenAI API，使用当前登录的 ChatGPT 令牌" },
                                    ].map((step) => (
                                      <li key={step.n} className="flex items-start gap-2.5">
                                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-bold text-accent mt-0.5">{step.n}</span>
                                        <span className="text-[13px] text-ink-500 leading-relaxed">{step.text}</span>
                                      </li>
                                    ))}
                                  </ol>
                                )}
                                <p className="text-[12px] text-ink-400 pt-2 border-t border-ink-900/5">
                                  无需额外 API Key，请求由本地 HTTP 代理（Anthropic → OpenAI 格式翻译）自动处理。
                                </p>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="rounded-xl border border-ink-900/8 bg-surface/70 p-5">
                                <div className="flex items-center gap-3 mb-4">
                                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-900/5 flex-shrink-0">
                                    <svg viewBox="0 0 24 24" className="h-5 w-5 text-ink-700" fill="currentColor">
                                      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                                    </svg>
                                  </div>
                                  <div>
                                    <p className="text-[14px] font-medium text-ink-800">ChatGPT 登录</p>
                                    <p className="text-[12px] text-ink-400 mt-0.5">使用 Plus/Pro 订阅访问 OpenAI 模型，无需额外 API 费用</p>
                                  </div>
                                </div>
                                <p className="text-[13px] text-ink-500 leading-relaxed">
                                  通过 ChatGPT 账号 OAuth 授权，使用与 OpenAI CLI 相同的认证流程。需要有效的 ChatGPT Plus 或 Pro 订阅。若当前仍是唯一的内置默认助手且未配置 Claude，登录后会自动切换到 OpenAI。
                                </p>
                              </div>

                              <button
                                type="button"
                                onClick={async () => {
                                  setOpenaiLoggingIn(true);
                                  setOpenaiError(null);
                                  try {
                                    const result = await window.electron.openaiLogin();
                                    if (result.success) {
                                      setOpenaiLoggedIn(true);
                                      setOpenaiEmail(result.email);
                                      const [settings, assistantsConfig] = await Promise.all([
                                        window.electron.getUserSettings(),
                                        window.electron.getAssistantsConfig(),
                                      ]);
                                      const migration = maybeSwitchDefaultAssistantToOpenAI(assistantsConfig, {
                                        hasClaudeAuth: !!settings.anthropicAuthToken?.trim(),
                                      });
                                      if (migration.changed) {
                                        await window.electron.saveAssistantsConfig(migration.config);
                                      }
                                      await loadOpenAIStatus();
                                      setOpenaiDefaultAssistantReady(defaultAssistantUsesProvider(migration.config, "openai"));
                                    } else {
                                      setOpenaiError(result.error || "登录失败");
                                    }
                                  } catch (err) {
                                    setOpenaiError("登录出错: " + (err instanceof Error ? err.message : String(err)));
                                  } finally {
                                    setOpenaiLoggingIn(false);
                                  }
                                }}
                                disabled={openaiLoggingIn}
                                className="w-full rounded-xl px-4 py-3 text-[14px] font-medium text-white shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                style={{ background: '#10a37f' }}
                              >
                                {openaiLoggingIn ? (
                                  <span className="flex items-center justify-center gap-2">
                                    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                    正在打开登录窗口...
                                  </span>
                                ) : (
                                  <span className="flex items-center justify-center gap-2">
                                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                                    </svg>
                                    使用 ChatGPT 登录
                                  </span>
                                )}
                              </button>

                              {openaiError && (
                                <div className="rounded-xl border border-error/20 bg-error/5 px-4 py-3">
                                  <p className="text-[13px] text-error flex items-start gap-2">
                                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                                      <circle cx="12" cy="12" r="10" />
                                      <line x1="15" y1="9" x2="9" y2="15" />
                                      <line x1="9" y1="9" x2="15" y2="15" />
                                    </svg>
                                    <span>{openaiError}</span>
                                  </p>
                                </div>
                              )}
                            </>
                          )}
                        </>
                      )}

                      {/* API key mode */}
                      {openaiAuthMode === "api" && (
                        <div className="grid gap-5">
                          <label className="grid gap-2">
                            <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">API 地址</span>
                            <input
                              type="url"
                              className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors"
                              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                              onBlur={(e) => e.currentTarget.style.borderColor = ''}
                              placeholder="https://api.openai.com（可选）"
                              value={openaiBaseUrl}
                              onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                            />
                            <span className="text-[12px] text-ink-400">自定义 API 端点，留空则使用 OpenAI 官方地址</span>
                          </label>

                          <label className="grid gap-2">
                            <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">API Key</span>
                            <div className="relative">
                              <input
                                type={showOpenaiApiKey ? "text" : "password"}
                                className="w-full rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 pr-12 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                                onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                                onBlur={(e) => e.currentTarget.style.borderColor = ''}
                                placeholder="sk-..."
                                value={openaiApiKey}
                                onChange={(e) => setOpenaiApiKey(e.target.value)}
                              />
                              <button
                                type="button"
                                onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-400 hover:text-ink-700 transition-colors"
                                aria-label={showOpenaiApiKey ? "Hide API key" : "Show API key"}
                              >
                                {showOpenaiApiKey ? (
                                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                )}
                              </button>
                            </div>
                            <span className="text-[12px] text-ink-400">
                              从{" "}
                              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--color-accent)' }}>
                                platform.openai.com
                              </a>
                              {" "}获取 API Key
                            </span>
                          </label>

                          <label className="grid gap-2">
                            <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">模型</span>
                            <input
                              type="text"
                              className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                              onBlur={(e) => e.currentTarget.style.borderColor = ''}
                              placeholder="gpt-5.4（可选，留空使用默认映射）"
                              value={openaiModel}
                              onChange={(e) => setOpenaiModel(e.target.value)}
                            />
                            <span className="text-[12px] text-ink-400">
                              填写后将忽略模型映射，直接使用指定的模型名称
                            </span>
                          </label>

                          {(openaiApiKey.trim() || openaiBaseUrl.trim() || openaiModel.trim()) && (
                            <button
                              type="button"
                              onClick={() => {
                                setOpenaiApiKey("");
                                setOpenaiBaseUrl("");
                                setOpenaiModel("");
                              }}
                              className="text-left text-[12px] text-ink-400 hover:text-error transition-colors"
                            >
                              清除 API 设置
                            </button>
                          )}

                          <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                            <p className="text-[13px] text-info leading-relaxed">
                              <strong>说明：</strong>配置 API Key 后，OpenAI 请求将直接使用此密钥认证，优先于网页授权。支持 OpenAI 官方 API 及兼容服务。
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              )}

              {/* Usage Statistics */}
              {activeSection === "usage" && (
                <div className="flex flex-col gap-5 h-full">
                  {/* Time range + refresh */}
                  <div className="flex items-center justify-between flex-shrink-0">
                    <div className="inline-flex items-center rounded-full bg-ink-900/5 p-[3px] gap-[2px]">
                      {[
                        { key: "24h" as UsageRange, label: "24h" },
                        { key: "7d" as UsageRange, label: "7天" },
                        { key: "30d" as UsageRange, label: "30天" },
                        { key: "all" as UsageRange, label: "全部" },
                      ].map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setUsageRange(item.key)}
                          className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition-all ${usageRange === item.key ? "text-white shadow-sm" : "text-ink-500 hover:text-ink-700"}`}
                          style={usageRange === item.key ? { background: "var(--color-accent)" } : {}}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={loadUsageStats}
                      disabled={usageLoading}
                      className="flex items-center gap-1.5 rounded-full border border-ink-900/10 bg-surface px-4 py-1.5 text-[13px] text-ink-600 hover:bg-surface-tertiary hover:text-ink-800 transition-colors disabled:opacity-50"
                    >
                      <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${usageLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                        <path d="M21 3v6h-6" />
                      </svg>
                      {usageLoading ? "刷新中" : "刷新"}
                    </button>
                  </div>

                  {/* Summary cards */}
                  <div className="grid grid-cols-3 gap-4 flex-shrink-0">
                    <div className="rounded-xl border border-ink-900/6 bg-surface px-5 py-4">
                      <p className="text-[13px] text-ink-500">总请求</p>
                      <p className="mt-2 text-[32px] font-bold text-ink-900 leading-none tracking-tight">{usageSummary.totalRequests.toLocaleString()}</p>
                    </div>
                    <div className="rounded-xl border border-ink-900/6 bg-surface px-5 py-4">
                      <p className="text-[13px] text-ink-500">总 Token</p>
                      <p className="mt-2 text-[32px] font-bold text-ink-900 leading-none tracking-tight">{fmtTokens(usageSummary.totalTokens)}</p>
                      <p className="mt-2 text-[12px] text-ink-400">输入 {fmtTokens(usageSummary.inputTokens)} / 输出 {fmtTokens(usageSummary.outputTokens)}</p>
                    </div>
                    <div className="rounded-xl border border-ink-900/6 bg-surface px-5 py-4">
                      <p className="text-[13px] text-ink-500">缓存 Token</p>
                      <p className="mt-2 text-[32px] font-bold text-ink-900 leading-none tracking-tight">{fmtTokens(usageSummary.cacheReadTokens + usageSummary.cacheCreationTokens)}</p>
                      <p className="mt-2 text-[12px] text-ink-400">命中 {fmtTokens(usageSummary.cacheReadTokens)} / 创建 {fmtTokens(usageSummary.cacheCreationTokens)}</p>
                    </div>
                  </div>

                  {/* Tab bar + filters + table */}
                  <div className="flex flex-col flex-1 min-h-0">
                    {/* Tab bar */}
                    <div className="flex items-center justify-between border-b border-ink-900/8 flex-shrink-0">
                      <div className="flex gap-0">
                        {[
                          { key: "logs" as const, label: "请求日志" },
                          { key: "providers" as const, label: "供应商统计" },
                        ].map((tab) => (
                          <button
                            key={tab.key}
                            type="button"
                            onClick={() => setUsageTab(tab.key)}
                            className={`relative px-4 py-2.5 text-[13px] font-medium transition-colors ${usageTab === tab.key ? "text-ink-900" : "text-ink-400 hover:text-ink-600"}`}
                          >
                            {tab.label}
                            {usageTab === tab.key && (
                              <span className="absolute bottom-0 left-4 right-4 h-[2px] rounded-full" style={{ background: "var(--color-accent)" }} />
                            )}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await window.electron.clearUsageLogs();
                          await loadUsageStats();
                        }}
                        className="px-3 py-1.5 text-[12px] text-error/70 hover:text-error transition-colors"
                      >
                        清空日志
                      </button>
                    </div>

                    {usageTab === "logs" && (
                      <div className="flex flex-col flex-1 min-h-0 mt-3 gap-3">
                        {/* Filter row */}
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <input
                            type="text"
                            value={usageModelFilter}
                            onChange={(e) => setUsageModelFilter(e.target.value)}
                            placeholder="按模型筛选..."
                            className="flex-1 rounded-lg border border-ink-900/10 bg-surface px-3.5 py-2 text-[13px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors"
                            onFocus={(e) => e.currentTarget.style.borderColor = "var(--color-accent)"}
                            onBlur={(e) => e.currentTarget.style.borderColor = ""}
                          />
                          <select
                            value={usageStatusFilter}
                            onChange={(e) => setUsageStatusFilter(e.target.value as "all" | "ok" | "error")}
                            className="w-[120px] rounded-lg border border-ink-900/10 bg-surface px-3 py-2 text-[13px] text-ink-800 focus:outline-none transition-colors"
                            onFocus={(e) => e.currentTarget.style.borderColor = "var(--color-accent)"}
                            onBlur={(e) => e.currentTarget.style.borderColor = ""}
                          >
                            <option value="all">全部状态</option>
                            <option value="ok">成功</option>
                            <option value="error">失败</option>
                          </select>
                          <span className="text-[12px] text-ink-400 whitespace-nowrap">共 {usageLogs.length} 条记录</span>
                        </div>

                        {/* Table */}
                        <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-ink-900/6">
                          <table className="w-full text-left border-collapse">
                            <thead className="sticky top-0 bg-[#f7f6f4] text-ink-500 text-[12px] z-10 border-b border-ink-900/8">
                              <tr>
                                <th className="px-4 py-3 font-medium w-[170px]">时间</th>
                                <th className="px-4 py-3 font-medium w-[80px]">供应商</th>
                                <th className="px-4 py-3 font-medium">模型</th>
                                <th className="px-4 py-3 font-medium w-[140px]">Token</th>
                                <th className="px-4 py-3 font-medium w-[80px]">延迟</th>
                                <th className="px-4 py-3 font-medium w-[60px]">状态</th>
                              </tr>
                            </thead>
                            <tbody className="text-[13px]">
                              {usageLogs.length === 0 ? (
                                <tr>
                                  <td colSpan={6} className="px-4 py-12 text-center text-ink-300">
                                    暂无请求记录
                                  </td>
                                </tr>
                              ) : (
                                usageLogs.map((log) => (
                                  <tr key={log.id} className="border-t border-ink-900/5 hover:bg-ink-900/[0.02] transition-colors">
                                    <td className="px-4 py-2.5 text-ink-500 tabular-nums">{new Date(log.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                                    <td className="px-4 py-2.5 text-ink-700">{providerLabel(log.provider)}</td>
                                    <td className="px-4 py-2.5 text-ink-700 font-mono text-[12px] truncate max-w-[180px]">{log.model}</td>
                                    <td className="px-4 py-2.5 text-ink-700 tabular-nums">{fmtTokens(log.inputTokens + log.outputTokens)}</td>
                                    <td className="px-4 py-2.5 text-ink-500 tabular-nums">{(log.latencyMs / 1000).toFixed(1)}s</td>
                                    <td className="px-4 py-2.5">
                                      <span className={`inline-block h-2 w-2 rounded-full ${log.status === "ok" ? "bg-success" : "bg-error"}`} />
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {usageTab === "providers" && (
                      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-ink-900/6 mt-3">
                        <table className="w-full text-left border-collapse">
                          <thead className="sticky top-0 bg-[#f7f6f4] text-ink-500 text-[12px] z-10 border-b border-ink-900/8">
                            <tr>
                              <th className="px-4 py-3 font-medium">供应商</th>
                              <th className="px-4 py-3 font-medium text-right">请求数</th>
                              <th className="px-4 py-3 font-medium text-right">输入 Token</th>
                              <th className="px-4 py-3 font-medium text-right">输出 Token</th>
                              <th className="px-4 py-3 font-medium text-right">缓存命中</th>
                              <th className="px-4 py-3 font-medium text-right">缓存创建</th>
                            </tr>
                          </thead>
                          <tbody className="text-[13px]">
                            {providerStats.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="px-4 py-12 text-center text-ink-300">
                                  暂无统计数据
                                </td>
                              </tr>
                            ) : (
                              providerStats.map((stat) => (
                                <tr key={stat.provider} className="border-t border-ink-900/5 hover:bg-ink-900/[0.02] transition-colors">
                                  <td className="px-4 py-3 text-ink-800 font-medium">{providerLabel(stat.provider)}</td>
                                  <td className="px-4 py-3 text-ink-700 text-right tabular-nums">{stat.requests.toLocaleString()}</td>
                                  <td className="px-4 py-3 text-ink-700 text-right tabular-nums">{fmtTokens(stat.inputTokens)}</td>
                                  <td className="px-4 py-3 text-ink-700 text-right tabular-nums">{fmtTokens(stat.outputTokens)}</td>
                                  <td className="px-4 py-3 text-ink-700 text-right tabular-nums">{fmtTokens(stat.cacheReadTokens)}</td>
                                  <td className="px-4 py-3 text-ink-700 text-right tabular-nums">{fmtTokens(stat.cacheCreationTokens)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Proxy Settings */}
              {activeSection === "proxy" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-ink-500 leading-relaxed">配置网络代理，所有进程将通过此代理访问网络</p>

                  <div className="flex items-center justify-between rounded-xl border border-ink-900/8 bg-surface/70 px-4 py-3.5">
                    <span className="text-[14px] font-medium text-ink-800">代理服务器</span>
                    <label className="relative cursor-pointer">
                      <input
                        type="checkbox"
                        checked={proxyEnabled}
                        onChange={(e) => setProxyEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-6 rounded-full transition-colors" style={{ background: proxyEnabled ? 'var(--color-accent)' : 'var(--color-toggle-off)' }} />
                      <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform" style={{ transform: proxyEnabled ? 'translateX(16px)' : 'translateX(0)' }} />
                    </label>
                  </div>

                  <label className="grid gap-2">
                    <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">代理地址</span>
                    <input
                      type="text"
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="http://127.0.0.1:7890"
                      value={proxyUrl}
                      onChange={(e) => setProxyUrl(e.target.value)}
                      disabled={!proxyEnabled}
                    />
                    <span className="text-[12px] text-ink-400">
                      支持 HTTP 和 SOCKS5 代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
                    </span>
                  </label>

                  {hasProxyChanges && (
                    <button
                      type="button"
                      onClick={handleClearProxy}
                      className="text-left text-[12px] text-ink-400 hover:text-error transition-colors"
                    >
                      清除代理设置
                    </button>
                  )}

                  <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                    <p className="text-[13px] text-info leading-relaxed">
                      <strong>说明：</strong>代理设置将应用于 Agent 执行的所有网络请求，
                      包括 API 调用和工具执行。修改后需要重启会话生效。
                    </p>
                  </div>
                </div>
              )}


              {/* Google Account */}
              {activeSection === "google" && (
                <div>
                  {googleLoggedIn ? (
                    <div className="grid gap-5">
                      {/* Profile card */}
                      <div className="flex items-center gap-4 rounded-xl bg-surface border border-ink-900/6 p-5">
                        {googlePicture && !avatarError ? (
                          <img
                            src={googlePicture}
                            alt=""
                            className="h-16 w-16 rounded-full object-cover ring-2 ring-white shadow-soft shrink-0"
                            referrerPolicy="no-referrer"
                            onError={() => setAvatarError(true)}
                          />
                        ) : (
                          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 ring-2 ring-white shadow-soft shrink-0">
                            <span className="text-2xl font-semibold text-accent">
                              {(googleName || googleEmail || "U").charAt(0).toUpperCase()}
                            </span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-[16px] font-semibold text-ink-900 truncate">{googleName || "—"}</p>
                          <p className="text-[14px] text-ink-500 mt-1 truncate">{googleEmail || "—"}</p>
                        </div>
                      </div>

                      {/* Info rows */}
                      <div className="rounded-xl bg-surface border border-ink-900/6 divide-y divide-ink-900/5">
                        <div className="flex items-center justify-between px-5 py-3.5">
                          <span className="text-[13px] text-ink-500">昵称</span>
                          <span className="text-[14px] font-medium text-ink-800">{googleName || "—"}</span>
                        </div>
                        <div className="flex items-center justify-between px-5 py-3.5">
                          <span className="text-[13px] text-ink-500">邮箱</span>
                          <span className="text-[14px] text-ink-600">{googleEmail || "—"}</span>
                        </div>
                        <div className="flex items-center justify-between px-5 py-3.5">
                          <span className="text-[13px] text-ink-500">登录方式</span>
                          <div className="flex items-center gap-1.5">
                            <svg viewBox="0 0 24 24" className="h-4 w-4">
                              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                            </svg>
                            <span className="text-[14px] text-ink-600">Google</span>
                          </div>
                        </div>
                      </div>

                      {/* Logout */}
                      <button
                        type="button"
                        onClick={async () => {
                          await window.electron.googleLogout();
                          setGoogleLoggedIn(false);
                          setGoogleEmail(undefined);
                          setGoogleName(undefined);
                          setGooglePicture(undefined);
                        }}
                        className="rounded-xl border border-error/20 bg-surface px-4 py-3 text-[14px] font-medium text-error/80 hover:bg-error/5 hover:text-error transition-colors"
                      >
                        退出登录
                      </button>
                    </div>
                  ) : (
                    <div className="py-16 flex flex-col items-center gap-6">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-tertiary">
                        <svg viewBox="0 0 24 24" className="h-7 w-7 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                      </div>
                      <div className="text-center">
                        <p className="text-[15px] font-medium text-ink-700">未登录</p>
                        <p className="text-[13px] text-ink-400 mt-1">登录后可同步你的偏好设置</p>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          setGoogleLoggingIn(true);
                          setGoogleLoginError(null);
                          try {
                            const result = await window.electron.googleLogin();
                            if (result.success) {
                              await loadGoogleStatus();
                            } else {
                              setGoogleLoginError(result.error || "登录失败");
                            }
                          } catch {
                            setGoogleLoginError("登录出错");
                          } finally {
                            setGoogleLoggingIn(false);
                          }
                        }}
                        disabled={googleLoggingIn}
                        className="flex items-center gap-2.5 rounded-xl border border-ink-900/10 bg-surface px-6 py-3 text-[14px] font-medium text-ink-800 shadow-soft hover:shadow-card hover:border-ink-900/15 transition-all disabled:opacity-50"
                      >
                        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 shrink-0">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                        </svg>
                        {googleLoggingIn ? "正在登录…" : "使用 Google 登录"}
                      </button>
                      {googleLoginError && (
                        <p className="text-[13px] text-error">{googleLoginError}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Memory */}
              {activeSection === "memory" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-ink-500 leading-relaxed">
                    Agent 会自动加载记忆并主动记录重要信息；会话完成后自动抽取经验候选。所有数据以 Markdown 存储在本地。
                  </p>

                  <div className="rounded-xl border border-ink-900/8 bg-surface/70 p-5">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium text-ink-800">记忆目录</p>
                        {memoryDir && (
                          <p className="text-[12px] text-ink-400 font-mono truncate mt-0.5">{memoryDir}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        let dir = memoryDir;
                        if (!dir) {
                          try {
                            const list = await window.electron.memoryList();
                            dir = list.memoryDir;
                            setMemoryDir(dir);
                          } catch { return; }
                        }
                        if (dir) window.electron.openPath(dir);
                      }}
                      className="w-full rounded-xl px-4 py-3 text-[14px] font-medium text-white shadow-soft transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                    >
                      打开记忆目录
                    </button>
                  </div>

                  <div className="rounded-xl border border-ink-900/8 bg-surface/70 p-5">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                          <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium text-ink-800">经验库目录</p>
                        {kbPath && (
                          <p className="text-[12px] text-ink-400 font-mono truncate mt-0.5">{kbPath}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (kbPath) window.electron.openPath(kbPath);
                      }}
                      className="w-full rounded-xl px-4 py-3 text-[14px] font-medium text-white shadow-soft transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                    >
                      打开经验库目录
                    </button>
                  </div>

                  <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                    <p className="text-[13px] text-info leading-relaxed">
                      <strong>说明：</strong>记忆目录包含 MEMORY.md（长期记忆）和 daily/（每日记忆）；
                      经验库包含 experience/（经验候选）和 docs/（知识文档）。均可直接用编辑器查看和修改。
                    </p>
                  </div>
                </div>
              )}

              {/* Shortcut Settings */}
              {activeSection === "shortcut" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-ink-500 leading-relaxed">配置全局快捷键，快速唤起 AI 快捷对话窗口</p>

                  <div className="rounded-xl border border-ink-900/8 bg-surface/70 p-5">
                    <div className="flex items-center gap-3 mb-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[14px] font-medium text-ink-800">快捷工作窗口</p>
                        <p className="text-[12px] text-ink-400 mt-0.5">随时按下快捷键即可唤起一个轻量对话窗口</p>
                      </div>
                    </div>

                    <label className="grid gap-2.5">
                      <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">唤起快捷键</span>
                      <div
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (!isRecordingShortcut) return;
                          e.preventDefault();
                          e.stopPropagation();

                          const parts: string[] = [];
                          if (e.ctrlKey) parts.push("Ctrl");
                          if (e.altKey) parts.push("Alt");
                          if (e.shiftKey) parts.push("Shift");
                          if (e.metaKey) parts.push("Meta");

                          const key = e.key;
                          const ignoredKeys = new Set(["Control", "Alt", "Shift", "Meta"]);
                          if (!ignoredKeys.has(key)) {
                            let keyName = key;
                            if (key === " ") keyName = "Space";
                            else if (key.length === 1) keyName = key.toUpperCase();
                            parts.push(keyName);

                            setQuickShortcut(parts.join("+"));
                            setIsRecordingShortcut(false);
                          }
                        }}
                        onBlur={() => setIsRecordingShortcut(false)}
                        className={`flex items-center justify-between rounded-xl border px-4 py-3.5 text-[14px] cursor-pointer transition-all ${
                          isRecordingShortcut
                            ? "border-accent bg-accent/5 ring-2 ring-accent/20"
                            : "border-ink-900/10 bg-surface/70 hover:border-ink-900/20"
                        }`}
                        onClick={() => setIsRecordingShortcut(true)}
                      >
                        <div className="flex items-center gap-2">
                          {isRecordingShortcut ? (
                            <span className="text-accent font-medium animate-pulse">请按下快捷键组合...</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              {quickShortcut.split("+").map((key, i) => (
                                <span key={i}>
                                  {i > 0 && <span className="text-ink-300 mx-0.5">+</span>}
                                  <kbd className="inline-flex h-7 min-w-[28px] items-center justify-center rounded-lg border border-ink-900/15 bg-surface-secondary px-2 text-[12px] font-medium text-ink-700 shadow-sm">
                                    {key}
                                  </kbd>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsRecordingShortcut(!isRecordingShortcut);
                          }}
                          className="text-[13px] font-medium text-accent hover:text-accent-hover transition-colors"
                        >
                          {isRecordingShortcut ? "取消" : "修改"}
                        </button>
                      </div>
                    </label>

                    {shortcutSaved && (
                      <div className="mt-3 flex items-center gap-2 text-[13px] text-success">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12l4 4L19 6" />
                        </svg>
                        快捷键已更新
                      </div>
                    )}
                  </div>

                  {/* Preset shortcuts */}
                  <div>
                    <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide block mb-3">常用快捷键</span>
                    <div className="flex flex-wrap gap-2">
                      {["Alt+Space", "Ctrl+Space", "Ctrl+Shift+K", "Ctrl+Alt+N", "Alt+Q"].map((preset) => (
                        <button
                          key={preset}
                          onClick={() => {
                            setQuickShortcut(preset);
                            setIsRecordingShortcut(false);
                          }}
                          className={`rounded-lg border px-3.5 py-2 text-[13px] font-medium transition-colors ${
                            quickShortcut === preset
                              ? "border-accent/30 bg-accent/8 text-accent"
                              : "border-ink-900/10 bg-surface/70 text-ink-600 hover:bg-surface-secondary hover:text-ink-800"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                    <p className="text-[13px] text-info leading-relaxed">
                      <strong>说明：</strong>全局快捷键在应用后台运行时也能使用。
                      如果快捷键与其他应用冲突，请更换为其他组合键。
                      修改后请点击"保存配置"生效。
                    </p>
                  </div>
                </div>
              )}

              {/* Alert Settings */}
              {activeSection === "alert" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-ink-500 leading-relaxed">配置崩溃告警，严重错误发生时自动发送到钉钉群</p>

                  <label className="grid gap-2">
                    <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">Webhook 地址</span>
                    <input
                      type="url"
                      className="rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                      onBlur={(e) => e.currentTarget.style.borderColor = ''}
                      placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                      value={alertWebhook}
                      onChange={(e) => setAlertWebhook(e.target.value)}
                    />
                    <span className="text-[12px] text-ink-400">
                      钉钉群 → 群设置 → 机器人 → 添加自定义机器人 → 复制 Webhook 地址
                    </span>
                  </label>

                  <label className="grid gap-2">
                    <span className="text-[12px] font-medium text-ink-500 uppercase tracking-wide">
                      签名密钥 <span className="normal-case text-ink-400 font-normal">（可选）</span>
                    </span>
                    <div className="relative">
                      <input
                        type={showAlertSecret ? "text" : "password"}
                        className="w-full rounded-xl border border-ink-900/10 bg-surface/70 px-4 py-3 pr-12 text-[14px] text-ink-800 placeholder:text-ink-300 focus:outline-none transition-colors font-mono"
                        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
                        onBlur={(e) => e.currentTarget.style.borderColor = ''}
                        placeholder="SEC..."
                        value={alertSecret}
                        onChange={(e) => setAlertSecret(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setShowAlertSecret(!showAlertSecret)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-ink-400 hover:text-ink-700 transition-colors"
                        aria-label={showAlertSecret ? "Hide secret" : "Show secret"}
                      >
                        {showAlertSecret ? (
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <span className="text-[12px] text-ink-400">
                      若机器人开启了「加签」安全设置，填入 SEC 开头的密钥；否则留空
                    </span>
                  </label>

                  {alertWebhook.trim() && (
                    <button
                      type="button"
                      onClick={() => { setAlertWebhook(""); setAlertSecret(""); }}
                      className="text-left text-[12px] text-ink-400 hover:text-error transition-colors"
                    >
                      清除告警配置
                    </button>
                  )}

                  <div className="rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                    <p className="text-[13px] text-info leading-relaxed">
                      <strong>说明：</strong>配置后，应用崩溃（uncaughtException / unhandledRejection）时会自动向该钉钉群发送 Markdown 告警消息，包含错误类型、时间、用户信息和堆栈。告警为异步操作，不影响应用运行。保存配置时会自动发送一条测试消息验证连通性。
                    </p>
                  </div>

                  {alertTestResult && (
                    <div className={`rounded-xl border px-4 py-3 ${alertTestResult.ok ? "border-success/20 bg-success/5" : "border-error/20 bg-error/5"}`}>
                      <p className={`text-[13px] flex items-start gap-2 ${alertTestResult.ok ? "text-success" : "text-error"}`}>
                        {alertTestResult.ok ? (
                          <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 12l4 4L19 6" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                          </svg>
                        )}
                        <span>
                          {alertTestResult.ok
                            ? "测试消息发送成功，请检查钉钉群"
                            : `测试发送失败：${alertTestResult.error}`}
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Debug */}
              {activeSection === "debug" && (
                <div className="grid gap-5">
                  <p className="text-[13px] text-ink-500 leading-relaxed">开发调试工具</p>

                  <div className="rounded-xl border border-ink-900/8 bg-surface/70 p-5">
                    <div className="flex items-center gap-3 mb-5">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 flex-shrink-0">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <path d="M8 21h8M12 17v4" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[14px] font-medium text-ink-800">开屏页预览</p>
                        <p className="text-[12px] text-ink-400 mt-0.5">重新展示冷启动开屏引导页</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        setTimeout(() => onShowSplash?.(), 300);
                      }}
                      className="w-full rounded-xl px-4 py-3 text-[14px] font-medium text-white shadow-soft transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-hover)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent)'; }}
                    >
                      显示开屏页
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      localStorage.removeItem("vk-cowork-splash-seen");
                    }}
                    className="text-left text-[13px] text-ink-400 hover:text-ink-700 transition-colors"
                  >
                    重置开屏页状态（下次启动时重新显示）
                  </button>
                </div>
              )}

              {/* Validation Error */}
              {validationError && (
                <div className="mt-5 rounded-xl border border-error/20 bg-error/5 px-4 py-3">
                  <p className="text-[13px] text-error flex items-start gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <span>{validationError}</span>
                  </p>
                </div>
              )}
            </main>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-ink-900/8 flex-shrink-0 bg-surface-secondary">
            {showSaveButton && (
              <button
                type="button"
                onClick={handleSave}
                disabled={validating || saving}
                className="rounded-xl px-5 py-2.5 text-[14px] font-medium text-white shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={(e) => { if (!validating && !saving) (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent)'; }}
              >
                {validating ? (
                  <span className="flex items-center gap-2">
                    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    验证中...
                  </span>
                ) : saving ? (
                  <span className="flex items-center gap-2">
                    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    保存中...
                  </span>
                ) : saved ? (
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12l4 4L19 6" />
                    </svg>
                    已保存
                  </span>
                ) : (
                  "保存配置"
                )}
              </button>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-xl px-5 py-2.5 text-[14px] font-medium text-white transition-colors"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent)'; }}
              >
                完成
              </button>
            </Dialog.Close>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
