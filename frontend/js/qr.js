const ID_RE = /AIS-[A-Z0-9]{6}/i;

export function extractSystemId(text) {
  const match = String(text || "").toUpperCase().match(ID_RE);
  return match ? match[0] : "";
}

export async function startQrScan(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This phone cannot open the camera to scan a code.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play();
  if (!("BarcodeDetector" in window)) {
    return {
      supported: false,
      stop() {
        stream.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      },
    };
  }
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  let running = true;
  const tick = async () => {
    if (!running) return;
    try {
      const codes = await detector.detect(video);
      const value = extractSystemId(codes[0]?.rawValue);
      if (value) {
        onCode(value);
        stop();
        return;
      }
    } catch {
      /* keep scanning */
    }
    requestAnimationFrame(tick);
  };
  tick();
  function stop() {
    running = false;
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  return { supported: true, stop };
}

export async function readQrFromFile(file) {
  if (!file) return "";
  if (!("BarcodeDetector" in window)) {
    throw new Error("This browser cannot read QR photos. Type the system ID instead.");
  }
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const bitmap = await createImageBitmap(file);
  const codes = await detector.detect(bitmap);
  bitmap.close?.();
  return extractSystemId(codes[0]?.rawValue);
}

export function drawSystemQr(canvas, systemId) {
  if (!canvas || !systemId) return;
  const lib = window.QRCode;
  if (!lib?.toCanvas) {
    const img = document.createElement("img");
    img.alt = `QR code for ${systemId}`;
    img.width = 240;
    img.height = 240;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(systemId)}`;
    canvas.replaceWith(img);
    return;
  }
  lib.toCanvas(canvas, systemId, { width: 240, margin: 1, color: { dark: "#041018", light: "#f4fbff" } });
}
