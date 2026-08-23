// 站点级常量与首页可见文案。FAQ 同时供页面渲染与 JSON-LD 使用：
// 结构化数据要求 FAQPage 的问答必须在页面上可见，两处必须同源。

/** 生产域名；子路径部署（GitHub Pages）时由 NEXT_PUBLIC_SITE_URL 覆盖 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://ocr.laifuyou.com")
  .trim()
  .replace(/\/$/, "");

/** GitHub Pages 备用线：与主站内容重复，不参与索引 */
export const IS_SUBPATH_BUILD = Boolean(process.env.BASE_PATH);

export const SITE_NAME = "本地 OCR";

export const SITE_TITLE = "在线 OCR 图片文字识别 - 100% 浏览器本地运行，图片不上传";

export const SITE_DESCRIPTION =
  "免费的在线 OCR 图片转文字工具。基于 PP-OCRv6 与 onnxruntime-web，识别全过程在你自己的浏览器中完成，图片不会上传到任何服务器。支持中英文、拖拽与截图粘贴，可复制全文或导出 txt。";

export const GITHUB_REPO_URL = "https://github.com/JS-banana/ocr-app";

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: "图片会被上传到服务器吗？",
    a: "不会。模型文件下载到浏览器后，检测与识别都由本机 CPU/GPU 完成，图片数据自始至终留在当前标签页内存里，不经过任何后端接口。你可以在识别时断开网络自行验证。",
  },
  {
    q: "支持哪些语言和图片格式？",
    a: "识别中文简体、英文、数字与常见符号，中英混排无需切换语言。图片支持 PNG、JPG、WebP，可以拖拽文件、点击选择，也可以直接用 Ctrl/⌘V 粘贴截图。",
  },
  {
    q: "三档模型该怎么选？",
    a: "「快速」体积最小、加载最快，适合截图和清晰文档；「均衡」在准确率和体积之间折中，字典更全；「高精度」识别效果最好，但需要下载上百 MB 权重，建议在 Wi-Fi 和桌面浏览器下使用。",
  },
  {
    q: "第一次打开为什么要等一会儿？",
    a: "首次使用需要把 ONNX 模型权重下载到浏览器。下载完成后会缓存在本机，之后再次打开可直接从缓存读取，无需重复下载。",
  },
  {
    q: "手机可以用吗？",
    a: "可以，界面已适配手机与平板，能直接拍照或从相册选图识别。但「高精度」档权重较大，在移动网络下载耗时长且内存占用高，手机上建议使用「快速」或「均衡」档。",
  },
  {
    q: "识别结果怎么导出？",
    a: "结果按行列出并标注置信度，画面中的文本框与结果行同色对照。可以一键复制全文，也可以下载为 .txt 文件，文件名沿用原图名称。",
  },
  {
    q: "需要注册或付费吗？",
    a: "不需要。打开网页即可使用，没有登录、次数限制或水印。项目基于 MIT 协议开源，代码可在 GitHub 查看。",
  },
  {
    q: "识别不准可以怎么改善？",
    a: "优先保证原图清晰、文字不倾斜、对比度足够。手写体、艺术字、过度压缩的截图和低分辨率图片识别率会明显下降，可以换用更高精度的模型档位再试一次。",
  },
];

export interface HowToStep {
  title: string;
  detail: string;
}

export const HOW_TO_STEPS: HowToStep[] = [
  {
    title: "选择图片",
    detail: "拖拽图片到上传区、点击选择文件，或直接用 Ctrl/⌘V 粘贴剪贴板里的截图。",
  },
  {
    title: "本地识别",
    detail: "模型在浏览器中完成文本检测与识别，进度实时显示，图片不会离开你的设备。",
  },
  {
    title: "复制或导出",
    detail: "逐行查看识别结果与置信度，一键复制全文或下载为 .txt 文件。",
  },
];
