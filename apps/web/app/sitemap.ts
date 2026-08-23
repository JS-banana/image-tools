import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { ENABLED_TOOLS } from "@/lib/site/tools";

// output: "export" 下由构建期静态生成 out/sitemap.xml，不依赖服务端
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "monthly",
      priority: 1,
    },
    // 只收录实际可用（未被 NEXT_PUBLIC_TOOLS 门控掉）的工具路由
    ...ENABLED_TOOLS.filter((t) => t.status === "available").map((t) => ({
      url: `${SITE_URL}${t.href}`,
      changeFrequency: "monthly" as const,
      priority: 0.9,
    })),
  ];
}
