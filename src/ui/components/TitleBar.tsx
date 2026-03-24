import { useCallback, useEffect, useState } from "react";
import appIconUrl from "../assets/app-icon.png";

export function usePlatform() {
  return typeof window.electron?.getPlatform === "function"
    ? window.electron.getPlatform()
    : "win32";
}

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const platform = usePlatform();

  useEffect(() => {
    window.electron?.windowIsMaximized?.()?.then(setIsMaximized);
    const unsub = window.electron?.onWindowMaximizedChange?.(setIsMaximized);
    return () => unsub?.();
  }, []);

  const handleMinimize = useCallback(() => window.electron?.windowMinimize?.(), []);
  const handleMaximize = useCallback(() => window.electron?.windowMaximize?.(), []);
  const handleClose = useCallback(() => window.electron?.windowClose?.(), []);

  if (platform === "darwin") return null;

  return (
    <div
      className="title-bar flex items-center justify-between h-8 bg-surface-cream border-b border-ink-900/6 select-none shrink-0"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 pl-3">
        <img src={appIconUrl} alt="DinoClaw" className="h-4 w-4 rounded-sm" />
        <span className="text-xs font-medium text-ink-500 tracking-wide">DinoClaw</span>
      </div>

      <div
        className="flex h-full"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={handleMinimize}
          className="title-btn w-11 h-full flex items-center justify-center text-ink-500 hover:bg-ink-900/8 transition-colors"
          aria-label="最小化"
        >
          <svg viewBox="0 0 16 16" className="h-[10px] w-[10px]" fill="currentColor">
            <rect x="3" y="7.5" width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="title-btn w-11 h-full flex items-center justify-center text-ink-500 hover:bg-ink-900/8 transition-colors"
          aria-label={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? (
            <svg viewBox="0 0 16 16" className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="1.5" y="3.5" width="8" height="8" rx="0.5" />
              <path d="M5.5 3.5V1.5h9v9h-2" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-[10px] w-[10px]" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2" y="2" width="12" height="12" rx="0.5" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="title-btn title-btn-close w-11 h-full flex items-center justify-center text-ink-500 hover:bg-[#e81123] hover:text-white transition-colors"
          aria-label="关闭"
        >
          <svg viewBox="0 0 16 16" className="h-[10px] w-[10px]" fill="currentColor">
            <path d="M2.59 2.59a.5.5 0 01.7 0L8 7.3l4.71-4.71a.5.5 0 01.7.7L8.71 8l4.71 4.71a.5.5 0 01-.7.7L8 8.71l-4.71 4.71a.5.5 0 01-.7-.7L7.3 8 2.59 3.29a.5.5 0 010-.7z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
