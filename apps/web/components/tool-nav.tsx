// 顶栏工具切换导航：数据来自 lib/site/tools.ts 注册表，被 NEXT_PUBLIC_TOOLS
// 门控掉的工具不显示；未上线工具链接到占位页。无重依赖，服务端/客户端组件皆可引用。
import Link from "next/link";
import { TOOLS, isToolEnabled } from "@/lib/site/tools";

export function ToolNav({ current }: { current: string }) {
  const items = TOOLS.filter((t) => isToolEnabled(t.id));
  // 只剩一个工具时（如 Pages 演示线 NEXT_PUBLIC_TOOLS=ocr）没有切换意义，不渲染
  if (items.length < 2) return null;

  return (
    <nav
      aria-label="图片工具"
      className="flex items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-bg p-0.5"
    >
      {items.map((tool) => {
        const active = tool.id === current;
        const cls = `inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-3 py-1 text-[13px] transition-[color,background-color,scale] duration-150 lg:min-h-0 ${
          active
            ? "bg-accent/[0.15] font-medium text-accent-ink"
            : "text-muted active:scale-[0.98] [@media(hover:hover)]:hover:bg-panel [@media(hover:hover)]:hover:text-text"
        }`;
        return active ? (
          <span key={tool.id} aria-current="page" className={cls}>
            {tool.navLabel}
          </span>
        ) : (
          <Link
            key={tool.id}
            href={tool.href}
            className={`${cls} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink`}
          >
            {tool.navLabel}
          </Link>
        );
      })}
    </nav>
  );
}
