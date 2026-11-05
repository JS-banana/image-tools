"use client";

import dynamic from "next/dynamic";

// Keep the interactive workspace separate from the page's static content.
// The workspace uses a lightweight client; inference code loads inside its Worker.
const RemoveBgWorkspace = dynamic(() => import("@/features/remove-bg/RemoveBgWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center text-muted text-sm">
      加载中…
    </div>
  ),
});

export default function RemoveBgShell() {
  return <RemoveBgWorkspace />;
}
