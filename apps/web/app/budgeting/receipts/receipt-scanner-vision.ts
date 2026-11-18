export type ReceiptFrame = { left: number; top: number; right: number; bottom: number };
type ImageSample = { width: number; height: number; pixels: Uint8Array };

export function findReceiptFrame({ width, height, pixels }: ImageSample): ReceiptFrame | null {
  const cornerSize = Math.max(2, Math.floor(Math.min(width, height) * 0.12));
  const corners: number[] = [];
  for (const top of [0, height - cornerSize]) {
    for (const left of [0, width - cornerSize]) {
      let sum = 0;
      for (let y = top; y < top + cornerSize; y++) {
        for (let x = left; x < left + cornerSize; x++) sum += pixels[y * width + x];
      }
      corners.push(sum / (cornerSize * cornerSize));
    }
  }
  corners.sort((a, b) => a - b);
  const threshold = Math.max(125, (corners[1] + corners[2]) / 2 + 25);
  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  let largest: { size: number; frame: ReceiptFrame } | null = null;

  for (let start = 0; start < pixels.length; start++) {
    if (visited[start] || pixels[start] < threshold) continue;
    let size = 1;
    let left = width, right = 0, top = height, bottom = 0;
    queue[0] = start;
    visited[start] = 1;
    for (let i = 0; i < size; i++) {
      const index = queue[i];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= pixels.length || visited[neighbor] || pixels[neighbor] < threshold) continue;
        queue[size++] = neighbor;
        visited[neighbor] = 1;
      }
    }
    const frameWidth = right - left + 1;
    const frameHeight = bottom - top + 1;
    const area = frameWidth * frameHeight;
    if (size < pixels.length * 0.12 || size < area * 0.52 || frameWidth < width * 0.23 || frameHeight < height * 0.23) continue;
    if (left < 2 || top < 2 || right >= width - 2 || bottom >= height - 2) continue;
    if (left > width / 2 || right < width / 2 || top > height / 2 || bottom < height / 2) continue;

    // A blank page or an illuminated area without printed detail should not auto-trigger.
    let ink = 0;
    const insetX = Math.ceil(frameWidth * 0.18);
    const insetY = Math.ceil(frameHeight * 0.15);
    const insideWidth = frameWidth - insetX * 2;
    const insideHeight = frameHeight - insetY * 2;
    for (let y = top + insetY; y < top + insetY + insideHeight; y++) {
      for (let x = left + insetX; x < left + insetX + insideWidth; x++) {
        if (pixels[y * width + x] < threshold - 32) ink++;
      }
    }
    const inkRatio = ink / (insideWidth * insideHeight);
    if (inkRatio < 0.018 || inkRatio > 0.5 || (largest && size <= largest.size)) continue;
    largest = {
      size,
      frame: { left: left / width, right: (right + 1) / width, top: top / height, bottom: (bottom + 1) / height },
    };
  }
  return largest?.frame ?? null;
}

export function createReceiptCaptureGate() {
  let previous: ReceiptFrame | null = null;
  let stable = 0;
  let absent = 0;
  let armed = true;
  return {
    observe(frame: ReceiptFrame | null, motion: number) {
      const close = previous && frame &&
        Math.max(Math.abs(frame.left - previous.left), Math.abs(frame.right - previous.right),
          Math.abs(frame.top - previous.top), Math.abs(frame.bottom - previous.bottom)) <= 0.035;
      stable = frame && close && motion <= 6 ? stable + 1 : 0;
      absent = frame ? 0 : absent + 1;
      if (absent >= 3) armed = true;
      previous = frame;
      return { ready: armed && stable >= 5, waitingForRemoval: !armed };
    },
    captured() {
      armed = false;
      stable = 0;
      absent = 0;
    },
  };
}
