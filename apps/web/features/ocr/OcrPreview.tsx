"use client";

import { useEffect, useRef } from "react";
import type { OcrLine } from "@img/ocr";
import { BOX_COLORS } from "./presentation";

export function OcrPreview({
  image,
  results,
  dragOver,
}: {
  image: ImageData | null;
  results: OcrLine[] | null;
  dragOver: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.putImageData(image, 0, 0);
    results?.forEach((line, index) => {
      const color = BOX_COLORS[index % BOX_COLORS.length];
      const { x0, y0, x1, y1 } = line.box;
      context.fillStyle = color + "1f";
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.strokeRect(x0, y0, x1 - x0, y1 - y0);
    });
    return () => {
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [image, results]);

  return (
    <canvas
      ref={canvasRef}
      className={`max-h-[50vh] max-w-full rounded-[4px] object-contain lg:max-h-full ${
        dragOver ? "opacity-40" : ""
      }`}
    />
  );
}
