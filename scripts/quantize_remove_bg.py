#!/usr/bin/env python3
"""Run an experimental static QDQ INT8 quantization for BEN2 Base.

The script deliberately keeps quantized output outside the production model
manifest.  It uses the same fixed preprocessing contract as the browser
runtime: RGB, 1024x1024, ImageNet normalization, NCHW float32.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Sequence

import numpy as np
from PIL import Image
import PIL

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "apps" / "web" / "public" / "models" / "ben2-base" / "model.onnx"
DEFAULT_CALIBRATION_DIR = ROOT / "scripts" / "assets" / "remove-bg"
DEFAULT_OUTPUT = (
    ROOT
    / "scripts"
    / "artifacts"
    / "remove-bg"
    / "model_int8_qdq.onnx"
)
TOOL_VERSION = "1.0"
INPUT_NAME = "pixel_values"
OUTPUT_NAME = "alphas"
IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})
TARGET_WIDTH = 1024
TARGET_HEIGHT = 1024
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
EXPECTED_INPUT_SHAPE = (1, 3, TARGET_HEIGHT, TARGET_WIDTH)
EXPECTED_OUTPUT_SHAPE = (1, 1, TARGET_HEIGHT, TARGET_WIDTH)


class QuantizationError(RuntimeError):
    """An expected user-facing failure in the quantization workflow."""


def _resolve(path: Path) -> Path:
    return path.expanduser().resolve()


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _file_metadata(path: Path) -> Dict[str, Any]:
    path = _resolve(path)
    if not path.is_file():
        raise QuantizationError(f"文件不存在或不是普通文件: {path}")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source:
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                size += len(block)
    except OSError as exc:
        raise QuantizationError(f"读取文件失败 {path}: {exc}") from exc
    if size == 0:
        raise QuantizationError(f"文件为空: {path}")
    return {"path": str(path), "sizeBytes": size, "sha256": digest.hexdigest()}


def _package_version(module: Any) -> str:
    value = getattr(module, "__version__", None)
    return str(value) if value is not None else "unknown"


def _load_runtime() -> Any:
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise QuantizationError(
            "缺少 onnxruntime；请先安装 scripts/requirements-model.txt"
        ) from exc
    return ort


def _load_onnx() -> Any:
    try:
        import onnx
    except ImportError as exc:
        raise QuantizationError(
            "缺少 onnx（静态量化和 ONNX 校验必需）；请先安装 scripts/requirements-model.txt"
        ) from exc
    return onnx


def _image_paths(directory: Path) -> List[Path]:
    directory = _resolve(directory)
    if not directory.is_dir():
        raise QuantizationError(f"校准目录不存在或不是目录: {directory}")
    paths = sorted(
        (
            path
            for path in directory.rglob("*")
            if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
        ),
        key=lambda path: path.relative_to(directory).as_posix(),
    )
    if not paths:
        suffixes = ", ".join(sorted(IMAGE_SUFFIXES))
        raise QuantizationError(f"校准目录没有 JPG/PNG/WebP 图片: {directory}（支持: {suffixes}）")
    return paths


def _preprocess(path: Path) -> np.ndarray:
    try:
        with Image.open(path) as source:
            rgb = source.convert("RGB")
            resized = rgb.resize(
                (TARGET_WIDTH, TARGET_HEIGHT),
                resample=Image.Resampling.BILINEAR,
            )
            array = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
    except Exception as exc:
        raise QuantizationError(f"无法读取校准图 {path}: {exc}") from exc
    if array.shape != (TARGET_HEIGHT, TARGET_WIDTH, 3):
        raise QuantizationError(f"校准图预处理尺寸异常 {path}: {array.shape}")
    chw = np.transpose(array, (2, 0, 1))
    chw = (chw - IMAGENET_MEAN[:, None, None]) / IMAGENET_STD[:, None, None]
    batch = np.expand_dims(chw.astype(np.float32, copy=False), axis=0)
    if batch.shape != EXPECTED_INPUT_SHAPE or batch.dtype != np.float32:
        raise QuantizationError(
            f"校准图输入必须是 float32 {EXPECTED_INPUT_SHAPE}，实际 {batch.dtype} {batch.shape}: {path}"
        )
    if not np.isfinite(batch).all():
        raise QuantizationError(f"校准图预处理产生 NaN/Inf: {path}")
    return batch


def _shape_tuple(shape: Sequence[Any]) -> tuple[Any, ...]:
    return tuple(shape)


def _validate_runtime_interface(ort: Any, model: Path) -> Dict[str, Any]:
    try:
        session = ort.InferenceSession(
            str(model), providers=["CPUExecutionProvider"]
        )
    except Exception as exc:
        raise QuantizationError(f"ONNX Runtime 无法加载模型 {model}: {exc}") from exc
    try:
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        if len(inputs) != 1:
            raise QuantizationError(
                f"模型输入必须只有 pixel_values 一个，实际 {len(inputs)} 个: {model}"
            )
        if len(outputs) != 1:
            raise QuantizationError(
                f"模型输出必须只有 alphas 一个，实际 {len(outputs)} 个: {model}"
            )
        input_meta = inputs[0]
        output_meta = outputs[0]
        if input_meta.name != INPUT_NAME:
            raise QuantizationError(
                f"模型输入名必须是 {INPUT_NAME}，实际 {input_meta.name}: {model}"
            )
        if output_meta.name != OUTPUT_NAME:
            raise QuantizationError(
                f"模型输出名必须是 {OUTPUT_NAME}，实际 {output_meta.name}: {model}"
            )
        input_shape = _shape_tuple(input_meta.shape)
        output_shape = _shape_tuple(output_meta.shape)
        if input_shape != EXPECTED_INPUT_SHAPE:
            raise QuantizationError(
                f"模型输入 shape 必须是 {EXPECTED_INPUT_SHAPE}，实际 {input_shape}: {model}"
            )
        if output_shape != EXPECTED_OUTPUT_SHAPE:
            raise QuantizationError(
                f"模型输出 shape 必须是 {EXPECTED_OUTPUT_SHAPE}，实际 {output_shape}: {model}"
            )
        return {
            "input": {
                "name": input_meta.name,
                "shape": list(input_shape),
                "type": str(input_meta.type),
            },
            "output": {
                "name": output_meta.name,
                "shape": list(output_shape),
                "type": str(output_meta.type),
            },
        }
    finally:
        del session


def _validate_onnx(onnx: Any, path: Path) -> None:
    try:
        graph = onnx.load(str(path), load_external_data=True)
        onnx.checker.check_model(graph)
    except Exception as exc:
        raise QuantizationError(f"量化输出不是有效 ONNX 模型 {path}: {exc}") from exc


def _validate_quantized_graph(onnx: Any, path: Path) -> None:
    try:
        graph = onnx.load(str(path), load_external_data=True)
        quantize_nodes = [
            node
            for node in graph.graph.node
            if node.op_type == "QuantizeLinear"
        ]
        dequantize_nodes = [
            node
            for node in graph.graph.node
            if node.op_type == "DequantizeLinear"
        ]
        if not quantize_nodes or not dequantize_nodes:
            raise QuantizationError(
                f"量化输出没有 QDQ QuantizeLinear/DequantizeLinear 节点: {path}"
            )
        int8_types = {onnx.TensorProto.INT8, onnx.TensorProto.UINT8}
        if not any(initializer.data_type in int8_types for initializer in graph.graph.initializer):
            raise QuantizationError(f"量化输出没有 INT8/UINT8 权重张量: {path}")
    except QuantizationError:
        raise
    except Exception as exc:
        raise QuantizationError(f"无法检查 QDQ 量化输出 {path}: {exc}") from exc


class CalibrationDataReader:
    """Deterministic, rewindable reader expected by onnxruntime quantization."""

    def __init__(self, image_paths: Sequence[Path], input_name: str) -> None:
        self._image_paths = list(image_paths)
        self._input_name = input_name
        self._index = 0

    def get_next(self) -> Dict[str, np.ndarray] | None:
        if self._index >= len(self._image_paths):
            return None
        path = self._image_paths[self._index]
        self._index += 1
        return {self._input_name: _preprocess(path)}

    def rewind(self) -> None:
        self._index = 0


def _atomic_report(path: Path, report: Dict[str, Any]) -> None:
    path = _resolve(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    temporary_path = Path(temporary.name)
    try:
        with temporary:
            json.dump(report, temporary, ensure_ascii=False, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def _atomic_output_path(path: Path) -> Path:
    path = _resolve(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(
        mode="wb",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".part",
        delete=False,
    )
    temporary_path = Path(temporary.name)
    temporary.close()
    temporary_path.unlink()
    return temporary_path


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BEN2 Base 的实验性静态 QDQ INT8 per-channel 量化"
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"FP16 ONNX 模型（默认: {DEFAULT_MODEL}）",
    )
    parser.add_argument(
        "--calibration-dir",
        type=Path,
        default=DEFAULT_CALIBRATION_DIR,
        help=f"JPG/PNG/WebP 校准图目录（默认: {DEFAULT_CALIBRATION_DIR}）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"量化 ONNX 输出（默认写入被忽略的本地 artifacts 目录: {DEFAULT_OUTPUT}）",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="JSON 报告；省略时写到 <output>.report.json",
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> Dict[str, Any]:
    model = _resolve(args.model)
    calibration_dir = _resolve(args.calibration_dir)
    output = _resolve(args.output)
    report_path = _resolve(args.report) if args.report else output.with_suffix(".report.json")

    if output == model:
        raise QuantizationError("--output 不能覆盖 --model")
    if report_path in (model, output):
        raise QuantizationError("--report 不能覆盖模型或量化输出")
    if _is_within(output, calibration_dir) or _is_within(report_path, calibration_dir):
        raise QuantizationError("量化输出和报告不能写入校准图目录，以免污染输入")

    source_metadata = _file_metadata(model)
    image_paths = _image_paths(calibration_dir)
    ort = _load_runtime()
    onnx = _load_onnx()
    source_interface = _validate_runtime_interface(ort, model)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = _atomic_output_path(output)
    started = time.perf_counter()
    try:
        try:
            from onnxruntime.quantization import (
                CalibrationMethod,
                QuantFormat,
                QuantType,
                quantize_static,
            )
        except ImportError as exc:
            raise QuantizationError(
                "当前 onnxruntime 缺少 quantization API；请使用 requirements-model.txt 中的固定版本"
            ) from exc
        reader = CalibrationDataReader(image_paths, INPUT_NAME)
        try:
            quantize_static(
                model_input=str(model),
                model_output=str(temporary_output),
                calibration_data_reader=reader,
                quant_format=QuantFormat.QDQ,
                activation_type=QuantType.QUInt8,
                weight_type=QuantType.QInt8,
                per_channel=True,
                calibrate_method=CalibrationMethod.MinMax,
                extra_options={
                    "ActivationSymmetric": False,
                    "WeightSymmetric": True,
                },
            )
        except Exception as exc:
            raise QuantizationError(f"静态 QDQ 量化失败: {exc}") from exc
        if not temporary_output.is_file() or temporary_output.stat().st_size == 0:
            raise QuantizationError(f"量化未生成有效输出: {temporary_output}")
        _validate_onnx(onnx, temporary_output)
        _validate_quantized_graph(onnx, temporary_output)
        output_interface = _validate_runtime_interface(ort, temporary_output)
        os.replace(temporary_output, output)
    finally:
        if temporary_output.exists():
            temporary_output.unlink()
    elapsed_ms = (time.perf_counter() - started) * 1000.0

    output_metadata = _file_metadata(output)
    calibration_metadata = [_file_metadata(path) for path in image_paths]
    report: Dict[str, Any] = {
        "status": "completed",
        "tool": {
            "name": "quantize_remove_bg.py",
            "version": TOOL_VERSION,
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "numpy": _package_version(np),
            "onnx": _package_version(onnx),
            "onnxruntime": _package_version(ort),
            "Pillow": str(getattr(PIL, "__version__", "unknown")),
        },
        "source": source_metadata,
        "output": output_metadata,
        "modelInterface": {
            "source": source_interface,
            "output": output_interface,
        },
        "configuration": {
            "quantFormat": "QDQ",
            "activationType": "QUInt8",
            "weightType": "QInt8",
            "perChannel": True,
            "calibrationMethod": "MinMax",
            "preprocess": {
                "color": "RGB",
                "resize": [TARGET_WIDTH, TARGET_HEIGHT],
                "mean": IMAGENET_MEAN.tolist(),
                "std": IMAGENET_STD.tolist(),
                "layout": "NCHW",
                "dtype": "float32",
                "inputName": INPUT_NAME,
                "outputName": OUTPUT_NAME,
            },
        },
        "calibration": {
            "directory": str(calibration_dir),
            "count": len(image_paths),
            "images": calibration_metadata,
        },
        "durationMs": round(elapsed_ms, 3),
        "report": str(report_path),
    }
    _atomic_report(report_path, report)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parse_args(sys.argv[1:] if argv is None else argv)
        report = run(args)
    except KeyboardInterrupt:
        print("quantize_remove_bg.py: 已取消", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"quantize_remove_bg.py: error: {exc}", file=sys.stderr)
        return 1
    print(
        "quantization complete: "
        f"{report['output']['path']} "
        f"sizeBytes={report['output']['sizeBytes']} "
        f"sha256={report['output']['sha256']}"
    )
    print(f"report: {report['report']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
