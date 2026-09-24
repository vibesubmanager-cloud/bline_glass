export async function compressPhoto(file, { maxSide = 1280, quality = 0.72 } = {}) {
  if (!file) return file;
  const type = String(file.type || "").toLowerCase();
  if (!type.startsWith("image/")) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => {
    canvas.toBlob((next) => resolve(next), "image/jpeg", quality);
  });
  if (!blob) return file;
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}
