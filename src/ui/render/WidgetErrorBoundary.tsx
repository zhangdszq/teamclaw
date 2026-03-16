import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.warn("[WidgetErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="mt-2 rounded-xl border border-error/20 bg-error/5 p-3 text-sm text-error">
          <span className="font-medium">Widget 渲染失败</span>
          {this.state.error && (
            <pre className="mt-1 text-xs text-ink-500 whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
