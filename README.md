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
- `packages/model-runtime/` — 通用资产校验、下载和按工具隔离的 CacheStorage（不包含工具 schema 或 onnxruntime-web）
- `packages/ocr/` — OCR 模型目录/schema、PP-OCR DBNet+CTC pipeline 与 `OcrRuntime`；重引擎通过 `/engine` 单独加载
- `packages/remove-bg/` — 去背景模型目录/schema、BEN2 预处理 / alpha 后处理 / `RemoveBgRuntime`；重引擎通过 `/engine` 单独加载
- `apps/web/features/` — 每个工具的界面与控制器；`shared/` 复用图片输入与任务生命周期
- `apps/web/workers/` — 按需启动的工具计算进程；主线程门面统一负责跨工具清理交接
- `scripts/` — 模型目录生成、固定版本下载、发布资产校验、字符集提取、Python 对照与模型实验

架构边界、模型交付、扩展步骤和已知限制见 [架构文档](docs/architecture.md)。

## 开发

```bash
pnpm install     # 链接 workspace，并把 ort wasm 拷到 apps/web/public/ort/
pnpm dev         # 生成模型目录并启动开发服务；不下载权重
pnpm build       # 生成目录并构建，产物 apps/web/out/；不下载权重
pnpm test        # 包、Web 控制器/Worker 契约和交付脚本的 Node 测试
pnpm typecheck
pnpm lint
# 准备 Tiny 权重并构建后，安装浏览器并跑真实 Worker/OCR 回归。
pnpm exec playwright install chromium
pnpm test:browser
```

OCR 模型来源：[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) · [PP-OCRv6 ONNX（Apache-2.0）](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx)。
每个模型的上游 revision、大小和 SHA-256 固定在 `packages/ocr/models.json`。权重下载会校验实际文件；每一档字典可以独立生成，例如：

```bash
HF_MIRROR=https://huggingface.co bash scripts/download_models.sh --model ppocrv6-tiny
python3 -m pip install pyyaml
python3 scripts/extract_charset.py --model ppocrv6-tiny
```

将模型 ID 换成 `ppocrv6-small` 或 `ppocrv6-medium` 可分别准备其他档位。

去背景模型来源：[PramaLLC/BEN2](https://github.com/PramaLLC/BEN2)（Base，MIT）· [onnx-community/BEN2-ONNX](https://huggingface.co/onnx-community/BEN2-ONNX)（FP16 转换；模型卡 MIT，仓库无独立 LICENSE 文件）。不可变 revision `c552aa82688edce09f0ac9d2e31ad53d9d629010`，生产文件 SHA-256 `dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1`。缺权重：

```bash
bash scripts/download_models.sh --model ben2-base-fp16
python3 -m pip install -r scripts/requirements-model.txt
python3 scripts/download_remove_bg_samples.py
python3 scripts/verify_remove_bg.py
```

量化是实验、不进默认清单：`python3 scripts/quantize_remove_bg.py`（本机 4 图 QDQ 曾 SIGKILL / exit 137，无产物）。验证细节见本地 `docs/remove-bg-model-validation.md`。

## 部署选择与发布检查

模型目录来源分别在 `packages/ocr/models.json` 与 `packages/remove-bg/models.json`，dev/build 生成 `/catalogs/ocr.json` 和 `/catalogs/remove-bg.json`。只有进入工具、实际选择/使用其模型时才加载对应权重；首页当前跳转 OCR，因此仍按 OCR 页行为准备推荐模型。

```bash
BASE_PATH=/image-tools NEXT_PUBLIC_TOOLS=ocr MODEL_IDS=ppocrv6-tiny pnpm build
NEXT_PUBLIC_TOOLS=ocr MODEL_IDS=ppocrv6-tiny pnpm check:assets
```

`NEXT_PUBLIC_TOOLS` 选择工具，`MODEL_IDS` 选择模型，未设置时保留各自全部条目。未知或空选择会失败。构建不改源目录，也不删除本地下载；只从最终 `out/models` 去除未选中的资产，保留所选模型的 LICENSE/MODEL_SOURCE。`check:assets` 会对发布产物严格验证文件存在、大小、摘要、许可、目录选择及 ORT JS/WASM 一致性；缺模型不能跳过。这也是 Pages 的发布门禁，PR 构建本身不下载全部权重。

当前包仍以 TypeScript workspace 依赖方式使用，尚未发布 npm。继续在一个仓库验证工具、Web 和部署的一致性；独立包的 API 和发布需求稳定后再考虑拆仓。

PR CI 同时验证全工具与 `/image-tools` 子路径构建，并使用 Tiny 进行真实浏览器推理、换图与导航回归；Pages 发布前检查模型资产和浏览器执行链路。浏览器 smoke 的 `BASE_PATH` 必须与构建一致。BEN2 的可选本地检查使用 `SMOKE_REMOVE_BG=1 pnpm test:browser`，常规 CI 不下载该大模型。

## 许可边界

- OCR 权重按上游 Apache-2.0 分发。
- 去背景生产权重只使用 BEN2 **Base** MIT；分发须保留 `apps/web/public/models/ben2-base/LICENSE` 中的 PramaLLC MIT notice，并标明转换来源。Refiner / full 不在此许可结论内。
- [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) 官方不可变 License 仅允许内部评估，禁止公开托管或分发，已排除。[RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) 为 CC BY-NC，不作为本站首版。
- `@imgly/background-removal` 为 AGPL，只作架构参考，不引入。
- 测试版页面保持 `soon` / `noindex`，主站可部署完整静态页；Pages 构建 `NEXT_PUBLIC_TOOLS=ocr`，不把 219MB BEN2 打进镜像。
