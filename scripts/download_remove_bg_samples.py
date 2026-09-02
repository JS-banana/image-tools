#!/usr/bin/env python3
"""Download the fixed CC0 remove-background validation set."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "scripts" / "remove_bg_samples.json"
DEFAULT_OUTPUT = ROOT / "scripts" / "assets" / "remove-bg"
IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--calibration-only", action="store_true")
    return parser.parse_args()


def download(request: urllib.request.Request, temporary: Path) -> None:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            return
        except urllib.error.HTTPError as error:
            temporary.unlink(missing_ok=True)
            if error.code != 429 and error.code < 500:
                raise
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def sample_destination(output: Path, name: str) -> Path:
    if "\\" in name or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError(f"invalid sample path: {name}")
    relative = PurePosixPath(name)
    if relative.is_absolute() or relative.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError(f"invalid sample image path: {name}")
    destination = output.joinpath(*relative.parts)
    try:
        destination.resolve().relative_to(output)
    except ValueError as exc:
        raise ValueError(f"sample path escapes output directory: {name}") from exc
    if destination.is_symlink():
        raise ValueError(f"sample destination cannot be a symlink: {name}")
    return destination


def verify_sample(path: Path, expected_sha256: str) -> None:
    with Image.open(path) as image:
        image.verify()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    actual_sha256 = digest.hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"SHA-256 mismatch for {path.name}: {actual_sha256} != {expected_sha256}"
        )


def main() -> int:
    args = parse_args()
    data = json.loads(args.manifest.read_text(encoding="utf-8"))
    samples = data.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("sample manifest must contain a non-empty samples array")

    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    selected = [item for item in samples if not args.calibration_only or item.get("calibration")]
    if not selected:
        raise ValueError("no samples selected")

    for item in selected:
        name = item.get("file")
        url = item.get("url")
        expected_sha256 = item.get("sha256")
        if not isinstance(name, str) or not name or not isinstance(url, str) or not url:
            raise ValueError("each sample needs non-empty file and url fields")
        if (
            not isinstance(expected_sha256, str)
            or len(expected_sha256) != 64
            or expected_sha256 != expected_sha256.lower()
            or any(char not in "0123456789abcdef" for char in expected_sha256)
        ):
            raise ValueError(f"sample {name} needs a lowercase SHA-256")
        destination = sample_destination(output, name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            verify_sample(destination, expected_sha256)
            print(f"exists {name} (verified, skip)")
            continue

        temporary = destination.with_suffix(destination.suffix + f".part.{os.getpid()}")
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "image-tools-model-validation/1.0 (https://github.com/JS-banana/image-tools)"
            },
        )
        print(f"download {name}")
        try:
            download(request, temporary)
            verify_sample(temporary, expected_sha256)
            temporary.replace(destination)
            time.sleep(5)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    print(f"done: {len(selected)} samples under {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
