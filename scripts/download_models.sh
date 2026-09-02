#!/usr/bin/env bash
# 下载 PP-OCRv6 ONNX 模型与 BEN2 Base FP16 去背景模型。
# macOS bash 3.2 兼容：无 associative array、无 mapfile。
# 落盘布局：apps/web/public/models/<model-id>/{det,rec}.onnx；
# BEN2 Base 写入 apps/web/public/models/ben2-base/model.onnx。
#
# 用法:
#   bash scripts/download_models.sh --model ppocrv6-tiny
#   bash scripts/download_models.sh --model ppocrv6-small
#   bash scripts/download_models.sh --model ppocrv6-medium
#   bash scripts/download_models.sh --model ben2-base-fp16
set -euo pipefail

MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
BASE="$MIRROR/PaddlePaddle"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/public/models"

# BEN2-ONNX is pinned to an immutable revision.  Keep these values in sync
# with the model qualification report and MODEL_SOURCE written below.
BEN2_REPO="onnx-community/BEN2-ONNX"
BEN2_REVISION="c552aa82688edce09f0ac9d2e31ad53d9d629010"
BEN2_REMOTE="onnx/model_fp16.onnx"
BEN2_SIZE="219121675"
BEN2_SHA256="dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1"

MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model)
      if [ $# -lt 2 ]; then
        echo "missing --model value" >&2
        exit 2
      fi
      MODEL="$2"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "usage: bash scripts/download_models.sh --model ppocrv6-tiny|ppocrv6-small|ppocrv6-medium|ben2-base-fp16"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$MODEL" ]; then
  MODEL="ppocrv6-tiny"
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "need shasum or sha256sum" >&2
    exit 1
  fi
}

download_atomic() {
  _url="$1"
  _dest="$2"
  _tmp="${_dest}.part.$$"
  rm -f "$_tmp"
  echo "download: $_url"
  if ! curl -L --fail --progress-bar "$_url" -o "$_tmp"; then
    rm -f "$_tmp"
    echo "failed: $_url" >&2
    exit 1
  fi
  if ! mv "$_tmp" "$_dest"; then
    rm -f "$_tmp"
    echo "failed to install downloaded file: $_dest" >&2
    exit 1
  fi
  _sz=$(wc -c < "$_dest" | tr -d '[:space:]')
  _digest=$(sha256_file "$_dest")
  echo "  ok $(basename "$_dest") sizeBytes=${_sz} sha256=${_digest}"
}

verify_expected_file() {
  _label="$1"
  _dest="$2"
  _expected_size="$3"
  _expected_sha="$4"
  if [ ! -f "$_dest" ]; then
    echo "missing $_label: $_dest" >&2
    return 1
  fi
  _actual_size=$(wc -c < "$_dest" | tr -d '[:space:]')
  if [ "$_actual_size" != "$_expected_size" ]; then
    echo "size mismatch for $_label: expected ${_expected_size} bytes, got ${_actual_size} bytes ($_dest)" >&2
    return 1
  fi
  _actual_sha=$(sha256_file "$_dest")
  if [ "$_actual_sha" != "$_expected_sha" ]; then
    echo "sha256 mismatch for $_label: expected ${_expected_sha}, got ${_actual_sha} ($_dest)" >&2
    return 1
  fi
  echo "verified $_label sizeBytes=${_actual_size} sha256=${_actual_sha}"
  return 0
}

download_verified() {
  _url="$1"
  _label="$2"
  _dest="$3"
  _expected_size="$4"
  _expected_sha="$5"
  _tmp="${_dest}.part.$$"
  rm -f "$_tmp"
  echo "download: $_url"
  if ! curl -L --fail --progress-bar "$_url" -o "$_tmp"; then
    rm -f "$_tmp"
    echo "failed: $_url" >&2
    exit 1
  fi
  if ! verify_expected_file "${_label} (temporary download)" "$_tmp" "$_expected_size" "$_expected_sha"; then
    rm -f "$_tmp"
    echo "refusing to install unverified download: $_url" >&2
    exit 1
  fi
  if ! mv "$_tmp" "$_dest"; then
    rm -f "$_tmp"
    echo "failed to install verified download: $_dest" >&2
    exit 1
  fi
  echo "  installed $_label sizeBytes=${_expected_size} sha256=${_expected_sha}"
}

