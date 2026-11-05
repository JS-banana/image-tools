#!/usr/bin/env python3
"""从已固定版本的 PP-OCRv6 inference.yml 生成本模型的字符集。

每档模型可以独立准备，不依赖先下载或生成另一档模型。
用法: python3 scripts/extract_charset.py --model ppocrv6-tiny
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "packages" / "ocr" / "models.json"
MODELS = ROOT / "apps" / "web" / "public" / "models"
CONFIG_FILES = {
    "ppocrv6-tiny": "inference_rec.yml",
    "ppocrv6-small": "inference_rec_small.yml",
    "ppocrv6-medium": "inference_rec_medium.yml",
}


def checked_bytes(content: bytes, expected: dict, label: str) -> None:
    if len(content) != expected["sizeBytes"]:
        raise SystemExit(f"{label}: sizeBytes 与模型目录不符")
    if hashlib.sha256(content).hexdigest() != expected["sha256"]:
        raise SystemExit(f"{label}: SHA-256 与模型目录不符，请核对固定版本的上游文件")


def main() -> None:
    parser = argparse.ArgumentParser(description="提取并校验 PP-OCR 字符集")
    parser.add_argument("--model", required=True, choices=sorted(CONFIG_FILES), help="模型 id")
    args = parser.parse_args()
    model = next(model for model in json.loads(CATALOG.read_text(encoding="utf-8"))["models"] if model["id"] == args.model)
    configuration = ROOT / "scripts" / CONFIG_FILES[args.model]
    if not configuration.is_file():
        raise SystemExit(f"缺少 {configuration.name}，请先运行 download_models.sh --model {args.model}")
    source = configuration.read_bytes()
    checked_bytes(source, model["configurations"]["rec"], configuration.name)
    chars = yaml.safe_load(source)["PostProcess"]["character_dict"]
    if not isinstance(chars, list) or not all(isinstance(char, str) for char in chars):
        raise SystemExit(f"{configuration.name}: PostProcess.character_dict 必须是 string[]")
    content = json.dumps(chars, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    checked_bytes(content, model["files"]["dict"], "dict.json")
    if len(chars) + 2 != model["params"]["dictSize"]:
        raise SystemExit("字符集长度与模型输出维度不符")
    output = MODELS / args.model / "dict.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)
    print(f"已校验 {len(chars)} 个字符和 SHA-256 -> {output}")


if __name__ == "__main__":
    main()
