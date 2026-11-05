"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

export type ImageOrigin = "file" | "paste";
export type ImageInputHandler = (
  file: File | undefined | null,
  origin: ImageOrigin,
) => void;

/** Input mechanics shared by tools; decoding and size policy belong to the caller. */
export function useImageInput(onImage: ImageInputHandler) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) return;

      for (const item of event.clipboardData?.items ?? []) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          onImage(file, "paste");
          return;
        }
      }
      for (const file of event.clipboardData?.files ?? []) {
        if (!file.type.startsWith("image/")) continue;
        event.preventDefault();
        onImage(file, "paste");
        return;
      }
    };
    // A file dropped outside a tool's target must not navigate away from the app.
    const preventNavigation = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
    };
  }, [onImage]);

  const dropHandlers = {
    onDragOver(event: DragEvent) {
      event.preventDefault();
      setDragOver(true);
    },
    onDragEnter(event: DragEvent) {
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave(event: DragEvent) {
      event.preventDefault();
      setDragOver(false);
    },
    onDrop(event: DragEvent) {
      event.preventDefault();
      setDragOver(false);
      onImage(event.dataTransfer.files[0], "file");
    },
  };

  const resetInput = useCallback(() => {
    setDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  return { fileInputRef, dragOver, dropHandlers, resetInput, openFilePicker };
}
