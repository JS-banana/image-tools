// 站点顶栏：词牌 + 工具切换导航 + GitHub 入口。无重依赖，服务端/客户端组件皆可引用。
import { GITHUB_REPO_URL, SITE_NAME } from "@/lib/site";
import { ToolNav } from "@/components/tool-nav";

export function SiteHeader({ current }: { current: string }) {
  return (
    <header className="shrink-0 border-b border-border bg-panel">
      <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-4">
          {/* 词牌暂不加首页链接：/ 目前重定向回 /ocr，待首页规划后再恢复 */}
          <span className="flex shrink-0 items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <g
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                className="text-text/40"
              >
                <path d="M6.5 3H4.5A1.5 1.5 0 0 0 3 4.5v2" />
                <path d="M15.5 3h2A1.5 1.5 0 0 1 19 4.5v2" />
                <path d="M19 15.5v2a1.5 1.5 0 0 1-1.5 1.5h-2" />
                <path d="M6.5 19h-2A1.5 1.5 0 0 1 3 17.5v-2" />
              </g>
              <g stroke="#f0a23a" strokeWidth="1.6" strokeLinecap="round">
                <path d="M8 9.2h6" />
                <path d="M8 12.8h4.4" />
              </g>
            </svg>
            <span className="text-[15px] font-semibold tracking-tight">{SITE_NAME}</span>
          </span>
          <ToolNav current={current} />
        </div>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="在 GitHub 上 Star 本项目"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted transition-colors [@media(hover:hover)]:hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
          </svg>
          <span className="hidden text-[12px] font-medium tracking-tight sm:inline">Star</span>
        </a>
      </div>
    </header>
  );
}
