import type { Metadata } from "next";
import OcrShell from "@/components/ocr-shell";
import SiteContent from "@/components/site-content";
import { SITE_URL } from "@/lib/site";
import { FAQ, OCR_DESCRIPTION, OCR_PATH, OCR_TITLE } from "@/lib/site/ocr";

export const metadata: Metadata = {
  // absolute：保持迁移前的搜索结果标题，不拼站点后缀
  title: { absolute: OCR_TITLE },
  description: OCR_DESCRIPTION,
  alternates: { canonical: OCR_PATH },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: OCR_PATH,
    title: OCR_TITLE,
    description: OCR_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: OCR_TITLE,
    description: OCR_DESCRIPTION,
  },
};

/** FAQPage 的问答必须与页面可见文本一致，两处共用 lib/site/ocr 的 FAQ */
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": `${SITE_URL}${OCR_PATH}#app`,
      name: "图片工具箱 · OCR 文字识别",
      url: `${SITE_URL}${OCR_PATH}`,
      description: OCR_DESCRIPTION,
      applicationCategory: "UtilityApplication",
      operatingSystem: "Web",
      browserRequirements: "需要支持 WebAssembly 的现代浏览器",
      inLanguage: "zh-CN",
      isAccessibleForFree: true,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
      featureList: [
        "浏览器本地推理，图片不上传",
        "中英文混排识别",
        "拖拽、选择文件或粘贴截图",
        "复制全文或导出 txt",
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}${OCR_PATH}#faq`,
      mainEntity: FAQ.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ],
};

export default function OcrPage() {
  return (
    <>
      <OcrShell />
      <SiteContent />
      <script
        type="application/ld+json"
        // JSON.stringify 不转义 <，需手动处理以避免提前闭合 script 标签
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </>
  );
}
