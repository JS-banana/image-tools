// 工具导航首页：纯服务端组件，不引入任何工具的客户端代码（加载纪律第 2 条）。
import Link from "next/link";
import { GITHUB_REPO_URL, SITE_NAME } from "@/lib/site";
import { TOOLS, isToolEnabled, type ToolEntry } from "@/lib/site/tools";

const bodyText = "text-[14px] leading-relaxed text-muted";

function ToolCard({ tool }: { tool: ToolEntry }) {
  const enabled = tool.status === "available" && isToolEnabled(tool.id);
  const inner = (
    <>
      <div className="flex items-baseline gap-x-2.5">
        <h2 className="text-[16px] font-semibold tracking-tight">{tool.name}</h2>
        <span className="font-mono text-[12px] text-muted">{tool.tagline}</span>
        {!enabled && (
          <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
            即将推出
          </span>
        )}
      </div>
      <p className={`mt-2 ${bodyText}`}>{tool.description}</p>
    </>
  );
  const cls = enabled
    ? "block rounded-[10px] border border-border bg-panel p-5 transition-colors [@media(hover:hover)]:hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
    : "block rounded-[10px] border border-border bg-panel p-5 opacity-60";
  return enabled ? (
    <Link href={tool.href} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls} aria-disabled="true">
      {inner}
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="shrink-0 border-b border-border bg-panel">
        <div className="mx-auto flex h-12 w-full max-w-[880px] items-center justify-between px-4">
          <span className="text-[15px] font-semibold tracking-tight">{SITE_NAME}</span>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在 GitHub 上 Star 本项目"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted transition-colors [@media(hover:hover)]:hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
            </svg>
            <span className="text-[12px] font-medium tracking-tight">Star</span>
          </a>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
        <section>
          <h1 className="text-[24px] font-semibold tracking-tight sm:text-[28px]">
            {SITE_NAME}
          </h1>
          <p className={`mt-4 ${bodyText}`}>
            免费、无需注册的在线图片工具。和多数在线工具不同，这里的所有处理都在你自己的浏览器里完成——图片数据自始至终不离开当前标签页，不上传任何服务器。
          </p>
        </section>

        <section className="mt-10" aria-label="工具列表">
          <div className="flex flex-col gap-3">
            {TOOLS.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-[20px] font-semibold tracking-tight sm:text-[22px]">
            为什么放在浏览器里跑
          </h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[10px] border border-border bg-panel p-4">
              <h3 className="text-[14px] font-semibold tracking-tight">隐私</h3>
              <p className={`mt-1.5 ${bodyText}`}>
                模型与编解码器下载到本机后离线可用，证件、合同、聊天记录这类图片可以放心处理。
              </p>
            </div>
            <div className="rounded-[10px] border border-border bg-panel p-4">
              <h3 className="text-[14px] font-semibold tracking-tight">免费</h3>
              <p className={`mt-1.5 ${bodyText}`}>
                没有账号、次数限制与水印，计算用的是你自己的设备，项目基于 MIT 协议开源。
              </p>
            </div>
            <div className="rounded-[10px] border border-border bg-panel p-4">
              <h3 className="text-[14px] font-semibold tracking-tight">快</h3>
              <p className={`mt-1.5 ${bodyText}`}>
                省去上传与排队，模型与编解码器缓存一次后，再次使用随开随用。
              </p>
            </div>
          </div>
        </section>

        <footer className="mt-14 flex flex-col gap-2 border-t border-border pt-8 text-[12px] text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>100% 本地运行 · 图片不上传 · MIT 开源</p>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 [@media(hover:hover)]:hover:text-accent-ink"
          >
            在 GitHub 查看源码
          </a>
        </footer>
      </main>
    </div>
  );
}
