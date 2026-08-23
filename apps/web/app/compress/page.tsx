// 图片压缩占位页：工具上线前提供导航落点；占位内容不收录
import type { Metadata } from "next";
import { TOOLS } from "@/lib/site/tools";
import { ToolPlaceholder } from "@/components/tool-placeholder";

export const metadata: Metadata = {
  title: TOOLS.find((t) => t.id === "compress")?.name ?? "图片压缩",
  robots: { index: false, follow: false },
};

export default function CompressPage() {
  return <ToolPlaceholder toolId="compress" />;
}
