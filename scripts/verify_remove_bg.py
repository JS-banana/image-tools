#!/usr/bin/env python3
"""Benchmark BEN2 Base and optionally compare an INT8 candidate with FP16.

The verifier is intentionally strict.  A successful exit means every sample
produced a finite 1024x1024 alpha matte in [0, 1] with non-trivial coverage;
when --candidate is supplied, all comparison thresholds must also pass.
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
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image
import PIL

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "apps" / "web" / "public" / "models" / "ben2-base" / "model.onnx"
DEFAULT_SAMPLES = ROOT / "scripts" / "assets" / "remove-bg"
DEFAULT_SAMPLE_MANIFEST = ROOT / "scripts" / "remove_bg_samples.json"
DEFAULT_OUTPUT = ROOT / "scripts" / "artifacts" / "remove-bg" / "verification"
TOOL_VERSION = "1.0"
EXPECTED_SAMPLE_COUNT = 12
INPUT_NAME = "pixel_values"
OUTPUT_NAME = "alphas"
IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})
TARGET_WIDTH = 1024
TARGET_HEIGHT = 1024
EXPECTED_INPUT_SHAPE = (1, 3, TARGET_HEIGHT, TARGET_WIDTH)
EXPECTED_OUTPUT_SHAPE = (1, 1, TARGET_HEIGHT, TARGET_WIDTH)
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
NONZERO_ALPHA_THRESHOLD = 0.01
OPAQUE_ALPHA_THRESHOLD = 0.99
FOREGROUND_THRESHOLD = 0.5
MIN_FRACTION = 0.001
MIN_ALPHA_RANGE = 0.001
MAE_LIMIT = 0.02
P99_LIMIT = 0.12
FOREGROUND_IOU_LIMIT = 0.98
ALPHA_TOLERANCE = 1e-6


class VerificationError(RuntimeError):
    """An expected user-facing failure in model verification."""


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
        raise VerificationError(f"文件不存在或不是普通文件: {path}")
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
        raise VerificationError(f"读取文件失败 {path}: {exc}") from exc
    if size == 0:
        raise VerificationError(f"文件为空: {path}")
    return {"path": str(path), "sizeBytes": size, "sha256": digest.hexdigest()}


def _manifest_samples(manifest: Path) -> List[Tuple[str, str]]:
    manifest = _resolve(manifest)
    if not manifest.is_file():
        raise VerificationError(f"样本清单不存在或不是普通文件: {manifest}")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"无法读取样本清单 {manifest}: {exc}") from exc
    samples = data.get("samples") if isinstance(data, dict) else None
    if not isinstance(samples, list) or len(samples) != EXPECTED_SAMPLE_COUNT:
        actual = len(samples) if isinstance(samples, list) else 0
        raise VerificationError(
            f"样本清单必须恰好包含 {EXPECTED_SAMPLE_COUNT} 条，实际 {actual} 条: {manifest}"
        )

    entries: List[Tuple[str, str]] = []
    seen_names = set()
    seen_hashes = set()
    for index, item in enumerate(samples):
        name = item.get("file") if isinstance(item, dict) else None
        expected_sha256 = item.get("sha256") if isinstance(item, dict) else None
        if not isinstance(name, str) or not name:
            raise VerificationError(f"样本清单 samples[{index}].file 必须是非空字符串")
        if (
            not isinstance(expected_sha256, str)
            or len(expected_sha256) != 64
            or expected_sha256 != expected_sha256.lower()
            or any(char not in "0123456789abcdef" for char in expected_sha256)
        ):
            raise VerificationError(f"样本清单 samples[{index}].sha256 必须是小写 SHA-256")
        if "\\" in name or any(part in ("", ".", "..") for part in name.split("/")):
            raise VerificationError(f"样本清单含非法相对路径: {name}")
        relative = PurePosixPath(name)
        if relative.is_absolute() or relative.suffix.lower() not in IMAGE_SUFFIXES:
            raise VerificationError(f"样本清单含非法图片路径: {name}")
        normalized = relative.as_posix()
        if normalized in seen_names:
            raise VerificationError(f"样本清单含重复文件: {normalized}")
        if expected_sha256 in seen_hashes:
            raise VerificationError(f"样本清单含重复内容 SHA-256: {expected_sha256}")
        seen_names.add(normalized)
        seen_hashes.add(expected_sha256)
        entries.append((normalized, expected_sha256))
    return entries


def _image_paths(
    directory: Path, expected_samples: Sequence[Tuple[str, str]]
) -> List[Path]:
    directory = _resolve(directory)
    if not directory.is_dir():
        raise VerificationError(f"样本目录不存在或不是目录: {directory}")
    actual = {}
    for path in directory.rglob("*"):
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        if path.is_symlink():
            raise VerificationError(f"样本文件不能是符号链接: {path}")
        if not path.is_file():
            continue
        resolved = path.resolve()
        if not _is_within(resolved, directory):
            raise VerificationError(f"样本文件不能指向目录外: {path}")
        actual[path.relative_to(directory).as_posix()] = path

    expected_names = [name for name, _ in expected_samples]
    expected = set(expected_names)
    actual_names = set(actual)
    missing = sorted(expected - actual_names)
    extra = sorted(actual_names - expected)
    if missing or extra:
        details = []
        if missing:
            details.append("缺失: " + ", ".join(missing))
        if extra:
            details.append("额外: " + ", ".join(extra))
        raise VerificationError("样本目录必须与固定清单完全一致（" + "；".join(details) + "）")

    paths = []
    for name, expected_sha256 in expected_samples:
        path = actual[name]
        actual_sha256 = _file_metadata(path)["sha256"]
        if actual_sha256 != expected_sha256:
            raise VerificationError(
                f"样本 SHA-256 不匹配 {name}: {actual_sha256} != {expected_sha256}"
            )
        paths.append(path)
    return paths


def _preprocess(path: Path) -> Tuple[np.ndarray, np.ndarray, Tuple[int, int]]:
    try:
        with Image.open(path) as source:
            rgb = source.convert("RGB")
            original_width, original_height = rgb.size
            if original_width <= 0 or original_height <= 0:
                raise VerificationError(f"样本尺寸无效 {path}: {rgb.size}")
            original = np.asarray(rgb, dtype=np.uint8).copy()
            resized = rgb.resize(
                (TARGET_WIDTH, TARGET_HEIGHT),
                resample=Image.Resampling.BILINEAR,
            )
            array = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
    except VerificationError:
        raise
    except Exception as exc:
        raise VerificationError(f"无法读取样本 {path}: {exc}") from exc
    if original.shape != (original_height, original_width, 3):
        raise VerificationError(f"样本 RGB 解码尺寸异常 {path}: {original.shape}")
    chw = np.transpose(array, (2, 0, 1))
    chw = (chw - IMAGENET_MEAN[:, None, None]) / IMAGENET_STD[:, None, None]
    batch = np.expand_dims(chw.astype(np.float32, copy=False), axis=0)
    if batch.shape != EXPECTED_INPUT_SHAPE or batch.dtype != np.float32:
        raise VerificationError(
            f"预处理输入必须是 float32 {EXPECTED_INPUT_SHAPE}，实际 {batch.dtype} {batch.shape}: {path}"
        )
    if not np.isfinite(batch).all():
        raise VerificationError(f"预处理产生 NaN/Inf: {path}")
    return original, batch, (original_width, original_height)


def _load_runtime() -> Any:
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise VerificationError(
            "缺少 onnxruntime；请先安装 scripts/requirements-model.txt"
        ) from exc
    return ort


def _package_version(module: Any) -> str:
    value = getattr(module, "__version__", None)
    return str(value) if value is not None else "unknown"


def _validate_metadata(session: Any, model: Path) -> Dict[str, Any]:
    inputs = session.get_inputs()
    outputs = session.get_outputs()
    if len(inputs) != 1:
        raise VerificationError(
            f"模型输入必须只有 pixel_values 一个，实际 {len(inputs)} 个: {model}"
        )
    if len(outputs) != 1:
        raise VerificationError(
            f"模型输出必须只有 alphas 一个，实际 {len(outputs)} 个: {model}"
        )
    input_meta = inputs[0]
    output_meta = outputs[0]
    if input_meta.name != INPUT_NAME:
        raise VerificationError(
            f"模型输入名必须是 {INPUT_NAME}，实际 {input_meta.name}: {model}"
        )
    if output_meta.name != OUTPUT_NAME:
        raise VerificationError(
            f"模型输出名必须是 {OUTPUT_NAME}，实际 {output_meta.name}: {model}"
        )
    input_shape = tuple(input_meta.shape)
    output_shape = tuple(output_meta.shape)
    if input_shape != EXPECTED_INPUT_SHAPE:
        raise VerificationError(
            f"模型输入 shape 必须是 {EXPECTED_INPUT_SHAPE}，实际 {input_shape}: {model}"
        )
    if output_shape != EXPECTED_OUTPUT_SHAPE:
        raise VerificationError(
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


class ModelRunner:
    def __init__(self, label: str, path: Path, ort: Any) -> None:
        self.label = label
        self.path = _resolve(path)
        self.metadata = _file_metadata(self.path)
        try:
            self.session = ort.InferenceSession(
                str(self.path), providers=["CPUExecutionProvider"]
            )
        except Exception as exc:
            raise VerificationError(
                f"ONNX Runtime 无法加载 {label} 模型 {self.path}: {exc}"
            ) from exc
        try:
            self.interface = _validate_metadata(self.session, self.path)
        except Exception:
            del self.session
            raise
        self.successful_images = 0
        self.total_duration_ms = 0.0

    def run(self, batch: np.ndarray, image_name: str) -> Tuple[np.ndarray, Dict[str, Any]]:
        started = time.perf_counter()
        try:
            outputs = self.session.run(
                [OUTPUT_NAME],
                {INPUT_NAME: batch},
            )
        except Exception as exc:
            raise VerificationError(
                f"{self.label} 模型推理失败（{image_name}）: {exc}"
            ) from exc
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if len(outputs) != 1:
            raise VerificationError(
                f"{self.label} 模型输出数量异常（{image_name}）: {len(outputs)}"
            )
        alpha = np.asarray(outputs[0], dtype=np.float32)
        stats = _validate_alpha(alpha, self.label, image_name)
        self.successful_images += 1
        self.total_duration_ms += elapsed_ms
        stats["inferenceMs"] = round(elapsed_ms, 3)
        return alpha, stats

    def close(self) -> None:
        if getattr(self, "session", None) is not None:
            del self.session


def _validate_alpha(alpha: np.ndarray, label: str, image_name: str) -> Dict[str, Any]:
    if alpha.shape != EXPECTED_OUTPUT_SHAPE:
        raise VerificationError(
            f"{label} 输出 shape 必须是 {EXPECTED_OUTPUT_SHAPE}，实际 {alpha.shape}（{image_name}）"
        )
    if not np.isfinite(alpha).all():
        raise VerificationError(f"{label} 输出含 NaN/Inf（{image_name}）")
    raw_minimum = float(np.min(alpha))
    raw_maximum = float(np.max(alpha))
    if raw_minimum < -ALPHA_TOLERANCE or raw_maximum > 1.0 + ALPHA_TOLERANCE:
        raise VerificationError(
            f"{label} alpha 超出 [0, 1] 容差："
            f"min={raw_minimum:.8g}, max={raw_maximum:.8g}（{image_name}）"
        )
    np.clip(alpha, 0.0, 1.0, out=alpha)
    minimum = float(np.min(alpha))
    maximum = float(np.max(alpha))
    matte = alpha[0, 0]
    nonzero_fraction = float(np.mean(matte > NONZERO_ALPHA_THRESHOLD))
    background_fraction = float(np.mean(matte < OPAQUE_ALPHA_THRESHOLD))
    foreground_fraction = float(np.mean(matte >= FOREGROUND_THRESHOLD))
    alpha_range = maximum - minimum
    if (
        nonzero_fraction < MIN_FRACTION
        or background_fraction < MIN_FRACTION
        or foreground_fraction < MIN_FRACTION
        or foreground_fraction > 1.0 - MIN_FRACTION
        or alpha_range < MIN_ALPHA_RANGE
    ):
        raise VerificationError(
            f"{label} alpha 覆盖非平凡性校验失败（{image_name}）："
            f"nonzero={nonzero_fraction:.6f}, background={background_fraction:.6f}, "
            f"foreground={foreground_fraction:.6f}, range={alpha_range:.6f}"
        )
    return {
        "shape": list(alpha.shape),
        "dtype": str(alpha.dtype),
        "min": minimum,
        "max": maximum,
        "rawMin": raw_minimum,
        "rawMax": raw_maximum,
        "mean": float(np.mean(matte)),
        "std": float(np.std(matte)),
        "nonzeroFraction": nonzero_fraction,
        "backgroundFraction": background_fraction,
        "foregroundFraction": foreground_fraction,
        "foregroundThreshold": FOREGROUND_THRESHOLD,
    }


def _alpha_at_source_size(alpha: np.ndarray, size: Tuple[int, int]) -> np.ndarray:
    width, height = size
    matte = alpha[0, 0]
    if (width, height) == (TARGET_WIDTH, TARGET_HEIGHT):
        scaled = matte
    else:
        matte_image = Image.fromarray(np.rint(matte * 255.0).astype(np.uint8), mode="L")
        scaled = np.asarray(
            matte_image.resize((width, height), resample=Image.Resampling.BILINEAR),
            dtype=np.uint8,
        )
        return scaled.copy()
    return np.rint(scaled * 255.0).astype(np.uint8)


def _atomic_png(image: Image.Image, path: Path) -> Dict[str, Any]:
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
    try:
        image.save(temporary_path, format="PNG", compress_level=6)
        os.replace(temporary_path, path)
    except Exception:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise
    return _file_metadata(path)


def _write_outputs(
    output_dir: Path,
    relative_image: Path,
    original: np.ndarray,
    alpha: np.ndarray,
    original_size: Tuple[int, int],
) -> Dict[str, Any]:
    output_dir = _resolve(output_dir)
    relative_png = relative_image.with_suffix(".png")
    matte_path = output_dir / "matte" / relative_png
    transparent_path = output_dir / "transparent" / relative_png
    alpha8 = _alpha_at_source_size(alpha, original_size)
    matte_image = Image.fromarray(alpha8, mode="L")
    matte_metadata = _atomic_png(matte_image, matte_path)
    rgba = np.empty((original.shape[0], original.shape[1], 4), dtype=np.uint8)
    rgba[:, :, :3] = original
    rgba[:, :, 3] = alpha8
    transparent_image = Image.fromarray(rgba, mode="RGBA")
    transparent_metadata = _atomic_png(transparent_image, transparent_path)
    return {
        "matte": matte_metadata,
        "transparent": transparent_metadata,
    }


def _compare(reference: np.ndarray, candidate: np.ndarray) -> Dict[str, float]:
    absolute_error = np.abs(reference[0, 0] - candidate[0, 0]).astype(np.float64)
    reference_foreground = reference[0, 0] >= FOREGROUND_THRESHOLD
    candidate_foreground = candidate[0, 0] >= FOREGROUND_THRESHOLD
    intersection = int(np.logical_and(reference_foreground, candidate_foreground).sum())
    union = int(np.logical_or(reference_foreground, candidate_foreground).sum())
    iou = float(intersection / union) if union else 0.0
    return {
        "mae": float(np.mean(absolute_error)),
        "p99": float(np.percentile(absolute_error, 99.0)),
        "foregroundIoU": iou,
        "foregroundIntersectionPixels": float(intersection),
        "foregroundUnionPixels": float(union),
    }


def _atomic_json(path: Path, report: Dict[str, Any]) -> None:
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


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BEN2 Base ONNX 单模型基准与可选候选模型对照验证"
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"基准/参考模型（默认: {DEFAULT_MODEL}）",
    )
    parser.add_argument(
        "--candidate",
        type=Path,
        default=None,
        help="可选候选模型；提供后计算 MAE/P99/foreground IoU 门槛",
    )
    parser.add_argument(
        "--samples",
        "--sample-dir",
        "--samples-dir",
        dest="samples",
        type=Path,
        default=DEFAULT_SAMPLES,
        help=f"递归读取 JPG/PNG/WebP 样本目录（默认: {DEFAULT_SAMPLES}）",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_SAMPLE_MANIFEST,
        help=f"固定 12 图样本清单（默认: {DEFAULT_SAMPLE_MANIFEST}）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"matte/transparent 输出目录（默认写入被忽略的模型目录: {DEFAULT_OUTPUT}）",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="JSON 报告；省略时写到 <output>/verify_remove_bg.json",
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> Dict[str, Any]:
    model_path = _resolve(args.model)
    candidate_path = _resolve(args.candidate) if args.candidate else None
    samples_dir = _resolve(args.samples)
    manifest_path = _resolve(args.manifest)
    output_dir = _resolve(args.output)
    report_path = _resolve(args.report) if args.report else output_dir / "verify_remove_bg.json"
    if output_dir in (model_path, candidate_path):
        raise VerificationError("--output 不能覆盖模型文件")
    if report_path in (model_path, candidate_path):
        raise VerificationError("--report 不能覆盖模型文件")
    if _is_within(output_dir, samples_dir) or _is_within(report_path, samples_dir):
        raise VerificationError("输出目录和报告不能写入样本目录，以免覆盖输入")
    if report_path == output_dir:
        raise VerificationError("--report 不能与输出目录相同")

    expected_samples = _manifest_samples(manifest_path)
    expected_sample_names = [name for name, _ in expected_samples]
    sample_paths = _image_paths(samples_dir, expected_samples)
    ort = _load_runtime()
    reference = ModelRunner("reference", model_path, ort)
    candidate: Optional[ModelRunner] = None
    try:
        if candidate_path is not None:
            if candidate_path == model_path:
                raise VerificationError("--candidate 不能与 --model 指向同一文件")
            candidate = ModelRunner("candidate", candidate_path, ort)

        model_reports: Dict[str, Any] = {
            "reference": {
                **reference.metadata,
                "interface": reference.interface,
                "provider": "CPUExecutionProvider",
            }
        }
        if candidate is not None:
            model_reports["candidate"] = {
                **candidate.metadata,
                "interface": candidate.interface,
                "provider": "CPUExecutionProvider",
            }

        image_results: List[Dict[str, Any]] = []
        failures: List[Dict[str, str]] = []
        comparisons: List[Dict[str, Any]] = []
        for sample_path in sample_paths:
            relative_image = sample_path.relative_to(samples_dir)
            image_name = relative_image.as_posix()
            item: Dict[str, Any] = {"image": image_name}
            try:
                original, batch, original_size = _preprocess(sample_path)
                item["sourceSize"] = [original_size[0], original_size[1]]
            except Exception as exc:
                failures.append({"image": image_name, "model": "preprocess", "error": str(exc)})
                continue

            reference_alpha: Optional[np.ndarray] = None
            candidate_alpha: Optional[np.ndarray] = None
            try:
                reference_alpha, reference_stats = reference.run(batch, image_name)
                item["reference"] = {
                    "stats": reference_stats,
                    "artifacts": _write_outputs(
                        output_dir if candidate is None else output_dir / "reference",
                        relative_image,
                        original,
                        reference_alpha,
                        original_size,
                    ),
                }
            except Exception as exc:
                failures.append({"image": image_name, "model": "reference", "error": str(exc)})

            if candidate is not None:
                try:
                    candidate_alpha, candidate_stats = candidate.run(batch, image_name)
                    item["candidate"] = {
                        "stats": candidate_stats,
                        "artifacts": _write_outputs(
                            output_dir / "candidate",
                            relative_image,
                            original,
                            candidate_alpha,
                            original_size,
                        ),
                    }
                except Exception as exc:
                    failures.append({"image": image_name, "model": "candidate", "error": str(exc)})

            if reference_alpha is not None and candidate_alpha is not None:
                metric = _compare(reference_alpha, candidate_alpha)
                metric["image"] = image_name
                comparisons.append(metric)
                item["comparison"] = metric
            image_results.append(item)

        comparison_report: Optional[Dict[str, Any]] = None
        if candidate is not None:
            if comparisons:
                aggregate = {
                    "maeMax": max(metric["mae"] for metric in comparisons),
                    "p99Max": max(metric["p99"] for metric in comparisons),
                    "foregroundIoUMin": min(
                        metric["foregroundIoU"] for metric in comparisons
                    ),
                }
            else:
                aggregate = {"maeMax": None, "p99Max": None, "foregroundIoUMin": None}
            thresholds = {
                "maeMax": MAE_LIMIT,
                "p99Max": P99_LIMIT,
                "foregroundIoUMin": FOREGROUND_IOU_LIMIT,
            }
            passed = (
                bool(comparisons)
                and aggregate["maeMax"] <= MAE_LIMIT
                and aggregate["p99Max"] <= P99_LIMIT
                and aggregate["foregroundIoUMin"] >= FOREGROUND_IOU_LIMIT
            )
            comparison_report = {
                "metrics": comparisons,
                "aggregate": aggregate,
                "thresholds": thresholds,
                "passed": passed,
            }

        model_reports["reference"]["successfulImages"] = reference.successful_images
        model_reports["reference"]["inferenceDurationMs"] = round(reference.total_duration_ms, 3)
        if candidate is not None:
            model_reports["candidate"]["successfulImages"] = candidate.successful_images
            model_reports["candidate"]["inferenceDurationMs"] = round(
                candidate.total_duration_ms, 3
            )

        status = not failures and (comparison_report is None or comparison_report["passed"])
        report: Dict[str, Any] = {
            "status": "passed" if status else "failed",
            "tool": {
                "name": "verify_remove_bg.py",
                "version": TOOL_VERSION,
                "python": sys.version.split()[0],
                "platform": platform.platform(),
                "numpy": _package_version(np),
                "onnxruntime": _package_version(ort),
                "Pillow": str(getattr(PIL, "__version__", "unknown")),
            },
            "models": model_reports,
            "samples": {
                "directory": str(samples_dir),
                "manifest": str(manifest_path),
                "files": expected_sample_names,
                "count": len(sample_paths),
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
            "validation": {
                "expectedInputShape": list(EXPECTED_INPUT_SHAPE),
                "expectedOutputShape": list(EXPECTED_OUTPUT_SHAPE),
                "alphaRange": [0.0, 1.0],
                "nonzeroAlphaThreshold": NONZERO_ALPHA_THRESHOLD,
                "opaqueAlphaThreshold": OPAQUE_ALPHA_THRESHOLD,
                "foregroundThreshold": FOREGROUND_THRESHOLD,
                "minimumFraction": MIN_FRACTION,
                "minimumAlphaRange": MIN_ALPHA_RANGE,
            },
            "images": image_results,
            "failures": failures,
            "comparison": comparison_report,
            "outputDirectory": str(output_dir),
            "report": str(report_path),
        }
        _atomic_json(report_path, report)
        if not status:
            reasons = []
            if failures:
                reasons.append(f"{len(failures)} 个样本/模型失败")
            if comparison_report is not None and not comparison_report["passed"]:
                reasons.append("候选模型未通过 MAE/P99/foreground IoU 门槛")
            raise VerificationError("；".join(reasons) or "验证失败")
        return report
    finally:
        reference.close()
        if candidate is not None:
            candidate.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        args = _parse_args(sys.argv[1:] if argv is None else argv)
        report = run(args)
    except KeyboardInterrupt:
        print("verify_remove_bg.py: 已取消", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"verify_remove_bg.py: error: {exc}", file=sys.stderr)
        return 1
    print(f"verification passed: {report['report']}")
    if report["comparison"] is not None:
        aggregate = report["comparison"]["aggregate"]
        print(
            "candidate metrics: "
            f"MAE(max)={aggregate['maeMax']:.6f} "
            f"P99(max)={aggregate['p99Max']:.6f} "
            f"foregroundIoU(min)={aggregate['foregroundIoUMin']:.6f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
