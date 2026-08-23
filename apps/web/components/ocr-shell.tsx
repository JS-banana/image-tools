"use client";

import dynamic from "next/dynamic";

// onnxruntime-web 对 node 显式禁用，必须在客户端隔离加载（官方 e2e 同款写法）。
// 这层壳单独存在，是为了让 page.tsx 保持服务端组件——ssr:false 子树连 children
// 插槽都不在服务端渲染，站点介绍内容必须留在这个边界之外才会进入静态 HTML。
const OcrClient = dynamic(() => import("@/components/ocr-client"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center text-muted text-sm">
      加载中…
    </div>
  ),
});

export default function OcrShell() {
  return <OcrClient />;
}
