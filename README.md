<div align="center">

  <img src="apps/web/app/icon.svg" width="96" alt="图片工具箱 logo">

  <h1>图片工具箱</h1>
  <p>免费在线图片处理，推理与编解码全在浏览器完成，图片不上传。</p>

</div>

## 工具

- **OCR 文字识别**（已上线）：PP-OCRv6 三档模型（约 6MB / 30MB / 132MB），粘贴、拖入或选择图片后自动识别，结果带置信度、标注框与耗时，可复制或下载 `.txt`。
- **图片压缩**（开发中）：MozJPEG/WebP/PNG 编解码在本机完成。
- **背景去除**（测试版，注册表仍 `soon`，页面 `noindex`、不进 sitemap）：BEN2 Base FP16（`219,121,675` 字节，约 219MB）端侧推理，输出连续 alpha PNG。主站 `/remove-bg` 已接线测试工作区；GitHub Pages 镜像仍只开放 OCR、不打包该模型。非商用且禁止公开托管的 RMBG 系权重不使用。

## 结构

pnpm workspaces + Turborepo monorepo：

- `apps/web/` — 唯一的 Next.js 应用（静态导出；`/` 暂重定向到 `/ocr`，后续按统一站点多路由扩展）
- `packages/model-runtime/` — 模型清单联合校验、CacheStorage 资产加载（纯逻辑，无 onnxruntime-web，Node 可测）
- `packages/ocr/` — PP-OCR DBNet+CTC pipeline 与 `OcrRuntime`（OCR 侧唯一直接依赖 onnxruntime-web 的包）
- `packages/remove-bg/` — BEN2 预处理 / alpha 后处理 / `RemoveBgRuntime`（去背景侧唯一直接依赖 onnxruntime-web 的包）
- `scripts/` — 模型下载、字符集提取、Python 端到端对照、去背景样本与验证 / 量化、OG 图生成

## 开发

```bash
pnpm install     # 链接 workspace，并把 ort wasm 拷到 apps/web/public/ort/
pnpm dev         # 开发
pnpm build       # 构建（产物 apps/web/out/）
pnpm test        # model-runtime / ocr / remove-bg 的 Node 内置 runner 测试
```

OCR 模型来源：[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [PP-OCRv6 ONNX（Apache-2.0）](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx)。
缺 OCR 权重：`bash scripts/download_models.sh --model ppocrv6-tiny|ppocrv6-small|ppocrv6-medium`。

去背景模型来源：[PramaLLC/BEN2](https://github.com/PramaLLC/BEN2)（Base，MIT）· [onnx-community/BEN2-ONNX](https://huggingface.co/onnx-community/BEN2-ONNX)（FP16 转换；模型卡 MIT，仓库无独立 LICENSE 文件）。不可变 revision `c552aa82688edce09f0ac9d2e31ad53d9d629010`，生产文件 SHA-256 `dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1`。缺权重：

```bash
bash scripts/download_models.sh --model ben2-base-fp16
python3 -m pip install -r scripts/requirements-model.txt
python3 scripts/download_remove_bg_samples.py
python3 scripts/verify_remove_bg.py
```

量化是实验、不进默认清单：`python3 scripts/quantize_remove_bg.py`（本机 4 图 QDQ 曾 SIGKILL / exit 137，无产物）。验证细节见本地 `docs/remove-bg-model-validation.md`。

## 许可边界

- OCR 权重按上游 Apache-2.0 分发。
- 去背景生产权重只使用 BEN2 **Base** MIT；分发须保留 `apps/web/public/models/ben2-base/LICENSE` 中的 PramaLLC MIT notice，并标明转换来源。Refiner / full 不在此许可结论内。
- [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) 官方不可变 License 仅允许内部评估，禁止公开托管或分发，已排除。[RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) 为 CC BY-NC，不作为本站首版。
- `@imgly/background-removal` 为 AGPL，只作架构参考，不引入。
- 测试版页面保持 `soon` / `noindex`，主站可部署完整静态页；Pages 构建 `NEXT_PUBLIC_TOOLS=ocr`，不把 219MB BEN2 打进镜像。
