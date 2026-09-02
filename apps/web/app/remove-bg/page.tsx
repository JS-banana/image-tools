// 背景去除测试版：主站渲染工作区 + 静态介绍；Pages 门控时仍返回占位页。
// 保持 noindex；不输出 FAQ / HowTo / JSON-LD。
import type { Metadata } from "next";
import RemoveBgContent from "@/components/remove-bg-content";
import RemoveBgShell from "@/components/remove-bg-shell";
import { ToolPlaceholder } from "@/components/tool-placeholder";
import { TOOLS, isToolEnabled } from "@/lib/site/tools";

export const metadata: Metadata = {
  title: TOOLS.find((t) => t.id === "remove-bg")?.name ?? "背景去除",
  robots: { index: false, follow: false },
};

export default function RemoveBgPage() {
  if (!isToolEnabled("remove-bg")) {
    return <ToolPlaceholder toolId="remove-bg" />;
  }

  return (
    <>
      <RemoveBgShell />
      <RemoveBgContent />
    </>
  );
}
