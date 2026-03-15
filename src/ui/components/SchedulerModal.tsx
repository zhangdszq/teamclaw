import { useEffect, useState, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";


interface AssistantConfig {
  id: string;
  name: string;
  provider: "claude" | "openai";
  model?: string;
}

interface SchedulerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EditMode = "calendar" | "create" | "edit";
type ScheduleTypeOption = "once" | "interval" | "daily" | "cron" | "hook";

// Weekday labels and JS day indices (Mon-first display order)
const WEEKDAY_OPTIONS: { label: string; value: number }[] = [
  { label: "一", value: 1 },
  { label: "二", value: 2 },
  { label: "三", value: 3 },
  { label: "四", value: 4 },
  { label: "五", value: 5 },
  { label: "六", value: 6 },
  { label: "日", value: 0 },
];

// Assistant event colors
const ASSISTANT_COLORS = [
  { bg: "bg-accent/15", text: "text-accent", dot: "bg-accent" },
  { bg: "bg-emerald-500/15", text: "text-emerald-600", dot: "bg-emerald-500" },
  { bg: "bg-orange-500/15", text: "text-orange-600", dot: "bg-orange-500" },
  { bg: "bg-purple-500/15", text: "text-purple-600", dot: "bg-purple-500" },
  { bg: "bg-pink-500/15", text: "text-pink-600", dot: "bg-pink-500" },
  { bg: "bg-teal-500/15", text: "text-teal-600", dot: "bg-teal-500" },
  { bg: "bg-red-500/15", text: "text-red-600", dot: "bg-red-500" },
  { bg: "bg-yellow-500/15", text: "text-yellow-600", dot: "bg-yellow-500" },
];
const DEFAULT_COLOR = { bg: "bg-ink-900/8", text: "text-ink-500", dot: "bg-ink-300" };

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

// Format a Date as "YYYY-MM-DDTHH:MM" in local time (for datetime-local inputs)
const toLocalDateTimeString = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Calendar helpers
const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
const getFirstDayOfMonth = (year: number, month: number) => {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1; // Convert Sun=0 to Mon=0
};

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
}

const generateCalendarDays = (year: number, month: number): CalendarDay[] => {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const days: CalendarDay[] = [];

  const prevMonthDays = getDaysInMonth(year, month - 1);
  for (let i = firstDay - 1; i >= 0; i--) {
    days.push({ date: new Date(year, month - 1, prevMonthDays - i), isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ date: new Date(year, month, d), isCurrentMonth: true });
  }
  // Always fill to 42 cells (6 rows)
  const remaining = 42 - days.length;
  for (let d = 1; d <= remaining; d++) {
    days.push({ date: new Date(year, month + 1, d), isCurrentMonth: false });
  }
  return days;
};

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const startOfDayMs = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const getTaskDisplayDate = (task: ScheduledTask): Date | null => {
  // Always prefer nextRun (dynamic, accurate) over scheduledTime (original, may be past)
  if (task.nextRun) return new Date(task.nextRun);
  if (task.scheduleType === "once" && task.scheduledTime) return new Date(task.scheduledTime);
  return null;
};

const isTaskStartedByDay = (task: ScheduledTask, date: Date): boolean => {
  if (!task.createdAt) return true;
  const createdAt = new Date(task.createdAt);
  if (Number.isNaN(createdAt.getTime())) return true;
  return startOfDayMs(date) >= startOfDayMs(createdAt);
};

const isDailyTaskOnDay = (task: ScheduledTask, date: Date): boolean => {
  if (!task.dailyTime || !isTaskStartedByDay(task, date)) return false;
  if (task.dailyDays && task.dailyDays.length > 0) {
    return task.dailyDays.includes(date.getDay());
  }
  return true;
};

// Returns true if task should appear on this calendar day
const isTaskOnDay = (task: ScheduledTask, date: Date): boolean => {
  // Hook tasks are not time-point tasks — skip calendar display
  if (task.scheduleType === "heartbeat" || task.scheduleType === "hook") return false;
  if (task.scheduleType === "once" || task.scheduleType === "interval") {
    const d = getTaskDisplayDate(task);
    return !!d && isSameDay(d, date);
  }
  if (task.scheduleType === "daily") {
    return isDailyTaskOnDay(task, date);
  }
  if (task.scheduleType === "cron") {
    if (task.nextRun) return isSameDay(new Date(task.nextRun), date);
    return false;
  }
  return false;
};

