/**
 * Client-side evidence image optimization.
 *
 * Resizes large photos before upload (max edge 1920px, JPEG/WebP q≈0.82),
 * skipping files that are already small or formats browsers can't decode
 * (HEIC/HEIF pass through untouched). Aspect ratio + EXIF orientation are
 * preserved via createImageBitmap's imageOrientation handling.
 */

export interface OptimizeOptions {
  maxDimension?: number;
  quality?: number;
  /** Below this byte size, skip processing entirely (file goes up as-is). */
  skipBelowBytes?: number;
  /** Force output type; default picks webp when supported else jpeg. */
  mime?: 'image/webp' | 'image/jpeg';
}

export interface OptimizeResult {
  file: File;
  optimized: boolean;
  originalBytes: number;
  resultBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  compressMs: number;
}

const DEFAULTS: Required<Omit<OptimizeOptions, 'mime'>> = {
  maxDimension: 1920,
  quality: 0.82,
  skipBelowBytes: 700 * 1024, // ~0.7MB — smaller than this gains little
};

/** Formats browsers can reliably decode into canvas. HEIC/HEIF cannot —
 *  those files must pass through untouched (backend accepts or rejects). */
const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

let _webpSupported: boolean | null = null;
function webpSupported(): boolean {
  if (_webpSupported === null) {
    try {
      _webpSupported = document
        .createElement('canvas')
        .toDataURL('image/webp')
        .startsWith('data:image/webp');
    } catch {
      _webpSupported = false;
    }
  }
  return _webpSupported;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    // imageOrientation:'from-image' bakes EXIF rotation into the pixels —
    // prevents sideways photos when the browser wouldn't auto-apply it.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // createImageBitmap unavailable/failed — Image tag fallback (browser
    // applies EXIF orientation automatically on <img> decode).
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not decode image'));
      };
      img.src = url;
    });
  }
}

export async function optimizeImage(
  file: File,
  options: OptimizeOptions = {}
): Promise<OptimizeResult> {
  const t0 = performance.now();
  const opts = { ...DEFAULTS, ...options };
  const base: Omit<OptimizeResult, 'compressMs'> = {
    file, optimized: false, originalBytes: file.size, resultBytes: file.size,
  };

  // Never touch non-optimizable formats — HEIC passthrough, other types
  // (PDF/documents if ever enabled) preserve original fidelity.
  if (!OPTIMIZABLE.has(file.type)) {
    return { ...base, compressMs: performance.now() - t0 };
  }
  if (file.size <= opts.skipBelowBytes) {
    return { ...base, compressMs: performance.now() - t0 };
  }

  let bmp: ImageBitmap | HTMLImageElement;
  try {
    bmp = await decode(file);
  } catch {
    return { ...base, compressMs: performance.now() - t0 }; // undecodable → as-is
  }

  const w = 'width' in bmp ? bmp.width : (bmp as HTMLImageElement).naturalWidth;
  const h = 'height' in bmp ? bmp.height : (bmp as HTMLImageElement).naturalHeight;
  if (!w || !h) {
    (bmp as ImageBitmap).close?.();
    return { ...base, compressMs: performance.now() - t0 };
  }

  const scale = Math.min(1, opts.maxDimension / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    (bmp as ImageBitmap).close?.();
    return { ...base, compressMs: performance.now() - t0 };
  }
  // PNG transparency flattens onto white — JPEG/WebP encode can't carry alpha
  // in this path, and evidence photos should not render with black boxes.
  ctx.fillStyle = '#F7F8FA';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(bmp, 0, 0, dw, dh);
  (bmp as ImageBitmap).close?.();

  const outMime = options.mime ?? (webpSupported() ? 'image/webp' : 'image/jpeg');
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outMime, opts.quality)
  );
  if (!blob || blob.size >= file.size) {
    // Recompression made it bigger (already-compressed source) — keep original.
    return { ...base, originalWidth: w, originalHeight: h, compressMs: performance.now() - t0 };
  }

  const ext = outMime === 'image/webp' ? '.webp' : '.jpg';
  const name = file.name.replace(/\.[^.]+$/, '') + ext;
  const outFile = new File([blob], name, {
    type: outMime,
    lastModified: file.lastModified,
  });
  return {
    file: outFile,
    optimized: true,
    originalBytes: file.size,
    resultBytes: outFile.size,
    originalWidth: w,
    originalHeight: h,
    compressMs: performance.now() - t0,
  };
}
