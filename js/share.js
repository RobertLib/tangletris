/* ==========================================================================
   Sharing a result: a picture of the board in its world with the score on
   it, the text, and a link that deals the same pieces to whoever opens it.

   The picture is taken from the WebGL canvas right after a frame is drawn
   (the drawing buffer is not preserved, so it has to be the same task) and
   finished as a PNG before anyone presses Share — Safari only lets a share
   sheet open straight from the click, with no waiting in between.
   ========================================================================== */

const CARD_W = 1080;
const FOOTER_H = 250;

// Copies the part of the canvas around the board. Call straight after a
// render, in the same task.
export function captureFrame(gl, boardRect) {
  try {
    const vw = gl.clientWidth;
    const vh = gl.clientHeight;
    if (!vw || !vh || !gl.width) return null;
    const scale = gl.width / vw;
    // A square around the board where the screen allows it, so the world
    // shows on either side; on a narrow phone, as wide as the screen.
    let h = Math.min(vh, boardRect.height * 1.08);
    let w = Math.min(vw, h);
    const cx = boardRect.left + boardRect.width / 2;
    const cy = boardRect.top + boardRect.height / 2;
    let x = Math.max(0, Math.min(vw - w, cx - w / 2));
    let y = Math.max(0, Math.min(vh - h, cy - h / 2));
    const out = document.createElement("canvas");
    out.width = CARD_W;
    out.height = Math.round((CARD_W * h) / w);
    out.getContext("2d").drawImage(gl, x * scale, y * scale, w * scale, h * scale, 0, 0, out.width, out.height);
    return out;
  } catch (e) {
    return null;
  }
}

// info: { title, big, small, url, accent, accent2, text, dim, bg }
export function buildCard(frame, info) {
  const imgH = frame ? frame.height : 900;
  const c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = imgH + FOOTER_H;
  const g = c.getContext("2d");

  g.fillStyle = info.bg;
  g.fillRect(0, 0, c.width, c.height);
  if (frame) g.drawImage(frame, 0, 0);
  else {
    const grad = g.createLinearGradient(0, 0, 0, imgH);
    grad.addColorStop(0, info.accent2);
    grad.addColorStop(1, info.bg);
    g.fillStyle = grad;
    g.fillRect(0, 0, CARD_W, imgH);
  }

  // Fade the picture into the footer.
  const fade = g.createLinearGradient(0, imgH - 220, 0, imgH);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, info.bg);
  g.fillStyle = fade;
  g.fillRect(0, imgH - 220, CARD_W, 220);

  const pad = 64;
  const display = '"Press Start 2P", "Courier New", monospace';
  const body = '"Space Grotesk", system-ui, sans-serif';
  const top = imgH - 40;

  // Logo, two-tone like the page header.
  g.textBaseline = "alphabetic";
  g.font = "44px " + display;
  g.fillStyle = info.text;
  g.textAlign = "left";
  g.fillText("TANGLE", pad, top + 70);
  const wTangle = g.measureText("TANGLE").width;
  g.fillStyle = info.accent;
  g.shadowColor = info.accent;
  g.shadowBlur = 24;
  g.fillText("TRIS", pad + wTangle, top + 70);
  const wLogo = wTangle + g.measureText("TRIS").width;
  g.shadowBlur = 0;

  g.font = "600 34px " + body;
  g.fillStyle = info.dim;
  g.fillText(info.title, pad, top + 128);

  g.font = "500 30px " + body;
  g.fillText(info.url, pad, top + 196);

  // The result, right-aligned. A seven-figure score at full size would run
  // into the logo on the same line, so long ones shrink to fit beside it.
  g.textAlign = "right";
  const room = CARD_W - pad * 2 - wLogo - 36;
  let size = 64;
  g.font = size + "px " + display;
  while (size > 28 && g.measureText(info.big).width > room) {
    size -= 2;
    g.font = size + "px " + display;
  }
  g.fillStyle = info.text;
  g.shadowColor = info.accent2;
  g.shadowBlur = 30;
  g.fillText(info.big, CARD_W - pad, top + 82);
  g.shadowBlur = 0;
  g.font = "600 32px " + body;
  g.fillStyle = info.dim;
  g.fillText(info.small, CARD_W - pad, top + 136);
  g.font = "700 32px " + body;
  g.fillStyle = info.accent;
  g.fillText(info.cta, CARD_W - pad, top + 196);

  return c;
}

export function cardToBlob(card) {
  return new Promise((resolve) => {
    try {
      card.toBlob((b) => resolve(b), "image/png");
    } catch (e) {
      resolve(null);
    }
  });
}

// Resolves "shared", "copied", "cancelled" or "failed". Must be called from
// the click itself.
export async function shareResult(text, url, blob) {
  if (navigator.share) {
    const data = { text: text, url: url };
    if (blob) {
      const file = new File([blob], "tangletris.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
    }
    try {
      await navigator.share(data);
      return "shared";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
      // Some browsers refuse files they said they could take; text alone
      // may still go through — but the click's permission is spent, so fall
      // back to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(text + "\n" + url);
    return "copied";
  } catch (e) {
    return "failed";
  }
}
