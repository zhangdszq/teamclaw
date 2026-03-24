import { useEffect, useState, useMemo } from "react";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../store/useAppStore";
import type { FolderAccessRequestInput } from "../lib/permission-errors";

type AskUserQuestionInput = {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
};

export function FolderAccessPanel({
  request,
  onGrant,
  onOpenSettings,
  onDismiss,
  busy = false,
}: {
  request: PermissionRequest;
  onGrant: () => void | Promise<void>;
  onOpenSettings: () => void | Promise<void>;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const input = (request.input as FolderAccessRequestInput | null) ?? null;
  const path = input?.path?.trim() || "";

  return (
    <div className="rounded-2xl border border-accent/20 bg-accent/5 p-5">
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-accent">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        需要授权
      </div>

      <p className="text-sm font-medium text-ink-800">
        需要授予文件夹访问权限后，当前任务才能继续执行。
      </p>
      {path && (
        <div className="mt-3 rounded-xl bg-surface px-3 py-2 text-xs text-ink-700 break-all">
          {path}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        点击“授权并继续”后会打开系统目录选择器，授权成功后将自动继续当前会话。
      </p>

      <div className="mt-5 flex flex-wrap gap-3 pt-4 border-t border-accent/10">
        <button
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-soft transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void onGrant()}
          disabled={busy}
        >
          {busy ? "授权中..." : "授权并继续"}
        </button>
        <button
          className="rounded-full border border-ink-900/10 bg-surface px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void onOpenSettings()}
          disabled={busy}
        >
          打开系统设置
        </button>
        <button
          className="rounded-full border border-ink-900/10 bg-surface px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onDismiss}
          disabled={busy}
        >
          取消
        </button>
      </div>
    </div>
  );
}

// Parse chapter list from question text or header
// Matches patterns like: "1. [00:00-03:20] Title" or "1. Title [00:00-03:20]"
const parseChaptersFromText = (text: string): Array<{ id: string; label: string; time?: string }> => {
  const chapters: Array<{ id: string; label: string; time?: string }> = [];
  
  // Pattern: number. [time] title or number. title [time]
  const chapterPattern = /(\d+)\.\s*(?:\[([^\]]+)\])?\s*([^\[]+?)(?:\s*\[([^\]]+)\])?(?=\s*\d+\.|$)/g;
  
  let match;
  while ((match = chapterPattern.exec(text)) !== null) {
    const id = match[1];
    const time = match[2] || match[4] || "";
    const title = match[3].trim();
    if (title) {
      chapters.push({
        id,
        label: time ? `${id}. [${time}] ${title}` : `${id}. ${title}`,
        time
      });
    }
  }
  
  return chapters;
};

// Check if question is asking for chapter selection
const isChapterSelectionQuestion = (question: string): boolean => {
  const keywords = ["章节", "选择", "剪辑", "chapter", "clip", "select"];
  return keywords.some(kw => question.toLowerCase().includes(kw));
};

// Check if question text contains embedded chapter list
const hasEmbeddedChapters = (text: string): boolean => {
  // Check for patterns like "1. [00:00-03:20]" or "1. Title"
  return /\d+\.\s*(?:\[[^\]]+\]|\S)/.test(text);
};

