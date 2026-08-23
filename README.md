<div align="center">

  <img src="apps/web/app/icon.svg" width="96" alt="图片工具箱 logo">

  <h1>图片工具箱</h1>
  <p>免费在线图片处理，推理与编解码全在浏览器完成，图片不上传。</p>

</div>

## 工具

- **OCR 文字识别**（已上线）：PP-OCRv6 三档模型（约 6MB / 30MB / 132MB），粘贴、拖入或选择图片后自动识别，结果带置信度、标注框与耗时，可复制或下载 `.txt`。
- **图片压缩**（开发中）：MozJPEG/WebP/PNG 编解码在本机完成。
- **背景去除**（规划中）：分割模型端侧推理，输出透明背景 PNG。

## 结构

pnpm workspaces + Turborepo monorepo：

- `apps/web/` — 唯一的 Next.js 应用（静态导出；`/` 暂重定向到 `/ocr`，后续按统一站点多路由扩展）
- `packages/model-runtime/` — 模型清单校验、CacheStorage 资产加载、Session 生命周期（纯逻辑，Node 可测）
- `packages/ocr/` — PP-OCR DBNet+CTC pipeline（唯一直接依赖 onnxruntime-web 的包）
- `scripts/` — 模型下载、字符集提取、Python 端到端对照、OG 图生成

## 开发

```bash
pnpm install     # 链接 workspace，并把 ort wasm 拷到 apps/web/public/ort/
pnpm dev         # 开发
pnpm build       # 构建（产物 apps/web/out/）
pnpm test        # model-runtime 单元测试（Node 内置 runner）
```

模型来源：[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [PP-OCRv6 ONNX（Apache-2.0）](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx)。
缺模型权重时：`bash scripts/download_models.sh --model ppocrv6-tiny`。
