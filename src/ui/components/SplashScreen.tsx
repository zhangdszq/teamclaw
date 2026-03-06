import { useState, useEffect, useCallback, useRef } from "react";
import splash1 from "../../../assets/splash-1.jpg";
import splash2 from "../../../assets/splash-2.jpg";
import splash3 from "../../../assets/splash-3.jpg";
import splash4 from "../../../assets/splash-4.jpg";
import splash5 from "../../../assets/splash-5.jpg";

interface SlideData {
  image: string;
  title: string;
  subtitle: string;
}

const slides: SlideData[] = [
  {
    image: splash1,
    title: "你的专属 AI 团队",
    subtitle: "多位 AI 助手各司其职，在你身边随时协作",
  },
  {
    image: splash2,
    title: "随时随地，跨平台连接",
    subtitle: "通过钉钉、飞书等平台，随时和 AI 团队沟通",
  },
  {
    image: splash3,
    title: "智能记忆，越用越懂你",
    subtitle: "AI 团队会记住你的偏好，理解你的工作习惯",
  },
  {
    image: splash4,
    title: "协同规划，高效推进",
    subtitle: "AI 团队帮你拆解任务、管理项目、激发灵感",
  },
  {
    image: splash5,
    title: "你休息，AI 不打烊",
    subtitle: "定时任务全自动执行，安心做你想做的事",
  },
];

const AUTO_ADVANCE_MS = 4000;

interface SplashScreenProps {
  onComplete: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState<"next" | "prev">("next");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLast = currentIndex === slides.length - 1;

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!isLast) {
        setDirection("next");
        setIsTransitioning(true);
        setTimeout(() => {
          setCurrentIndex((i) => i + 1);
          setIsTransitioning(false);
        }, 400);
      }
    }, AUTO_ADVANCE_MS);
  }, [isLast]);

  useEffect(() => {
    resetTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [currentIndex, resetTimer]);

  const goTo = useCallback(
    (idx: number) => {
      if (idx === currentIndex || isTransitioning) return;
      setDirection(idx > currentIndex ? "next" : "prev");
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentIndex(idx);
        setIsTransitioning(false);
      }, 400);
    },
    [currentIndex, isTransitioning],
  );

  const handleComplete = useCallback(() => {
    setFadeOut(true);
    setTimeout(onComplete, 500);
  }, [onComplete]);

  const slide = slides[currentIndex];

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-500 ${
        fadeOut ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Full-screen 16:9 container */}
      <div
        className="relative flex flex-col overflow-hidden bg-surface"
        style={{ width: "100vw", height: "100vh" }}
      >
        {/* Top: Image (≈60%) */}
        <div className="relative w-full shrink-0 overflow-hidden bg-surface-secondary" style={{ height: "72%" }}>
          <img
            src={slide.image}
            alt={slide.title}
            className={`absolute inset-0 h-full w-full object-cover transition-all duration-500 ease-out ${
              isTransitioning
                ? direction === "next"
                  ? "translate-x-[-6%] opacity-0 scale-[0.97]"
                  : "translate-x-[6%] opacity-0 scale-[0.97]"
                : "translate-x-0 opacity-100 scale-100"
            }`}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white to-transparent" />
        </div>

        {/* Bottom: Content (≈28%) */}
        <div className="relative flex flex-1 flex-col items-center justify-center px-8 -mt-2">
          {/* Text */}
          <div
            className={`mb-3 text-center transition-all duration-500 ease-out ${
              isTransitioning ? "translate-y-3 opacity-0" : "translate-y-0 opacity-100"
            }`}
          >
            <h1 className="mb-1 text-lg font-bold tracking-tight text-ink-900">
              {slide.title}
            </h1>
            <p className="text-[13px] leading-relaxed text-ink-500">
              {slide.subtitle}
            </p>
          </div>

          {/* Dots + Buttons row */}
          <div className="flex items-center gap-6">
            {/* Dot indicators */}
            <div className="flex items-center gap-2">
              {slides.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => goTo(idx)}
                  className="group relative flex h-5 w-5 items-center justify-center"
                >
                  <span
                    className={`block rounded-full transition-all duration-300 ${
                      idx === currentIndex
                        ? "h-2.5 w-2.5 bg-accent shadow-[0_0_8px_rgba(217,119,87,0.3)]"
                        : "h-[6px] w-[6px] bg-ink-400/25 group-hover:bg-ink-400/45"
                    }`}
                  />
                  {idx === currentIndex && !isLast && (
                    <svg
                      className="absolute inset-0 h-5 w-5 -rotate-90"
                      viewBox="0 0 20 20"
                    >
                      <circle
                        cx="10"
                        cy="10"
                        r="8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="text-accent/30"
                        strokeDasharray={`${2 * Math.PI * 8}`}
                        style={{
                          strokeDashoffset: "0",
                          animation: `splash-progress ${AUTO_ADVANCE_MS}ms linear forwards`,
                        }}
                        key={`progress-${currentIndex}`}
                      />
                    </svg>
                  )}
                </button>
              ))}
            </div>

            {/* Separator */}
            <div className="h-5 w-px bg-ink-900/10" />

            {/* Action buttons */}
            <div className="flex items-center gap-2.5">
              {!isLast && (
                <button
                  onClick={handleComplete}
                  className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-ink-500 transition-colors hover:bg-surface-tertiary hover:text-ink-700"
                >
                  跳过
                </button>
              )}
              <button
                onClick={isLast ? handleComplete : () => goTo(currentIndex + 1)}
                className="rounded-lg bg-accent px-6 py-1.5 text-[13px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover hover:shadow-card active:scale-[0.97]"
              >
                {isLast ? "开始使用" : "下一步"}
              </button>
            </div>
          </div>

          {/* Bottom branding */}
          <div className="absolute bottom-3 flex items-center gap-1.5 text-[10px] text-ink-400/50">
            <span>AI Team</span>
            <span className="text-ink-400/25">|</span>
            <span>你的智能协作伙伴</span>
          </div>
        </div>
      </div>
    </div>
  );
}
