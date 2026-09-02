"use client";

import dynamic from "next/dynamic";

// onnxruntime-web 对 Node 显式禁用，必须在客户端隔离加载（官方 ClientOnly 模式）。
// 这层壳让 page.tsx 保持服务端组件；静态介绍作为 page 的 sibling 留在边界外，
// 因而进入静态 HTML。loading 只渲染文案，不导入 @img/remove-bg。
const RemoveBgClient = dynamic(() => import("@/components/remove-bg-client"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center text-muted text-sm">
      加载中…
    </div>
  ),
});

export default function RemoveBgShell() {
  return <RemoveBgClient />;
}