export function DecisionPanel({
  request,
  onSubmit
}: {
  request: PermissionRequest;
  onSubmit: (result: PermissionResult) => void;
}) {
  const input = request.input as AskUserQuestionInput | null;
  const questions = input?.questions ?? [];
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});
  const [textInputs, setTextInputs] = useState<Record<number, string>>({});

  // Debug: log received data
  console.log('[DecisionPanel] request:', request);
  console.log('[DecisionPanel] input:', input);
  console.log('[DecisionPanel] questions:', questions);

  // Parse dynamic chapters from question text/header
  const parsedQuestions = useMemo(() => {
    const result = questions.map((q) => {
      const hasOptions = q.options && q.options.length > 0;
      
      console.log('[DecisionPanel] Processing question:', q.question);
      console.log('[DecisionPanel] hasOptions:', hasOptions);
      console.log('[DecisionPanel] isChapterSelection:', isChapterSelectionQuestion(q.question));
      console.log('[DecisionPanel] hasEmbeddedChapters:', hasEmbeddedChapters(q.question));
      
      // If no options but question contains chapter list, parse it
      if (!hasOptions && (isChapterSelectionQuestion(q.question) || hasEmbeddedChapters(q.question))) {
        const fullText = `${q.header || ""} ${q.question}`;
        const chapters = parseChaptersFromText(fullText);
        console.log('[DecisionPanel] Parsed chapters:', chapters);
        if (chapters.length > 0) {
          return {
            ...q,
            options: chapters.map(ch => ({ label: ch.label, description: ch.time })),
            multiSelect: true, // Chapter selection is usually multi-select
            _isDynamicChapters: true
          };
        }
      }
      
      return q;
    });
    console.log('[DecisionPanel] parsedQuestions:', result);
    return result;
  }, [questions]);

  useEffect(() => {
    setSelectedOptions({});
    setTextInputs({});
  }, [request.toolUseId]);

  const toggleOption = (qIndex: number, optionLabel: string, multiSelect?: boolean) => {
    setSelectedOptions((prev) => {
      const current = prev[qIndex] ?? [];
      if (multiSelect) {
        const next = current.includes(optionLabel)
          ? current.filter((label) => label !== optionLabel)
          : [...current, optionLabel];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: [optionLabel] };
    });
  };

  const selectAll = (qIndex: number, options: Array<{ label: string }>) => {
    setSelectedOptions((prev) => ({
      ...prev,
      [qIndex]: options.map(o => o.label)
    }));
  };

  const clearAll = (qIndex: number) => {
    setSelectedOptions((prev) => ({
      ...prev,
      [qIndex]: []
    }));
  };

  const buildAnswers = () => {
    const answers: Record<string, string> = {};
    parsedQuestions.forEach((q, qIndex) => {
      const hasOptions = q.options && q.options.length > 0;
      if (hasOptions) {
        const selected = selectedOptions[qIndex] ?? [];
        if (q.multiSelect) {
          // For dynamic chapters, extract just the chapter numbers
          if ((q as any)._isDynamicChapters) {
            const nums = selected.map(s => {
              const match = s.match(/^(\d+)\./);
              return match ? match[1] : s;
            });
            answers[q.question] = nums.join(", ");
          } else {
            answers[q.question] = selected.join(", ");
          }
        } else {
          answers[q.question] = selected[0] || "";
        }
      } else {
        answers[q.question] = textInputs[qIndex] || "";
      }
    });
    return answers;
  };

  const canSubmit = parsedQuestions.every((q, qIndex) => {
    const hasOptions = q.options && q.options.length > 0;
    if (hasOptions) {
      const selected = selectedOptions[qIndex] ?? [];
      return selected.length > 0;
    } else {
      return (textInputs[qIndex] || "").trim().length > 0;
    }
  });

  if (request.toolName === "AskUserQuestion" && parsedQuestions.length > 0) {
    return (
      <div className="rounded-2xl border border-accent/20 bg-accent/5 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold text-accent mb-4">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          请选择
        </div>
        
        {parsedQuestions.map((q, qIndex) => {
          const hasOptions = q.options && q.options.length > 0;
          const isDynamicChapters = (q as any)._isDynamicChapters;
          const shouldAutoSubmit = parsedQuestions.length === 1 && !q.multiSelect && hasOptions && !isDynamicChapters;
          const selectedCount = (selectedOptions[qIndex] ?? []).length;
          
          // Extract clean question text (remove embedded chapter list)
          const cleanQuestion = isDynamicChapters 
            ? q.question.replace(/\d+\.\s*\[[^\]]+\][^0-9]*/g, "").replace(/\s+/g, " ").trim() || "请选择章节"
            : q.question;
          
          return (
            <div key={qIndex} className={qIndex > 0 ? "mt-6 pt-4 border-t border-accent/10" : ""}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-ink-800">{cleanQuestion}</p>
                {isDynamicChapters && q.options && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">
                      已选 {selectedCount}/{q.options.length}
                    </span>
                    <button
                      className="text-xs text-accent hover:text-accent-hover"
                      onClick={() => selectAll(qIndex, q.options!)}
                    >
                      全选
                    </button>
                    <button
                      className="text-xs text-muted hover:text-ink-700"
                      onClick={() => clearAll(qIndex)}
                    >
                      清空
                    </button>
                  </div>
                )}
              </div>
              
              {q.header && !isDynamicChapters && (
                <span className="mb-3 inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-xs text-muted">
                  {q.header}
                </span>
              )}
              
              {hasOptions ? (
                <div className={`grid gap-2 ${isDynamicChapters && q.options!.length > 6 ? "max-h-80 overflow-y-auto pr-2" : ""}`}>
                  {q.options!.map((option, optIndex) => {
                    const isSelected = (selectedOptions[qIndex] ?? []).includes(option.label);
                    return (
                      <button
                        key={optIndex}
                        className={`group relative rounded-xl border px-4 py-3 text-left transition-all duration-150 ${
                          isSelected
                            ? "border-accent bg-accent/10 shadow-sm"
                            : "border-ink-900/10 bg-surface hover:border-accent/40 hover:bg-accent/5"
                        }`}
                        onClick={() => {
                          if (shouldAutoSubmit) {
                            onSubmit({
                              behavior: "allow",
                              updatedInput: { ...(input as Record<string, unknown>), answers: { [q.question]: option.label } }
                            });
                            return;
                          }
                          toggleOption(qIndex, option.label, q.multiSelect);
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`flex h-5 w-5 items-center justify-center rounded-${q.multiSelect ? 'md' : 'full'} border-2 transition-colors ${
                            isSelected 
                              ? "border-accent bg-accent" 
                              : "border-ink-900/20 group-hover:border-accent/50"
                          }`}>
                            {isSelected && (
                              <svg viewBox="0 0 24 24" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </div>
                          
                          <div className="flex-1">
                            <div className={`text-sm font-medium ${isSelected ? "text-accent" : "text-ink-700"}`}>
                              {option.label}
                            </div>
                            {option.description && !isDynamicChapters && (
                              <div className="mt-0.5 text-xs text-muted">{option.description}</div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  type="text"
                  className="w-full rounded-xl border border-ink-900/10 bg-surface px-4 py-3 text-sm text-ink-800 placeholder-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="请输入您的回答..."
                  value={textInputs[qIndex] || ""}
                  onChange={(e) => setTextInputs((prev) => ({ ...prev, [qIndex]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && parsedQuestions.length === 1 && (textInputs[qIndex] || "").trim()) {
                      onSubmit({
                        behavior: "allow",
                        updatedInput: { ...(input as Record<string, unknown>), answers: { [q.question]: textInputs[qIndex] } }
                      });
                    }
                  }}
                />
              )}
              
              {q.multiSelect && hasOptions && !isDynamicChapters && (
                <div className="mt-2 text-xs text-muted flex items-center gap-1">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  可多选
                </div>
              )}
            </div>
          );
        })}
        
        {/* Show submit button */}
        {(parsedQuestions.length > 1 || parsedQuestions.some(q => q.multiSelect) || parsedQuestions.some(q => !q.options || q.options.length === 0)) && (
          <div className="mt-5 flex flex-wrap gap-3 pt-4 border-t border-accent/10">
            <button
              className={`rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-soft transition-all ${
                canSubmit 
                  ? "bg-accent hover:bg-accent-hover active:scale-95" 
                  : "bg-ink-400/40 cursor-not-allowed"
              }`}
              onClick={() => {
                if (!canSubmit) return;
                onSubmit({ behavior: "allow", updatedInput: { ...(input as Record<string, unknown>), answers: buildAnswers() } });
              }}
              disabled={!canSubmit}
            >
              确认选择
            </button>
            <button
              className="rounded-full border border-ink-900/10 bg-surface px-5 py-2.5 text-sm font-medium text-ink-700 hover:bg-surface-tertiary transition-colors"
              onClick={() => onSubmit({ behavior: "deny", message: "User canceled the question" })}
            >
              取消
            </button>
          </div>
        )}
      </div>
    );
  }

  // Generic permission request (non-AskUserQuestion)
  return (
    <div className="rounded-2xl border border-accent/20 bg-accent/5 p-5">
      <div className="text-xs font-semibold text-accent">Permission Request</div>
      <p className="mt-2 text-sm text-ink-700">
        Claude wants to use: <span className="font-medium">{request.toolName}</span>
      </p>
      <div className="mt-3 rounded-xl bg-surface-tertiary p-3">
        <pre className="text-xs text-ink-600 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
          {JSON.stringify(request.input, null, 2)}
        </pre>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors"
          onClick={() => onSubmit({ behavior: "allow", updatedInput: request.input as Record<string, unknown> })}
        >
          Allow
        </button>
        <button
          className="rounded-full border border-ink-900/10 bg-surface px-5 py-2 text-sm font-medium text-ink-700 hover:bg-surface-tertiary transition-colors"
          onClick={() => onSubmit({ behavior: "deny", message: "User denied the request" })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
