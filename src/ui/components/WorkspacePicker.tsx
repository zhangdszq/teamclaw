import { useEffect, useState } from "react";

interface WorkspacePickerProps {
  currentCwd: string;
  onSelect: (path: string) => void;
}

export function WorkspacePicker({ currentCwd, onSelect }: WorkspacePickerProps) {
  const [recentCwds, setRecentCwds] = useState<string[]>([]);

  useEffect(() => {
    window.electron.getRecentCwds().then(setRecentCwds).catch(console.error);
  }, []);

  const handleSelectDirectory = async () => {
    const result = await window.electron.selectDirectory();
    if (result) onSelect(result);
  };

  const formatPath = (path: string) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  const getPathParent = (path: string) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) return path;
    return "/" + parts.slice(0, -1).join("/");
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-surface-cream pb-10">
      <div className="flex flex-col items-center gap-5 w-full max-w-sm px-4">

        {/* Folder icon */}
        <div className="flex h-[88px] w-[88px] items-center justify-center rounded-[22px] bg-surface-secondary shadow-soft">
          <svg viewBox="0 0 24 24" className="h-11 w-11 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            <path d="M2 10h20" />
          </svg>
        </div>

        {/* Title & subtitle */}
        <div className="text-center space-y-1.5">
          <h2 className="text-xl font-semibold text-ink-900">欢迎使用 DinoClaw</h2>
          <p className="text-sm text-ink-500">选择一个工作区开始与助理对话</p>
        </div>

        {/* Recent workspaces */}
        {recentCwds.length > 0 && (
          <div className="w-full space-y-1.5">
            <p className="text-xs font-medium text-ink-400 uppercase tracking-wider px-1">最近使用</p>
            <div className="space-y-1">
              {recentCwds.slice(0, 5).map((path) => (
                <button
                  key={path}
                  onClick={() => onSelect(path)}
                  className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors ${
                    currentCwd === path
                      ? "bg-accent/10 border border-accent/20"
                      : "bg-surface border border-ink-900/8 hover:bg-surface-secondary"
                  }`}
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    currentCwd === path ? "bg-accent/15" : "bg-surface-tertiary"
                  }`}>
                    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${currentCwd === path ? "text-accent" : "text-ink-500"}`} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${currentCwd === path ? "text-accent" : "text-ink-800"}`}>
                      {formatPath(path)}
                    </div>
                    <div className="text-xs text-ink-400 truncate">{getPathParent(path)}</div>
                  </div>
                  {currentCwd === path && (
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add workspace button */}
        <button
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors w-full justify-center"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          添加工作区
        </button>

        {/* Bottom tips */}
        <div className="text-center space-y-1 pt-1">
          <p className="text-xs text-ink-400">工作区是助理可以读写文件的目录</p>
          <p className="text-xs text-ink-400">每个工作区有独立的对话历史</p>
        </div>
      </div>
    </div>
  );
}
