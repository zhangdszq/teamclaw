import { useEffect, useState } from "react";

interface KnowledgePageProps {
  onClose: () => void;
  titleBarHeight?: number;
}

type TabKey = "memory" | "candidates" | "docs";

export function KnowledgePage({ onClose, titleBarHeight = 0 }: KnowledgePageProps) {
  const [tab, setTab] = useState<TabKey>("candidates");
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryDir, setMemoryDir] = useState("");

  const [editingDoc, setEditingDoc] = useState<KnowledgeDoc | null>(null);
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [showNewDoc, setShowNewDoc] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [candidateData, docData, memListData, memReadData] = await Promise.all([
        window.electron.getKnowledgeCandidates(),
        window.electron.getKnowledgeDocs(),
        window.electron.memoryList(),
        window.electron.memoryRead("long-term"),
      ]);
      setCandidates(candidateData);
      setDocs(docData);
      setMemoryDir(memListData.memoryDir || "");
      setMemoryContent(memReadData.content || "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(console.error);
  }, []);

  const renderFlow = (status: KnowledgeReviewStatus) => {
    const stages: KnowledgeReviewStatus[] = ["draft", "verified", "archived"];
    const labels: Record<KnowledgeReviewStatus, string> = {
      draft: "草稿",
      verified: "已验证",
      archived: "已归档",
    };
    const idx = stages.indexOf(status);
    return (
      <div className="flex items-center gap-1 text-[10px]">
        {stages.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <span className={`rounded-full px-2 py-0.5 ${
              i <= idx ? "bg-accent/12 text-accent" : "bg-ink-900/8 text-muted"
            }`}>
              {labels[s]}
            </span>
            {i < stages.length - 1 && <span className="text-muted-light">→</span>}
          </div>
        ))}
      </div>
    );
  };

  const openFolder = async () => {
    try {
      const path = await window.electron.getKnowledgeBasePath();
      if (path) window.electron.openPath(path);
    } catch { /* noop */ }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface-cream" style={{ top: `${titleBarHeight}px` }}>
      <header
        className="flex items-center justify-between h-12 border-b border-ink-900/10 bg-surface-cream shrink-0 select-none pr-6"
        style={{
          paddingLeft: titleBarHeight === 0 ? '80px' : '24px',
          ...(titleBarHeight === 0 ? { WebkitAppRegion: "drag" } as React.CSSProperties : {}),
        }}
      >
        <div className="flex items-center gap-3" style={titleBarHeight === 0 ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}>
          <button onClick={onClose} className="flex items-center gap-1.5 text-sm text-muted hover:text-ink-700 transition-colors">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <div className="h-4 w-px bg-ink-900/10" />
          <span className="text-sm font-semibold text-ink-800">经验</span>
        </div>
        <div style={titleBarHeight === 0 ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined} className="flex items-center gap-2">
          <button
            onClick={openFolder}
            className="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
          >
            打开目录
          </button>
          <button
            onClick={() => refresh().catch(console.error)}
            className="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
          >
            刷新
          </button>
        </div>
      </header>

      <div className="px-6 pt-4">
        <div className="flex items-center gap-1 rounded-xl bg-ink-900/5 p-1 w-fit">
          <button
            onClick={() => setTab("candidates")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === "candidates" ? "bg-white text-ink-800 shadow-soft" : "text-muted hover:text-ink-700"}`}
          >
            经验
          </button>
          <button
            onClick={() => setTab("docs")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === "docs" ? "bg-white text-ink-800 shadow-soft" : "text-muted hover:text-ink-700"}`}
          >
            知识库
          </button>
          <button
            onClick={() => setTab("memory")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === "memory" ? "bg-white text-ink-800 shadow-soft" : "text-muted hover:text-ink-700"}`}
          >
            记忆
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-6">
        {/* Memory tab */}
        {tab === "memory" && (
          <div className="grid gap-4">
            <div className="rounded-xl border border-ink-900/8 bg-surface p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-ink-800">长期记忆（MEMORY.md）</p>
                <button
                  onClick={() => {
                    if (memoryDir) window.electron.openPath(memoryDir);
                  }}
                  className="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink-700 hover:bg-ink-900/5 transition-colors"
                >
                  打开目录
                </button>
              </div>
              {loading ? (
                <p className="text-sm text-muted py-4 text-center">加载中...</p>
              ) : memoryContent ? (
                <pre className="text-xs text-ink-700 leading-relaxed whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto bg-surface-secondary rounded-lg p-3 font-mono">{memoryContent}</pre>
              ) : (
                <p className="text-sm text-muted py-4 text-center">记忆为空，Agent 会在对话中自动记录重要信息。</p>
              )}
            </div>
            <div className="rounded-xl border border-info/20 bg-info/5 p-3">
              <p className="text-xs text-info leading-relaxed">
                记忆目录包含 MEMORY.md（长期记忆）、daily/（每日记忆）、insights/（洞察）等，可直接用编辑器修改。
              </p>
            </div>
          </div>
        )}

        {/* Candidates tab */}
        {tab === "candidates" && (
          <div className="grid gap-3">
            {loading ? (
              <div className="rounded-2xl border border-ink-900/8 bg-surface px-4 py-10 text-center text-sm text-muted">
                加载中...
              </div>
            ) : candidates.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-ink-900/12 bg-surface px-4 py-10 text-center text-sm text-muted">
                暂无经验候选。完成会话后会自动抽取为本地 Markdown 文件。
              </div>
            ) : (
              candidates.map((item) => (
                <div key={item.id} className="rounded-xl border border-ink-900/8 bg-surface px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-800 truncate">{item.title || "未命名候选"}</p>
                      <p className="mt-0.5 text-xs text-muted-light">
                        {new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2">{renderFlow(item.reviewStatus)}</div>

                  {item.scenario && (
                    <p className="mt-2 text-xs text-muted leading-relaxed line-clamp-2">{item.scenario}</p>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    {item.reviewStatus === "draft" && (
                      <>
                        <button
                          onClick={async () => {
                            await window.electron.updateKnowledgeCandidateStatus(item.id, "verified");
                            await refresh();
                            setTab("docs");
                          }}
                          className="rounded-md bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/15 transition-colors"
                        >
                          标记已验证
                        </button>
                        <span className="text-[10px] text-muted-light">验证后自动生成知识文档</span>
                      </>
                    )}
                    {item.reviewStatus === "verified" && (
                      <button
                        onClick={async () => {
                          await window.electron.updateKnowledgeCandidateStatus(item.id, "archived");
                          await refresh();
                        }}
                        className="rounded-md bg-ink-900/8 px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-900/12 transition-colors"
                      >
                        归档
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (confirm("确定删除此经验候选？")) {
                          await window.electron.deleteKnowledgeCandidate(item.id);
                          await refresh();
                        }
                      }}
                      className="rounded-md bg-error/8 px-2.5 py-1 text-xs font-medium text-error hover:bg-error/12 transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Docs tab */}
        {tab === "docs" && (
          <div className="grid gap-3">
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setEditingDoc(null);
                  setDocTitle("");
                  setDocContent("");
                  setShowNewDoc(true);
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-soft"
                style={{ background: '#2C5F2F' }}
              >
                新建文档
              </button>
            </div>

            {showNewDoc && (
              <div className="rounded-xl border border-accent/20 bg-accent/5 p-4 grid gap-3">
                <input
                  type="text"
                  placeholder="文档标题"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  className="rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
                <textarea
                  placeholder="Markdown 内容..."
                  value={docContent}
                  onChange={(e) => setDocContent(e.target.value)}
                  rows={8}
                  className="rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-800 font-mono focus:outline-none focus:ring-1 focus:ring-accent/30 resize-y"
                />
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      if (!docTitle.trim()) return;
                      await window.electron.createKnowledgeDoc(docTitle.trim(), docContent.trim());
                      setShowNewDoc(false);
                      setDocTitle("");
                      setDocContent("");
                      await refresh();
                    }}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-soft"
                    style={{ background: '#2C5F2F' }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setShowNewDoc(false)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:text-ink-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {editingDoc && (
              <div className="rounded-xl border border-accent/20 bg-accent/5 p-4 grid gap-3">
                <p className="text-xs text-muted">编辑文档</p>
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  className="rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
                <textarea
                  value={docContent}
                  onChange={(e) => setDocContent(e.target.value)}
                  rows={8}
                  className="rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-800 font-mono focus:outline-none focus:ring-1 focus:ring-accent/30 resize-y"
                />
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      if (!docTitle.trim()) return;
                      await window.electron.updateKnowledgeDoc(editingDoc.id, docTitle.trim(), docContent.trim());
                      setEditingDoc(null);
                      await refresh();
                    }}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-soft"
                    style={{ background: '#2C5F2F' }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditingDoc(null)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:text-ink-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="rounded-2xl border border-ink-900/8 bg-surface px-4 py-10 text-center text-sm text-muted">
                加载中...
              </div>
            ) : docs.length === 0 && !showNewDoc ? (
              <div className="rounded-2xl border border-dashed border-ink-900/12 bg-surface px-4 py-10 text-center text-sm text-muted">
                暂无知识文档。点击「新建文档」添加 Markdown 知识条目。
              </div>
            ) : (
              docs.map((doc) => (
                <div key={doc.id} className="rounded-xl border border-ink-900/8 bg-surface px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-800 truncate">{doc.title}</p>
                      <p className="mt-0.5 text-xs text-muted-light">
                        {new Date(doc.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                      </p>
                    </div>
                  </div>
                  {doc.content && (
                    <p className="mt-2 text-xs text-muted leading-relaxed line-clamp-3 whitespace-pre-wrap">{doc.content.slice(0, 300)}</p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => {
                        setShowNewDoc(false);
                        setEditingDoc(doc);
                        setDocTitle(doc.title);
                        setDocContent(doc.content);
                      }}
                      className="rounded-md bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/15 transition-colors"
                    >
                      编辑
                    </button>
                    <button
                      onClick={async () => {
                        if (confirm("确定删除此文档？")) {
                          await window.electron.deleteKnowledgeDoc(doc.id);
                          await refresh();
                        }
                      }}
                      className="rounded-md bg-error/8 px-2.5 py-1 text-xs font-medium text-error hover:bg-error/12 transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