export function SchedulerModal({ open, onOpenChange }: SchedulerModalProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [mode, setMode] = useState<EditMode>("calendar");
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [assistants, setAssistants] = useState<AssistantConfig[]>([]);
  const [currentMonth, setCurrentMonth] = useState(() => new Date());
  // null = 全员，"__default__" = 无助理，其他 = 特定助理 id
  const [filterAssistantId, setFilterAssistantId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notifyText, setNotifyText] = useState("");
  const [cwd, setCwd] = useState("");
  const [scheduleType, setScheduleType] = useState<ScheduleTypeOption>("once");
  const [scheduledTime, setScheduledTime] = useState("");
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours" | "days" | "weeks">("hours");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [dailyDays, setDailyDays] = useState<number[]>([]);
  const [cronExpr, setCronExpr] = useState("");
  const [cronTimezone, setCronTimezone] = useState("");
  const [hookEvent, setHookEvent] = useState<"startup" | "session.complete">("startup");
  const [hookFilterAssistantId, setHookFilterAssistantId] = useState("");
  const [hookFilterOnlyOnError, setHookFilterOnlyOnError] = useState(false);
  const [formAssistantId, setFormAssistantId] = useState<string>("");
  const [runHistory, setRunHistory] = useState<TaskRunRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const loadedTasks = await window.electron.getScheduledTasks();
      setTasks(loadedTasks);
    } catch (error) {
      console.error("Failed to load tasks:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadTasks();
      setMode("calendar");
      setCurrentMonth(new Date());
    }
  }, [open, loadTasks]);

  useEffect(() => {
    window.electron.getAssistantsConfig().then((config) => {
      setAssistants(config.assistants || []);
    }).catch(console.error);
  }, []);

  // Map assistant id → color (stable across renders)
  const assistantColorMap = useMemo(() => {
    const map = new Map<string, typeof ASSISTANT_COLORS[0]>();
    assistants.forEach((a, i) => map.set(a.id, ASSISTANT_COLORS[i % ASSISTANT_COLORS.length]));
    return map;
  }, [assistants]);

  const getAssistantColor = (assistantId?: string) =>
    assistantId ? (assistantColorMap.get(assistantId) ?? DEFAULT_COLOR) : DEFAULT_COLOR;

  const getAssistantName = (assistantId?: string) => {
    if (!assistantId) return null;
    return assistants.find((a) => a.id === assistantId)?.name ?? null;
  };

  const calendarDays = useMemo(
    () => generateCalendarDays(currentMonth.getFullYear(), currentMonth.getMonth()),
    [currentMonth]
  );

  // SOP-linked tasks (hidden=true or sopId set) are managed from SopPage, not the calendar
  const visibleTasks = useMemo(() => tasks.filter((t) => !t.hidden && !t.sopId), [tasks]);

  const filteredTasks = useMemo(() => {
    if (filterAssistantId === null) return visibleTasks;
    if (filterAssistantId === "__default__") return visibleTasks.filter((t) => !t.assistantId);
    return visibleTasks.filter((t) => t.assistantId === filterAssistantId);
  }, [visibleTasks, filterAssistantId]);

  const getTasksForDay = useCallback(
    (date: Date) => filteredTasks.filter((t) => isTaskOnDay(t, date)),
    [filteredTasks]
  );

  const today = useMemo(() => new Date(), []);

  const prevMonth = () => setCurrentMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () => setCurrentMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const goToToday = () => setCurrentMonth(new Date());

  const resetForm = () => {
    setName(""); setPrompt(""); setNotifyText(""); setCwd("");
    setScheduleType("once"); setScheduledTime("");
    setIntervalValue(1); setIntervalUnit("hours");
    setDailyTime("09:00"); setDailyDays([]);
    setCronExpr(""); setCronTimezone("");
    setHookEvent("startup"); setHookFilterAssistantId(""); setHookFilterOnlyOnError(false);
    setFormAssistantId(""); setEditingTask(null);
    setRunHistory([]);
  };

  const handleCreate = (date?: Date) => {
    resetForm();
    const t = date ? new Date(date) : new Date();
    if (!date) t.setHours(t.getHours() + 1);
    t.setMinutes(0); t.setSeconds(0);
    setScheduledTime(toLocalDateTimeString(t));
    // pre-fill assistant from sidebar filter
    if (filterAssistantId && filterAssistantId !== "__default__") {
      setFormAssistantId(filterAssistantId);
    }
    setMode("create");
  };

  const handleEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setName(task.name);
    setPrompt(task.prompt);
    setNotifyText(task.notifyText || "");
    setCwd(task.cwd || "");
    const st = task.scheduleType === "heartbeat" ? "interval" : task.scheduleType as ScheduleTypeOption;
    setScheduleType(st);
    if (task.scheduledTime || task.nextRun) {
      const displayTime = task.nextRun ?? task.scheduledTime!;
      setScheduledTime(toLocalDateTimeString(new Date(displayTime)));
    }
    setIntervalValue(task.intervalValue || 1);
    setIntervalUnit(task.intervalUnit || "hours");
    setDailyTime(task.dailyTime || "09:00");
    setDailyDays(task.dailyDays || []);
    setCronExpr(task.cronExpr || "");
    setCronTimezone(task.cronTimezone || "");
    setHookEvent(task.hookEvent ?? "startup");
    setHookFilterAssistantId(task.hookFilter?.assistantId ?? "");
    setHookFilterOnlyOnError(task.hookFilter?.onlyOnError ?? false);
    setFormAssistantId(task.assistantId || "");
    setMode("edit");
    // Load execution history
    setHistoryLoading(true);
    window.electron.getTaskRunHistory(task.id, 10)
      .then((h) => setRunHistory(h ?? []))
      .catch(() => setRunHistory([]))
      .finally(() => setHistoryLoading(false));
  };

  const handleRunNow = async () => {
    if (!editingTask) return;
    setLoading(true);
    try {
      await window.electron.runTaskNow(editingTask.id);
      setTimeout(() => {
        loadTasks();
        if (editingTask) {
          window.electron.getTaskRunHistory(editingTask.id, 10)
            .then((h) => setRunHistory(h ?? []))
            .catch(() => {});
        }
      }, 1500);
    } catch (e) {
      console.error("Failed to run task:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || (!prompt.trim() && !notifyText.trim())) return;
    setLoading(true);
    try {
      const taskData: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt"> = {
        name: name.trim(),
        enabled: true,
        prompt: prompt.trim(),
        notifyText: notifyText.trim() || undefined,
        cwd: cwd.trim() || undefined,
        scheduleType,
        scheduledTime: scheduleType === "once" ? new Date(scheduledTime).toISOString() : undefined,
        intervalValue: scheduleType === "interval" ? intervalValue : undefined,
        intervalUnit: scheduleType === "interval" ? intervalUnit : undefined,
        dailyTime: scheduleType === "daily" ? dailyTime : undefined,
        dailyDays: scheduleType === "daily" ? dailyDays : undefined,
        cronExpr: scheduleType === "cron" ? cronExpr.trim() : undefined,
        cronTimezone: scheduleType === "cron" && cronTimezone.trim() ? cronTimezone.trim() : undefined,
        heartbeatInterval: undefined,
        suppressIfShort: undefined,
        hookEvent: scheduleType === "hook" ? hookEvent : undefined,
        hookFilter: scheduleType === "hook" ? {
          assistantId: hookFilterAssistantId || undefined,
          onlyOnError: hookFilterOnlyOnError || undefined,
        } : undefined,
        assistantId: formAssistantId || undefined,
      };
      if (mode === "edit" && editingTask) {
        await window.electron.updateScheduledTask(editingTask.id, taskData);
      } else {
        await window.electron.addScheduledTask(taskData);
      }
      await loadTasks();
      setMode("calendar");
      resetForm();
    } catch (error) {
      console.error("Failed to save task:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除这个定时任务吗？")) return;
    setLoading(true);
    try {
      await window.electron.deleteScheduledTask(id);
      await loadTasks();
      setMode("calendar");
    } catch (error) {
      console.error("Failed to delete task:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (task: ScheduledTask, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setLoading(true);
    try {
      const updated = await window.electron.updateScheduledTask(task.id, { enabled: !task.enabled });
      if (editingTask && updated) setEditingTask(updated);
      await loadTasks();
    } catch (error) {
      console.error("Failed to toggle task:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectDirectory = async () => {
    try {
      const path = await window.electron.selectDirectory();
      if (path) setCwd(path);
    } catch (error) {
      console.error("Failed to select directory:", error);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/20 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[1140px] h-[82vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink-900/5 bg-surface shadow-elevated overflow-hidden flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-ink-900/10 shrink-0">
            <div className="flex items-center gap-2.5">
              {mode !== "calendar" && (
                <button
                  onClick={() => { setMode("calendar"); resetForm(); }}
                  className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              )}
              <Dialog.Title className="text-base font-semibold text-ink-800">
                {mode === "calendar" ? "日历" : mode === "create" ? "新建任务" : "编辑任务"}
              </Dialog.Title>
            </div>
            <div className="flex items-center gap-2">
              {mode === "calendar" && (
                <button
                  onClick={() => handleCreate()}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  新建任务
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  className="rounded-full p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors"
                  aria-label="Close"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
          </div>

          {mode === "calendar" ? (
            /* ── Calendar View ── */
            <div className="flex flex-1 overflow-hidden">

              {/* ── Sidebar ── */}
              <div className="w-44 shrink-0 border-r border-ink-900/10 flex flex-col overflow-y-auto bg-surface-secondary/30">
                <div className="px-3 pt-3 pb-1">
                  <p className="text-[11px] font-semibold text-muted uppercase tracking-wider px-1">日历</p>
                </div>

                {/* 全员日历 */}
                <button
                  onClick={() => setFilterAssistantId(null)}
                  className={`mx-2 mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    filterAssistantId === null
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-ink-700 hover:bg-surface-tertiary"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  <span className="truncate">全员日历</span>
                  <span className={`ml-auto text-[11px] tabular-nums ${filterAssistantId === null ? "text-accent/70" : "text-muted"}`}>
                    {tasks.length}
                  </span>
                </button>

                {/* Assistants section */}
                {assistants.length > 0 && (
                  <>
                    <div className="px-3 pt-3 pb-1">
                      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider px-1">助理</p>
                    </div>
                    {assistants.map((a, i) => {
                      const color = ASSISTANT_COLORS[i % ASSISTANT_COLORS.length];
                      const count = tasks.filter((t) => t.assistantId === a.id).length;
                      const isActive = filterAssistantId === a.id;
                      return (
                        <button
                          key={a.id}
                          onClick={() => setFilterAssistantId(isActive ? null : a.id)}
                          className={`mx-2 mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                            isActive ? `${color.bg} ${color.text} font-medium` : "text-ink-700 hover:bg-surface-tertiary"
                          }`}
                        >
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color.dot}`} />
                          <span className="truncate">{a.name}</span>
                          {count > 0 && (
                            <span className={`ml-auto text-[11px] tabular-nums ${isActive ? "opacity-70" : "text-muted"}`}>
                              {count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </>
                )}

                {/* Default (no assistant assigned) */}
                {tasks.some((t) => !t.assistantId) && (
                  <>
                    <div className="px-3 pt-3 pb-1">
                      <p className="text-[11px] font-semibold text-muted uppercase tracking-wider px-1">其他</p>
                    </div>
                    <button
                      onClick={() => setFilterAssistantId(filterAssistantId === "__default__" ? null : "__default__")}
                      className={`mx-2 mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        filterAssistantId === "__default__"
                          ? "bg-ink-900/8 text-ink-700 font-medium"
                          : "text-ink-600 hover:bg-surface-tertiary"
                      }`}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ink-300" />
                      <span className="truncate">默认助理</span>
                      <span className="ml-auto text-[11px] tabular-nums text-muted">
                        {tasks.filter((t) => !t.assistantId).length}
                      </span>
                    </button>
                  </>
                )}

                <div className="flex-1" />
              </div>

              {/* ── Calendar panel ── */}
              <div className="flex flex-col flex-1 overflow-hidden">

                {/* Month navigation */}
                <div className="flex items-center gap-2 px-4 py-2.5 shrink-0">
                  <button
                    onClick={goToToday}
                    className="rounded-lg border border-ink-900/10 px-3 py-1 text-xs font-medium text-ink-700 hover:bg-surface-tertiary transition-colors"
                  >
                    今天
                  </button>
                  <div className="flex items-center">
                    <button onClick={prevMonth} className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <button onClick={nextMonth} className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-700 transition-colors">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                  <span className="text-sm font-semibold text-ink-800">
                    {currentMonth.getFullYear()}年{MONTHS[currentMonth.getMonth()]}
                  </span>
                  {filterAssistantId !== null && (
                    <span className="ml-1 text-xs text-muted">
                      · {filterAssistantId === "__default__" ? "默认助理" : (assistants.find(a => a.id === filterAssistantId)?.name ?? "")}
                    </span>
                  )}
                </div>

                {/* Weekday headers */}
                <div className="grid grid-cols-7 border-t border-b border-ink-900/10 shrink-0">
                  {WEEKDAYS.map((day, i) => (
                    <div
                      key={day}
                      className={`py-1.5 text-center text-xs font-medium tracking-wide ${
                        i >= 5 ? "text-muted" : "text-ink-500"
                      }`}
                    >
                      周{day}
                    </div>
                  ))}
                </div>

                {/* Calendar grid */}
                <div className="flex-1 overflow-y-auto">
                  <div className="grid grid-cols-7" style={{ gridTemplateRows: "repeat(6, minmax(90px, 1fr))" }}>
                  {calendarDays.map((day, idx) => {
                    const dayTasks = getTasksForDay(day.date);
                    const isToday = isSameDay(day.date, today);
                    const isWeekend = idx % 7 >= 5;
                    const isFirstCol = idx % 7 === 0;

                    return (
                      <div
                        key={idx}
                        onClick={() => day.isCurrentMonth && handleCreate(day.date)}
                        className={`relative border-b border-r border-ink-900/8 p-1.5 cursor-pointer transition-colors group/cell ${
                          isFirstCol ? "border-l border-ink-900/8" : ""
                        } ${
                          day.isCurrentMonth
                            ? isWeekend
                              ? "bg-surface-secondary/30 hover:bg-surface-secondary/60"
                              : "bg-surface hover:bg-surface-secondary/40"
                            : "bg-surface-secondary/15 hover:bg-surface-secondary/30"
                        }`}
                      >
                        {/* Date number */}
                        <div className="flex items-center justify-between mb-1">
                          <span
                            className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded-full text-[12px] font-medium ${
                              isToday
                                ? "bg-accent text-white font-semibold"
                                : day.isCurrentMonth
                                ? isWeekend
                                  ? "text-ink-400"
                                  : "text-ink-700"
                                : "text-ink-300"
                            }`}
                          >
                            {day.date.getDate()}
                          </span>
                          {day.isCurrentMonth && (
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3 w-3 text-ink-300 opacity-0 group-hover/cell:opacity-100 transition-opacity"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M12 5v14M5 12h14" />
                            </svg>
                          )}
                        </div>

                        {/* Task events */}
                        <div className="space-y-0.5">
                          {dayTasks.slice(0, 3).map((task) => {
                            const color = getAssistantColor(task.assistantId);
                            const assistantName = getAssistantName(task.assistantId);
                            return (
                              <button
                                key={task.id}
                                onClick={(e) => { e.stopPropagation(); handleEdit(task); }}
                                className={`w-full flex items-center gap-1 rounded px-1.5 py-[3px] text-left transition-all hover:brightness-95 active:scale-[0.98] ${
                                  task.enabled ? color.bg : "bg-ink-900/5"
                                }`}
                                title={`${assistantName ? assistantName + " · " : ""}${task.name}`}
                              >
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  !task.enabled ? "bg-ink-300"
                                    : task.lastRunStatus === "error" ? "bg-red-500"
                                    : task.lastRunStatus === "ok" ? color.dot
                                    : color.dot
                                }`} />
                                <span className={`truncate text-[11px] leading-[1.3] font-medium ${task.enabled ? color.text : "text-ink-400"}`}>
                                  {assistantName && (
                                    <span className="opacity-60">{assistantName} · </span>
                                  )}
                                  {task.name}
                                </span>
                                {task.consecutiveErrors && task.consecutiveErrors > 0 ? (
                                  <span className="ml-auto shrink-0 text-[10px] text-red-500 font-medium">
                                    {task.consecutiveErrors}x
                                  </span>
                                ) : (task.scheduleType === "interval" || task.scheduleType === "daily" || task.scheduleType === "cron") ? (
                                  <span className={`ml-auto shrink-0 text-[10px] opacity-60 ${task.enabled ? color.text : "text-ink-300"}`}>
                                    {task.scheduleType === "daily" ? task.dailyTime : task.scheduleType === "cron" ? "cron" : "↻"}
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                          {dayTasks.length > 3 && (
                            <div className="px-1.5 text-[11px] text-muted leading-tight">
                              还有 {dayTasks.length - 3} 个
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          ) : (
            /* ── Create / Edit Form ── */
            <>
              <div className="flex-1 overflow-y-auto p-6">
                <div className="space-y-4 max-w-lg mx-auto">

                  {/* Assistant selector */}
                  <label className="block">
                    <span className="text-xs font-medium text-muted">执行助理</span>
                    <select
                      value={formAssistantId}
                      onChange={(e) => setFormAssistantId(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    >
                      <option value="">默认助理</option>
                      {assistants.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-muted">任务名称</span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如：每日视频剪辑"
                      className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-medium text-muted">提醒内容（直接推送，不启动 AI）</span>
                    <input
                      type="text"
                      value={notifyText}
                      onChange={(e) => setNotifyText(e.target.value)}
                      placeholder="例如：该喝水啦、记得开会"
                      className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                    />
                    <p className="mt-1 text-xs text-muted">填写后到期直接推送到 Telegram/飞书/钉钉，秒级送达</p>
                  </label>

                  {!notifyText.trim() && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted">AI 执行指令（需要 AI 思考的复杂任务）</span>
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="输入要执行的任务指令..."
                        rows={3}
                        className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors resize-none"
                      />
                    </label>
                  )}

                  <label className="block">
                    <span className="text-xs font-medium text-muted">工作目录（可选）</span>
                    <div className="mt-1.5 flex gap-2">
                      <input
                        type="text"
                        value={cwd}
                        onChange={(e) => setCwd(e.target.value)}
                        placeholder="选择工作目录..."
                        className="flex-1 rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        readOnly
                      />
                      <button
                        onClick={handleSelectDirectory}
                        className="rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-muted hover:bg-surface-tertiary transition-colors"
                      >
                        浏览
                      </button>
                    </div>
                  </label>

                  <div className="border-t border-ink-900/10 pt-4">
                    <span className="text-xs font-medium text-muted">执行方式</span>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {(["once", "interval", "daily", "cron", "hook"] as const).map((type) => {
                        const labels: Record<string, string> = {
                          once: "单次执行",
                          interval: "间隔重复",
                          daily: "指定时间",
                          cron: "Cron 表达式",
                          hook: "事件钩子",
                        };
                        return (
                          <button
                            key={type}
                            onClick={() => setScheduleType(type)}
                            className={`rounded-xl border py-2.5 text-sm font-medium transition-colors ${
                              scheduleType === type
                                ? "border-accent bg-accent/10 text-accent"
                                : "border-ink-900/10 text-muted hover:border-ink-900/20"
                            }`}
                          >
                            {labels[type]}
                          </button>
                        );
                      })}
                    </div>

                    {scheduleType === "once" && (
                      <label className="block mt-4">
                        <span className="text-xs font-medium text-muted">执行时间</span>
                        <input
                          type="datetime-local"
                          value={scheduledTime}
                          onChange={(e) => setScheduledTime(e.target.value)}
                          className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                        />
                      </label>
                    )}

                    {scheduleType === "interval" && (
                      <div className="mt-4 flex gap-3">
                        <label className="flex-1">
                          <span className="text-xs font-medium text-muted">间隔</span>
                          <input
                            type="number"
                            min="1"
                            value={intervalValue}
                            onChange={(e) => setIntervalValue(parseInt(e.target.value) || 1)}
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          />
                        </label>
                        <label className="flex-1">
                          <span className="text-xs font-medium text-muted">单位</span>
                          <select
                            value={intervalUnit}
                            onChange={(e) => setIntervalUnit(e.target.value as "minutes" | "hours" | "days" | "weeks")}
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          >
                            <option value="minutes">分钟</option>
                            <option value="hours">小时</option>
                            <option value="days">天</option>
                            <option value="weeks">周</option>
                          </select>
                        </label>
                      </div>
                    )}

                    {scheduleType === "daily" && (
                      <div className="mt-4 space-y-3">
                        <label className="block">
                          <span className="text-xs font-medium text-muted">执行时间</span>
                          <input
                            type="time"
                            value={dailyTime}
                            onChange={(e) => setDailyTime(e.target.value)}
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          />
                        </label>
                        <div>
                          <span className="text-xs font-medium text-muted">重复日期</span>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {/* "每天" shortcut */}
                            <button
                              onClick={() => setDailyDays([])}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                dailyDays.length === 0
                                  ? "bg-accent text-white"
                                  : "bg-surface-secondary border border-ink-900/10 text-ink-600 hover:border-ink-900/20"
                              }`}
                            >
                              每天
                            </button>
                            {WEEKDAY_OPTIONS.map(({ label, value }) => {
                              const selected = dailyDays.includes(value);
                              return (
                                <button
                                  key={value}
                                  onClick={() => {
                                    setDailyDays((prev) =>
                                      selected ? prev.filter((d) => d !== value) : [...prev, value]
                                    );
                                  }}
                                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                    selected
                                      ? "bg-accent text-white"
                                      : "bg-surface-secondary border border-ink-900/10 text-ink-600 hover:border-ink-900/20"
                                  }`}
                                >
                                  周{label}
                                </button>
                              );
                            })}
                          </div>
                          {dailyDays.length === 0 && (
                            <p className="mt-1.5 text-xs text-muted">每天 {dailyTime} 执行</p>
                          )}
                          {dailyDays.length > 0 && (
                            <p className="mt-1.5 text-xs text-muted">
                              每{WEEKDAY_OPTIONS.filter(o => dailyDays.includes(o.value)).map(o => "周" + o.label).join("、")} {dailyTime} 执行
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {scheduleType === "cron" && (
                      <div className="mt-4 space-y-3">
                        <label className="block">
                          <span className="text-xs font-medium text-muted">Cron 表达式</span>
                          <input
                            type="text"
                            value={cronExpr}
                            onChange={(e) => setCronExpr(e.target.value)}
                            placeholder="0 9 * * 1-5"
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 font-mono placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          />
                          <p className="mt-1.5 text-xs text-muted">
                            5 位标准 cron: 分 时 日 月 周（示例: 0 9 * * 1-5 = 工作日 9:00）
                          </p>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-muted">时区（可选）</span>
                          <input
                            type="text"
                            value={cronTimezone}
                            onChange={(e) => setCronTimezone(e.target.value)}
                            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          />
                        </label>
                      </div>
                    )}

                    {scheduleType === "hook" && (
                      <div className="mt-4 space-y-3">
                        <label className="block">
                          <span className="text-xs font-medium text-muted">触发时机</span>
                          <select
                            value={hookEvent}
                            onChange={(e) => setHookEvent(e.target.value as "startup" | "session.complete")}
                            className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                          >
                            <option value="startup">应用启动时</option>
                            <option value="session.complete">任意任务完成后</option>
                          </select>
                        </label>
                        {hookEvent === "session.complete" && (
                          <>
                            <label className="block">
                              <span className="text-xs font-medium text-muted">仅当助理完成时触发（可选）</span>
                              <select
                                value={hookFilterAssistantId}
                                onChange={(e) => setHookFilterAssistantId(e.target.value)}
                                className="mt-1.5 w-full rounded-xl border border-ink-900/10 bg-surface-secondary px-4 py-2.5 text-sm text-ink-800 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 transition-colors"
                              >
                                <option value="">任意助理</option>
                                {assistants.map((a) => (
                                  <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                              </select>
                            </label>
                            <div className="flex items-center gap-3">
                              <span className="text-xs font-medium text-muted">仅在出错时触发</span>
                              <button
                                onClick={() => setHookFilterOnlyOnError(!hookFilterOnlyOnError)}
                                className={`relative w-10 h-6 rounded-full transition-colors ${hookFilterOnlyOnError ? "bg-accent" : "bg-ink-900/20"}`}
                              >
                                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${hookFilterOnlyOnError ? "left-5" : "left-1"}`} />
                              </button>
                            </div>
                          </>
                        )}
                        <p className="text-xs text-muted">
                          {hookEvent === "startup"
                            ? "应用每次启动后 5 秒自动执行"
                            : "每当符合条件的任务完成后自动触发"}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Edit-only: status + run now + toggle + delete */}
                  {mode === "edit" && editingTask && (
                    <>
                      {/* Execution status */}
                      {editingTask.lastRunStatus && (
                        <div className={`rounded-xl px-4 py-3 text-xs ${
                          editingTask.lastRunStatus === "ok"
                            ? "bg-emerald-500/8 text-emerald-700"
                            : editingTask.lastRunStatus === "error"
                            ? "bg-red-500/8 text-red-700"
                            : "bg-ink-900/5 text-ink-500"
                        }`}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {editingTask.lastRunStatus === "ok" ? "上次执行成功" : editingTask.lastRunStatus === "error" ? "上次执行失败" : "上次已跳过"}
                            </span>
                            {editingTask.lastRun && (
                              <span className="opacity-70">{new Date(editingTask.lastRun).toLocaleString("zh-CN", { hour12: false })}</span>
                            )}
                          </div>
                          {editingTask.lastError && (
                            <p className="mt-1 opacity-80 break-all">{editingTask.lastError}</p>
                          )}
                          {editingTask.consecutiveErrors && editingTask.consecutiveErrors > 1 && (
                            <p className="mt-1 font-medium">连续失败 {editingTask.consecutiveErrors} 次</p>
                          )}
                        </div>
                      )}

                      {/* Execution history */}
                      {runHistory.length > 0 && (
                        <div className="border border-ink-900/8 rounded-xl overflow-hidden">
                          <div className="px-3 py-2 bg-surface-secondary/50 text-xs font-medium text-muted">执行历史</div>
                          <div className="max-h-36 overflow-y-auto divide-y divide-ink-900/5">
                            {runHistory.map((r, i) => (
                              <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${r.status === "ok" ? "bg-emerald-500" : r.status === "error" ? "bg-red-500" : "bg-ink-300"}`} />
                                <span className="text-ink-600 tabular-nums">{new Date(r.startedAt).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                                <span className="text-muted">{Math.round(r.durationMs / 1000)}s</span>
                                {r.error && <span className="text-red-500 truncate flex-1" title={r.error}>{r.error.slice(0, 40)}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {historyLoading && (
                        <div className="text-xs text-muted text-center py-2">加载历史...</div>
                      )}

                      <div className="border-t border-ink-900/10 pt-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-medium text-muted">启用</span>
                          <button
                            onClick={(e) => editingTask && handleToggle(editingTask, e)}
                            className={`relative w-10 h-6 rounded-full transition-colors ${
                              editingTask.enabled ? "bg-accent" : "bg-ink-900/20"
                            }`}
                          >
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                              editingTask.enabled ? "left-5" : "left-1"
                            }`} />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleRunNow}
                            disabled={loading}
                            className="flex items-center gap-1.5 rounded-lg border border-ink-900/10 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-surface-tertiary transition-colors disabled:opacity-40"
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            立即执行
                          </button>
                          <button
                            onClick={() => editingTask && handleDelete(editingTask.id)}
                            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-error hover:bg-error/10 transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                            删除
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-ink-900/10 bg-surface-secondary/50 shrink-0">
                <div className="max-w-lg mx-auto">
                  <button
                    onClick={handleSave}
                    disabled={loading || !name.trim() || (!prompt.trim() && !notifyText.trim())}
                    className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        保存中...
                      </span>
                    ) : mode === "edit" ? "保存修改" : "创建任务"}
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
