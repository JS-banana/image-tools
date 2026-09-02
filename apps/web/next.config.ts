import type { NextConfig } from "next";

/** GitHub Pages 等子路径部署时设 BASE_PATH=/image-tools；本地开发保持空 */
const basePath = (process.env.BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // 纯静态导出：产物 out/ 由 nginx/Cloudflare/GitHub Pages 分发，无服务端逻辑
  output: "export",
  // workspace 内 TS 源码包（无构建步骤），由 Next 直接转译
  transpilePackages: ["@img/ocr", "@img/model-runtime", "@img/remove-bg"],
  // 静态导出不支持默认 Image Optimization；图片均为用户本地上传，无需优化管线
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
