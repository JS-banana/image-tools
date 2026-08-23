import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// output: "export" 下由构建期静态生成 out/sitemap.xml，不依赖服务端
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
