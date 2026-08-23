// 站点级常量与共享类型。per-tool 文案在各工具模块（如 ./ocr）；
// 结构化数据要求 JSON-LD 与页面可见文本同源，两处必须引用同一份配置。

/** 生产域名；子路径部署（GitHub Pages）时由 NEXT_PUBLIC_SITE_URL 覆盖 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://img.laifuyou.com")
  .trim()
  .replace(/\/$/, "");

/** GitHub Pages 备用线：与主站内容重复，不参与索引 */
export const IS_SUBPATH_BUILD = Boolean(process.env.BASE_PATH);

export const SITE_NAME = "图片工具箱";

export const SITE_TITLE = "图片工具箱 - 免费在线图片处理，100% 浏览器本地运行";

export const SITE_DESCRIPTION =
  "免费的在线图片工具箱：OCR 文字识别、图片压缩、背景去除……所有处理都在你自己的浏览器中完成，图片不会上传到任何服务器。无需注册、没有次数限制、不加水印。";

export const GITHUB_REPO_URL = "https://github.com/JS-banana/ocr-app";

export interface FaqItem {
  q: string;
  a: string;
}

export interface HowToStep {
  title: string;
  detail: string;
}