ensure_verified_download() {
  _url="$1"
  _label="$2"
  _dest="$3"
  _expected_size="$4"
  _expected_sha="$5"
  mkdir -p "$(dirname "$_dest")"
  if [ -e "$_dest" ] && [ ! -f "$_dest" ]; then
    echo "destination is not a regular file: $_dest" >&2
    exit 1
  fi
  if [ -f "$_dest" ]; then
    if ! verify_expected_file "$_label" "$_dest" "$_expected_size" "$_expected_sha"; then
      echo "existing file failed verification; refusing to skip: $_dest" >&2
      exit 1
    fi
    return 0
  fi
  download_verified "$_url" "$_label" "$_dest" "$_expected_size" "$_expected_sha"
}

write_ben2_notices() {
  _dir="$1"
  _license="$2"
  _source="$3"
  _license_tmp="${_license}.tmp.$$"
  _source_tmp="${_source}.tmp.$$"
  rm -f "$_license_tmp" "$_source_tmp"

  cat > "$_license_tmp" <<'EOF'
MIT License

Copyright (c) 2025 Prama LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

  cat > "$_source_tmp" <<EOF
BEN2 Base FP16 ONNX model source

This directory contains the BEN2 Base FP16 ONNX export used by the remove-bg
tool. The source file is distributed from the onnx-community conversion
repository; the base model and its MIT notice are attributed to Prama LLC.

Upstream model repository:
  https://huggingface.co/${BEN2_REPO}
Immutable revision:
  ${BEN2_REVISION}
File:
  ${BEN2_REMOTE}
Canonical resolved URL:
  https://huggingface.co/${BEN2_REPO}/resolve/${BEN2_REVISION}/${BEN2_REMOTE}
Expected sizeBytes:
  ${BEN2_SIZE}
Expected SHA256:
  ${BEN2_SHA256}

Base model source:
  https://github.com/PramaLLC/BEN2
Base model license:
  MIT; see LICENSE in this directory.

The fixed revision and digest above identify the exact bytes distributed here.
The INT8 quantization scripts in scripts/ create experimental derivatives; no
quantized derivative is implied to be approved for production distribution.
EOF

  if [ -e "$_license" ]; then
    if [ ! -f "$_license" ] || ! cmp -s "$_license_tmp" "$_license"; then
      rm -f "$_license_tmp" "$_source_tmp"
      echo "existing BEN2 LICENSE does not match the pinned Prama LLC notice: $_license" >&2
      exit 1
    fi
    rm -f "$_license_tmp"
  else
    if ! mv "$_license_tmp" "$_license"; then
      rm -f "$_license_tmp" "$_source_tmp"
      echo "failed to install BEN2 LICENSE: $_license" >&2
      exit 1
    fi
  fi

  if [ -e "$_source" ]; then
    if [ ! -f "$_source" ] || ! cmp -s "$_source_tmp" "$_source"; then
      rm -f "$_source_tmp"
      echo "existing BEN2 MODEL_SOURCE does not match the pinned source record: $_source" >&2
      exit 1
    fi
    rm -f "$_source_tmp"
  else
    if ! mv "$_source_tmp" "$_source"; then
      rm -f "$_source_tmp"
      echo "failed to install BEN2 MODEL_SOURCE: $_source" >&2
      exit 1
    fi
  fi
  echo "verified BEN2 license and source notices under $_dir"
}

