// 背景去除占位页：工具上线前提供导航落点；占位内容不收录
import type { Metadata } from "next";
import { TOOLS } from "@/lib/site/tools";
import { ToolPlaceholder } from "@/components/tool-placeholder";

export const metadata: Metadata = {
  title: TOOLS.find((t) => t.id === "remove-bg")?.name ?? "背景去除",
  robots: { index: false, follow: false },
};

export default function RemoveBgPage() {
  return <ToolPlaceholder toolId="remove-bg" />;
}
