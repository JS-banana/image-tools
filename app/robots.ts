import type { MetadataRoute } from "next";
import { IS_SUBPATH_BUILD, SITE_URL } from "@/lib/site";

// output: "export" 下由构建期静态生成 out/robots.txt，不依赖服务端
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  if (IS_SUBPATH_BUILD) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
