// 去背景静态介绍：必须留在 remove-bg-shell 的 ssr:false 边界之外，
// 否则不会进入静态导出的 HTML。工作态由 globals.css 的
// html[data-remove-bg="working"] 规则隐藏；默认（无 JS）保持可见。
// 测试版只输出标题、简介、隐私与浏览器要求，不含 FAQ / HowTo / JSON-LD。

const sectionTitle = "text-[20px] font-semibold tracking-tight sm:text-[22px]";
const bodyText = "text-[14px] leading-relaxed text-muted";

export default function RemoveBgContent() {
  return (
    <div id="remove-bg-content" className="border-t border-border">
      <div className="mx-auto w-full max-w-[880px] px-5 py-14 sm:px-6 sm:py-20">
        <section>
          <h1 className={sectionTitle}>在线背景去除，图片不上传</h1>
          <p className={`mt-4 ${bodyText}`}>
            这是一个测试版的在线抠图工具。分割模型在你自己的浏览器里完成推理，图片不会上传到任何服务器。支持单张
            JPG、PNG、WebP，文件不超过 50 MB、原图不超过 16,777,216 像素（4096²）；在像素预算内，最长边超过 4096 像素时会在解码阶段等比缩小。输出连续透明通道，可选择透明、白、黑或自定义纯色背景，均为
            PNG。
          </p>
          <p className={`mt-3 ${bodyText}`}>
            处理结果只留在当前标签页内存里，关闭或刷新页面即丢弃。正式能力以桌面 Chrome / Edge 的
            WebGPU 为准；没有 WebGPU 时需要你确认后再尝试兼容模式。
          </p>
        </section>

        <section className="mt-14">
          <h2 className={sectionTitle}>隐私</h2>
          <p className={`mt-4 ${bodyText}`}>
            图片、蒙版和导出文件都不会发到服务器，也不会写入云端。选图后只在本机解码和推理；关掉标签页，内存中的图片一并消失。首次使用会把模型权重下载到浏览器缓存，之后可以继续在本机处理。
          </p>
        </section>

        <section className="mt-14">
          <h2 className={sectionTitle}>浏览器要求</h2>
          <p className={`mt-4 ${bodyText}`}>
            正式路径需要支持 WebGPU 的桌面 Chrome 或 Edge。若浏览器没有 WebGPU，或 WebGPU
            初始化失败，页面会停在确认步骤，不会自动下载兼容模式所需资源；你确认后才会用
            WebAssembly 重建运行时。兼容模式明显更慢，测试版不承诺同等速度或效果，也不对手机浏览器做性能承诺。
          </p>
        </section>
      </div>
    </div>
  );
}
