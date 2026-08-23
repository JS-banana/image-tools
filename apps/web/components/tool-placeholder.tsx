// 未上线工具的占位页：纯服务端、零工具代码，文案取自注册表。
import Link from "next/link";
import { TOOLS } from "@/lib/site/tools";
import { SiteHeader } from "@/components/site-header";

export function ToolPlaceholder({ toolId }: { toolId: string }) {
  const tool = TOOLS.find((t) => t.id === toolId);
  // 路由与注册表同步维护，找不到属于配置错误
  if (!tool) throw new Error(`未知工具 id: ${toolId}`);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader current={tool.id} />
      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col items-center justify-center px-5 py-20 text-center">
        <h1 className="text-[24px] font-semibold tracking-tight sm:text-[28px]">{tool.name}</h1>
        <p className="mt-4 max-w-[520px] text-[14px] leading-relaxed text-muted">
          {tool.description}
        </p>
        <p className="mt-2 text-[13px] text-muted">
          功能开发中，敬请期待——上线后同样 100% 在你自己的浏览器里运行，图片不上传。
        </p>
        <Link
          href="/ocr"
          className="mt-8 inline-flex min-h-11 items-center rounded-[8px] border border-border bg-panel px-4 py-2.5 text-[13px] font-medium text-text transition-[border-color,scale] duration-150 active:scale-[0.98] [@media(hover:hover)]:hover:border-accent/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink lg:min-h-0"
        >
          先用 OCR 文字识别
        </Link>
      </main>
    </div>
  );
}
