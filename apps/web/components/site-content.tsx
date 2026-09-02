// 首页静态介绍内容：服务端组件，必须留在 ocr-shell 的 ssr:false 边界之外，
// 否则不会进入静态导出的 HTML，抓取器与分享卡片只能看到空页面。
// 上传图片进入工作态后由 globals.css 的 html[data-ocr="working"] 规则隐藏。
import catalog from "@/public/models.json";
import { isPpocrModelEntry, parseModelCatalog } from "@img/model-runtime";
import { GITHUB_REPO_URL } from "@/lib/site";
import { FAQ, HOW_TO_STEPS } from "@/lib/site/ocr";

/** 档位说明属于产品文案，清单里没有；按 id 取，未知模型回落到空串 */
const MODEL_NOTES: Record<string, string> = {
  "ppocrv6-tiny": "体积最小、加载最快，截图和印刷体文档已经够用，也是移动网络下的默认选择。",
  "ppocrv6-small": "字典更完整，对小字号和复杂排版更稳，桌面端日常使用的推荐档位。",
  "ppocrv6-medium": "识别效果最好，代价是权重上百 MB 与更高内存占用，建议 Wi-Fi 下的桌面浏览器使用。",
};
const OCR_MODELS = parseModelCatalog(catalog).models.filter(isPpocrModelEntry);


function sizeMB(files: { det: { sizeBytes: number }; rec: { sizeBytes: number } }) {
  return Math.round((files.det.sizeBytes + files.rec.sizeBytes) / (1024 * 1024));
}

const sectionTitle = "text-[20px] font-semibold tracking-tight sm:text-[22px]";
const bodyText = "text-[14px] leading-relaxed text-muted";

export default function SiteContent() {
  return (
    <div id="site-content" className="border-t border-border">
      <div className="mx-auto w-full max-w-[880px] px-5 py-14 sm:px-6 sm:py-20">
        {/* 页面唯一的 h1：工作区标题在 ssr:false 边界内，不会进静态 HTML */}
        <section>
          <h1 className={sectionTitle}>在线 OCR 图片文字识别，图片不上传</h1>
          <p className={`mt-4 ${bodyText}`}>
            这是一个免费的在线图片转文字工具。和多数 OCR
            网站不同，它不会把你的图片发送到服务器：模型权重下载到浏览器之后，文本检测与识别全部由本机完成，图片数据自始至终留在当前标签页里。合同、证件、聊天记录这类不方便外传的截图，也可以放心识别。
          </p>
          <p className={`mt-3 ${bodyText}`}>
            识别引擎是 PaddleOCR 的 PP-OCRv6 模型，导出为 ONNX 后经{" "}
            <span className="font-mono text-[13px]">onnxruntime-web</span>{" "}
            在浏览器中推理，优先使用 WebGPU，不可用时回落到 WebGL 与 WebAssembly。支持中英文混排，无需注册、没有次数限制，也不加水印。
          </p>
        </section>

        <section className="mt-14">
          <h2 className={sectionTitle}>怎么用</h2>
          <ol className="mt-5 flex flex-col gap-4">
            {HOW_TO_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span
                  className="mt-px shrink-0 font-mono text-[13px] tabular-nums text-accent-ink"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold tracking-tight">{step.title}</h3>
                  <p className={`mt-1 ${bodyText}`}>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-14">
          <h2 className={sectionTitle}>三档模型怎么选</h2>
          <p className={`mt-4 ${bodyText}`}>
            准确率和下载体积不可兼得，所以准备了三档权重，可以在识别过程中随时切换。下载过的模型会缓存在本机，再次使用不必重新下载。
          </p>
          <div className="mt-6 flex flex-col gap-3">
            {OCR_MODELS.map((m) => (
              <div key={m.id} className="rounded-[10px] border border-border bg-panel p-4">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <h3 className="text-[14px] font-semibold tracking-tight">{m.label}</h3>
                  <span className="font-mono text-[12px] text-muted">{m.name}</span>
                  <span className="ml-auto font-mono text-[12px] tabular-nums text-muted">
                    约 {sizeMB(m.files)} MB
                  </span>
                </div>
                <p className={`mt-1.5 ${bodyText}`}>{MODEL_NOTES[m.id] ?? ""}</p>
              </div>
              ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className={sectionTitle}>常见问题</h2>
          <dl className="mt-5 flex flex-col divide-y divide-border border-y border-border">
            {FAQ.map((item) => (
              <div key={item.q} className="py-4">
                <dt className="text-[14px] font-semibold tracking-tight">{item.q}</dt>
                <dd className={`mt-1.5 ${bodyText}`}>{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="mt-14 flex flex-col gap-2 border-t border-border pt-8 text-[12px] text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>100% 本地运行 · 图片不上传 · MIT 开源</p>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 [@media(hover:hover)]:hover:text-accent-ink"
          >
            在 GitHub 查看源码
          </a>
        </footer>
      </div>
    </div>
  );
}
