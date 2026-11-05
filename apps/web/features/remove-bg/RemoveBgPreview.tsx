"use client";

import { useEffect, useRef, type CSSProperties, type PointerEventHandler } from "react";
import { compose } from "@img/remove-bg";
import { toBackground, type BgChoice } from "./presentation";

const checkerStyle: CSSProperties = {
  backgroundColor: "#efece6",
  backgroundImage: "repeating-conic-gradient(#d8d6cf 0% 25%, #f4f3ee 0% 50%)",
  backgroundSize: "16px 16px",
};

interface RemoveBgPreviewProps {
  source: ImageData;
  alpha: Uint8ClampedArray | null;
  bgChoice: BgChoice;
  customHex: string;
  showSource: boolean;
  dragOver: boolean;
  onPointerDown: PointerEventHandler<HTMLCanvasElement>;
  onPointerUp: PointerEventHandler<HTMLCanvasElement>;
}

export function RemoveBgPreview({
  source, alpha, bgChoice, customHex, showSource, dragOver, onPointerDown, onPointerUp,
}: RemoveBgPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const composedRef = useRef<ImageData | null>(null);

  // Changing the background recomposes the existing matte without another inference.
  useEffect(() => {
    composedRef.current = alpha
      ? new ImageData(compose(source, alpha, toBackground(bgChoice, customHex)), source.width, source.height)
      : null;
  }, [source, alpha, bgChoice, customHex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = showSource ? source : (composedRef.current ?? source);
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    return () => {
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [source, alpha, showSource, bgChoice, customHex]);

  return (
    <canvas
      ref={canvasRef}
      style={checkerStyle}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      className={`max-h-[50vh] max-w-full rounded-[4px] object-contain touch-none lg:max-h-full ${
        dragOver ? "opacity-40" : ""
      } ${alpha ? "cursor-pointer" : ""}`}
    />
  );
}
