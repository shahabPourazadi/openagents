/** Render Mermaid charts / remote images to PNG bytes for DOCX & PDF export. */

export type RasterImage = {
  data: Uint8Array;
  width: number;
  height: number;
  contentType: "image/png";
};

let mermaidSeq = 0;

/** True if a fenced block should be treated as Mermaid. */
export function isMermaidSource(language: string, code: string): boolean {
  const lang = (language || "").toLowerCase();
  if (lang === "mermaid" || lang === "mmd") return true;
  return looksLikeMermaid(normalizeMermaidSource(code));
}

export function normalizeMermaidSource(code: string): string {
  return code
    .trim()
    .replace(/^(diagram|digram)\s*:\s*/i, "")
    .trim();
}

function looksLikeMermaid(code: string): boolean {
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|C4Context)\b/i.test(
    code.trim()
  );
}

function prepareSvg(svg: string): { svg: string; width: number; height: number } {
  let s = svg
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");

  if (!/\sxmlns=/.test(s)) {
    s = s.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  let width = 800;
  let height = 450;
  const vb = s.match(/viewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i);
  if (vb) {
    width = Math.max(1, Number(vb[3]) || width);
    height = Math.max(1, Number(vb[4]) || height);
  } else {
    const wAttr = s.match(/\swidth=["']([\d.]+)/i);
    const hAttr = s.match(/\sheight=["']([\d.]+)/i);
    if (wAttr) width = Math.max(1, Number(wAttr[1]));
    if (hAttr) height = Math.max(1, Number(hAttr[1]));
  }

  // Force explicit pixel size so <img> / canvas get real dimensions.
  if (/\swidth=/.test(s)) {
    s = s.replace(/\swidth=["'][^"']*["']/, ` width="${width}"`);
  } else {
    s = s.replace(/<svg\b/, `<svg width="${width}"`);
  }
  if (/\sheight=/.test(s)) {
    s = s.replace(/\sheight=["'][^"']*["']/, ` height="${height}"`);
  } else {
    s = s.replace(/<svg\b/, `<svg height="${height}"`);
  }

  return { svg: s, width, height };
}

function canvasToPng(
  canvas: HTMLCanvasElement
): Promise<RasterImage | null> {
  return new Promise((resolve) => {
    canvas.toBlob(async (png) => {
      if (!png) {
        resolve(null);
        return;
      }
      resolve({
        data: new Uint8Array(await png.arrayBuffer()),
        width: canvas.width,
        height: canvas.height,
        contentType: "image/png",
      });
    }, "image/png");
  });
}

/** Rasterize via DOM (more reliable than Image()+blob for complex SVGs). */
async function svgToPngViaDom(
  svgMarkup: string,
  maxWidth = 1400
): Promise<RasterImage | null> {
  const { svg, width, height } = prepareSvg(svgMarkup);
  const scale = width > maxWidth ? maxWidth / width : 2; // 2x for retina clarity when small
  const drawScale = width > maxWidth ? maxWidth / width : 1;
  const w = Math.max(1, Math.round(width * drawScale));
  const h = Math.max(1, Math.round(height * drawScale));
  const pixelRatio = Math.min(2, Math.max(1, scale > 1 ? 1 : 2));

  const host = document.createElement("div");
  host.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    "width:" + w + "px",
    "height:" + h + "px",
    "overflow:hidden",
    "background:#ffffff",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  host.innerHTML = svg;
  document.body.appendChild(host);

  const svgEl = host.querySelector("svg");
  if (!svgEl) {
    host.remove();
    return null;
  }
  svgEl.setAttribute("width", String(w));
  svgEl.setAttribute("height", String(h));
  svgEl.style.width = `${w}px`;
  svgEl.style.height = `${h}px`;
  svgEl.style.display = "block";
  svgEl.style.background = "#ffffff";

  // Wait a frame for layout/fonts
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  try {
    const serializer = new XMLSerializer();
    const serialized = serializer.serializeToString(svgEl);
    const prepared = prepareSvg(serialized).svg;
    const dataUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(prepared);

    const img = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * pixelRatio);
    canvas.height = Math.round(h * pixelRatio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.drawImage(img, 0, 0, w, h);
    const png = await canvasToPng(canvas);
    // Report CSS pixel size for layout (not device pixels)
    if (png) {
      return { ...png, width: w, height: h };
    }
    return null;
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

export async function renderMermaidPng(
  chart: string
): Promise<RasterImage | null> {
  const trimmed = normalizeMermaidSource(chart);
  if (!trimmed) return null;

  try {
    // Dynamic import + re-init with SVG text labels (not foreignObject HTML).
    // foreignObject breaks SVG→canvas rasterization in most browsers.
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "Helvetica, Arial, sans-serif",
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
        curve: "basis",
      },
      sequence: { useMaxWidth: false },
      er: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    });

    const ok = await mermaid.parse(trimmed, { suppressErrors: true });
    if (!ok) return null;

    const id = `export-mmd-${Date.now()}-${++mermaidSeq}`;
    const { svg } = await mermaid.render(id, trimmed);
    const png = await svgToPngViaDom(svg);
    return png;
  } catch (err) {
    console.error("Mermaid export render failed:", err);
    return null;
  }
}

export async function fetchImageAsPng(
  src: string,
  maxWidth = 1400,
  /** Pre-resolved URL (e.g. auth blob for diagrams/ assets). */
  resolvedSrc?: string
): Promise<RasterImage | null> {
  try {
    const res = await fetch(resolvedSrc || src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const width = img.naturalWidth || 800;
      const height = img.naturalHeight || 450;
      const scale = width > maxWidth ? maxWidth / width : 1;
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return canvasToPng(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}