skip_or_fetch() {
  _out_name="$1"
  _repo="$2"
  _remote="$3"
  _dest="$4"
  _url="${BASE}/${_repo}/resolve/main/${_remote}"
  mkdir -p "$(dirname "$_dest")"
  if [ -e "$_dest" ] && [ ! -f "$_dest" ]; then
    echo "destination is not a regular file: $_dest" >&2
    exit 1
  fi
  if [ -f "$_dest" ]; then
    _sz=$(wc -c < "$_dest" | tr -d '[:space:]')
    if [ "$_sz" = "0" ]; then
      echo "existing file is empty: $_dest" >&2
      exit 1
    fi
    _digest=$(sha256_file "$_dest")
    echo "exists ${_out_name} sizeBytes=${_sz} sha256=${_digest} (skip, verified readable)"
    return 0
  fi
  download_atomic "$_url" "$_dest"
}

case "$MODEL" in
  ppocrv6-tiny)
    skip_or_fetch "ppocrv6-tiny/det.onnx" "PP-OCRv6_tiny_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-tiny/det.onnx"
    skip_or_fetch "ppocrv6-tiny/rec.onnx" "PP-OCRv6_tiny_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-tiny/rec.onnx"
    skip_or_fetch "inference_rec.yml" "PP-OCRv6_tiny_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec.yml"
    skip_or_fetch "inference_det_tiny.yml" "PP-OCRv6_tiny_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_tiny.yml"
    echo "done: tiny weights under $OUT/ppocrv6-tiny (dict via extract_charset.py)"
    ;;
  ppocrv6-small)
    skip_or_fetch "ppocrv6-small/det.onnx" "PP-OCRv6_small_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-small/det.onnx"
    skip_or_fetch "ppocrv6-small/rec.onnx" "PP-OCRv6_small_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-small/rec.onnx"
    skip_or_fetch "inference_det_small.yml" "PP-OCRv6_small_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_small.yml"
    skip_or_fetch "inference_rec_small.yml" "PP-OCRv6_small_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec_small.yml"
    echo "done: small weights under $OUT/ppocrv6-small (dict via extract_charset.py)"
    ;;
  ppocrv6-medium)
    skip_or_fetch "ppocrv6-medium/det.onnx" "PP-OCRv6_medium_det_onnx" "inference.onnx" \
      "$OUT/ppocrv6-medium/det.onnx"
    skip_or_fetch "ppocrv6-medium/rec.onnx" "PP-OCRv6_medium_rec_onnx" "inference.onnx" \
      "$OUT/ppocrv6-medium/rec.onnx"
    skip_or_fetch "inference_det_medium.yml" "PP-OCRv6_medium_det_onnx" "inference.yml" \
      "$ROOT/scripts/inference_det_medium.yml"
    skip_or_fetch "inference_rec_medium.yml" "PP-OCRv6_medium_rec_onnx" "inference.yml" \
      "$ROOT/scripts/inference_rec_medium.yml"
    echo "done: medium weights under $OUT/ppocrv6-medium (dict via extract_charset.py)"
    ;;
  ben2-base-fp16)
    _ben2_dir="$OUT/ben2-base"
    _ben2_dest="$_ben2_dir/model.onnx"
    _ben2_url="${MIRROR}/${BEN2_REPO}/resolve/${BEN2_REVISION}/${BEN2_REMOTE}"
    ensure_verified_download "$_ben2_url" "ben2-base-fp16 (${BEN2_REMOTE})" \
      "$_ben2_dest" "$BEN2_SIZE" "$BEN2_SHA256"
    write_ben2_notices "$_ben2_dir" "$_ben2_dir/LICENSE" "$_ben2_dir/MODEL_SOURCE"
    echo "done: BEN2 Base FP16 under $_ben2_dir"
    ;;
  *)
    echo "unknown model: $MODEL (ppocrv6-tiny|ppocrv6-small|ppocrv6-medium|ben2-base-fp16)" >&2
    exit 2
    ;;
esac
