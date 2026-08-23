// 工具注册表：首页导航卡片与 sitemap 的唯一来源。新工具上线时加条目并置为 available。
// Pages 等演示部署可用 NEXT_PUBLIC_TOOLS=ocr 限制可用入口（逗号分隔 id），缺省全部开放。

export interface ToolEntry {
  id: string;
  /** 卡片名称 */
  name: string;
  /** 一句话定位 */
  tagline: string;
  /** 卡片正文描述 */
  description: string;
  href: string;
  status: "available" | "soon";
}

export const TOOLS: ToolEntry[] = [
  {
    id: "ocr",
    name: "OCR 文字识别",
    tagline: "图片转文字",
    description:
      "PP-OCRv6 三档模型，中英文混排，识别框与逐行结果同色对照，可复制或导出 txt。",
    href: "/ocr",
    status: "available",
  },
  {
    id: "compress",
    name: "图片压缩",
    tagline: "体积瘦身",
    description: "MozJPEG/WebP/PNG 编解码在本机完成，画质与体积的平衡可调。",
    href: "/compress",
    status: "soon",
  },
  {
    id: "remove-bg",
    name: "背景去除",
    tagline: "一键抠图",
    description: "分割模型端侧推理，输出透明背景 PNG，素材不上传。",
    href: "/remove-bg",
    status: "soon",
  },
];

const enabledIds = process.env.NEXT_PUBLIC_TOOLS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isToolEnabled(id: string): boolean {
  return !enabledIds || enabledIds.includes(id);
}

/** 当前部署实际开放的工具（Pages 门控后的可用集） */
export const ENABLED_TOOLS = TOOLS.filter((t) => isToolEnabled(t.id));
