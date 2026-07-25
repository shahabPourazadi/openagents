import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
  type FileChild,
} from "docx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { fetchImageAsPng, isMermaidSource, renderMermaidPng, type RasterImage } from "@/lib/export-images";
import { isWorkspaceAssetPath, resolveWorkspaceMediaUrl } from "@/lib/workspace-media";
import {
  inlinesToPlain,
  parseInline,
  parseMarkdownBlocks,
  slugifyFilename,
  triggerDownload,
  type MdBlock,
  type MdInline,
} from "@/lib/md-blocks";

export type ExportFormat = "md" | "docx" | "pdf";

const PAGE_CONTENT_WIDTH_DXA = 9360; // ~6.5" at 1440 dxa/inch

function inlineRuns(inlines: MdInline[]): (TextRun | ExternalHyperlink)[] {
  return inlines.map((part) => {
    if (part.kind === "link") {
      return new ExternalHyperlink({
        children: [
          new TextRun({
            text: part.text,
            color: "0563C1",
            underline: {},
          }),
        ],
        link: part.href,
      });
    }
    if (part.kind === "bold") {
      return new TextRun({ text: part.text, bold: true });
    }
    if (part.kind === "italic") {
      return new TextRun({ text: part.text, italics: true });
    }
    if (part.kind === "code") {
      return new TextRun({
        text: part.text,
        font: "Courier New",
        size: 18,
      });
    }
    return new TextRun({ text: part.text });
  });
}

function formatMarkdownExport(title: string, contentMd: string): string {
  const body = (contentMd || "").replace(/\r\n/g, "\n").trim();
  const date = new Date().toISOString().slice(0, 10);
  const header = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `exported: ${date}`,
    "format: openagents-document",
    "---",
    "",
    `# ${title}`,
    "",
  ].join("\n");
  const stripped = body.replace(
    new RegExp(`^#\\s+${escapeRegExp(title)}\\s*\\n+`, "i"),
    ""
  );
  return `${header}${stripped}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function thinBorder() {
  return {
    style: BorderStyle.SINGLE,
    size: 4,
    color: "CCCCCC",
  };
}

function cellBorders() {
  const b = thinBorder();
  return { top: b, bottom: b, left: b, right: b };
}

function docxTable(headers: string[], rows: string[][]): Table {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const colWidth = Math.floor(PAGE_CONTENT_WIDTH_DXA / colCount);

  const richCellRuns = (text: string, forceBold = false) => {
    const inlines = parseInline(text);
    if (!inlines.length) {
      return [new TextRun({ text: " ", bold: forceBold, size: 20 })];
    }
    return inlines.map((part) => {
      if (part.kind === "link") {
        return new ExternalHyperlink({
          children: [
            new TextRun({
              text: part.text,
              bold: forceBold || undefined,
              size: 20,
              color: "0563C1",
              underline: {},
            }),
          ],
          link: part.href,
        });
      }
      return new TextRun({
        text: part.text,
        bold: forceBold || part.kind === "bold",
        italics: part.kind === "italic",
        font: part.kind === "code" ? "Courier New" : undefined,
        size: 20,
      });
    });
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: Array.from({ length: colCount }, (_, i) => {
      return new TableCell({
        borders: cellBorders(),
        width: { size: colWidth, type: WidthType.DXA },
        shading: { type: "clear", fill: "F4F4F5" },
        children: [
          new Paragraph({
            children: richCellRuns(headers[i] ?? "", true),
          }),
        ],
      });
    }),
  });

  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: Array.from({ length: colCount }, (_, i) => {
          return new TableCell({
            borders: cellBorders(),
            width: { size: colWidth, type: WidthType.DXA },
            children: [
              new Paragraph({
                children: richCellRuns(row[i] ?? ""),
              }),
            ],
          });
        }),
      })
  );

  return new Table({
    width: { size: PAGE_CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: Array.from({ length: colCount }, () => colWidth),
    rows: [headerRow, ...bodyRows],
  });
}

function docxImageParagraph(image: RasterImage, maxWidthPx = 520): Paragraph {
  const scale = image.width > maxWidthPx ? maxWidthPx / image.width : 1;
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  return new Paragraph({
    spacing: { before: 120, after: 200 },
    children: [
      new ImageRun({
        type: "png",
        data: image.data,
        transformation: { width, height },
        altText: {
          title: "Diagram",
          description: "Exported diagram",
          name: "diagram",
        },
      }),
    ],
  });
}

function codeParagraphs(language: string, code: string): Paragraph[] {
  const label =
    language === "mermaid"
      ? "Mermaid diagram (source)"
      : language
        ? `Code (${language})`
        : "Code";
  const out: Paragraph[] = [
    new Paragraph({
      spacing: { before: 120, after: 60 },
      children: [
        new TextRun({ text: label, bold: true, size: 18, color: "555555" }),
      ],
    }),
  ];
  for (const line of (code || " ").split("\n")) {
    out.push(
      new Paragraph({
        spacing: { after: 0, line: 240 },
        shading: { type: "clear", fill: "F4F4F5" },
        children: [
          new TextRun({
            text: line.length ? line : " ",
            font: "Courier New",
            size: 16,
          }),
        ],
      })
    );
  }
  out.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
  return out;
}

async function resolveBlockAssets(
  blocks: MdBlock[],
  workspaceId?: string | null
) {
  const mermaid = new Map<number, RasterImage>();
  const images = new Map<number, RasterImage>();

  await Promise.all(
    blocks.map(async (block, idx) => {
      if (block.type === "code" && isMermaidSource(block.language, block.code)) {
        const png = await renderMermaidPng(block.code);
        if (png) mermaid.set(idx, png);
      }
      if (block.type === "image") {
        let resolved: string | undefined;
        if (workspaceId && isWorkspaceAssetPath(block.src)) {
          try {
            resolved = await resolveWorkspaceMediaUrl(block.src, workspaceId);
          } catch {
            resolved = undefined;
          }
        }
        const png = await fetchImageAsPng(block.src, 1400, resolved);
        if (resolved?.startsWith("blob:")) URL.revokeObjectURL(resolved);
        if (png) images.set(idx, png);
      }
    })
  );

  return { mermaid, images };
}

async function exportMarkdown(title: string, contentMd: string) {
  const text = formatMarkdownExport(title, contentMd);
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, `${slugifyFilename(title)}.md`);
}

async function exportDocx(
  title: string,
  contentMd: string,
  workspaceId?: string | null
) {
  const blocks = parseMarkdownBlocks(contentMd);
  const assets = await resolveBlockAssets(blocks, workspaceId);
  const children: FileChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
      children: [new TextRun({ text: title, bold: true, size: 36 })],
    }),
    new Paragraph({
      spacing: { after: 360 },
      children: [
        new TextRun({
          text: `Exported ${new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}`,
          italics: true,
          size: 18,
          color: "666666",
        }),
      ],
    }),
  ];

  const headingMap = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
  } as const;

  blocks.forEach((block, idx) => {
    if (block.type === "heading") {
      children.push(
        new Paragraph({
          heading: headingMap[block.level],
          spacing: { before: block.level === 1 ? 320 : 240, after: 120 },
          children: inlineRuns(block.inlines),
        })
      );
      return;
    }

    if (block.type === "paragraph") {
      children.push(
        new Paragraph({
          spacing: { after: 160, line: 276 },
          children: inlineRuns(block.inlines),
        })
      );
      return;
    }

    if (block.type === "blockquote") {
      children.push(
        new Paragraph({
          spacing: { after: 160 },
          indent: { left: convertInchesToTwip(0.25) },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: 12,
              color: "999999",
              space: 8,
            },
          },
          children: inlineRuns(block.inlines),
        })
      );
      return;
    }

    if (block.type === "list") {
      block.items.forEach((item, itemIdx) => {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.25) },
            children: [
              new TextRun({
                text: block.ordered ? `${itemIdx + 1}. ` : "• ",
              }),
              ...inlineRuns(item),
            ],
          })
        );
      });
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
      return;
    }

    if (block.type === "table") {
      children.push(docxTable(block.headers, block.rows));
      children.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
      return;
    }

    if (block.type === "image") {
      const png = assets.images.get(idx);
      if (png) {
        children.push(docxImageParagraph(png));
      } else {
        children.push(
          new Paragraph({
            spacing: { after: 160 },
            children: [
              new TextRun({
                text: `[Image: ${block.alt || block.src}]`,
                italics: true,
                color: "666666",
              }),
            ],
          })
        );
      }
      return;
    }

    if (block.type === "code") {
      if (isMermaidSource(block.language, block.code)) {
        const png = assets.mermaid.get(idx);
        if (png) {
          children.push(docxImageParagraph(png));
          return;
        }
      }
      children.push(...codeParagraphs(block.language, block.code));
      return;
    }

    if (block.type === "hr") {
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 200 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: "CCCCCC",
              space: 1,
            },
          },
          children: [],
        })
      );
    }
  });

  const doc = new Document({
    creator: "OpenAgents",
    title,
    description: "Document exported from OpenAgents",
    styles: {
      default: {
        document: {
          paragraph: { spacing: { line: 276 } },
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
            },
          },
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, `${slugifyFilename(title)}.docx`);
}

async function exportPdf(
  title: string,
  contentMd: string,
  workspaceId?: string | null
) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeWrapped = (
    text: string,
    opts: {
      font?: "helvetica" | "times" | "courier";
      style?: "normal" | "bold" | "italic" | "bolditalic";
      size?: number;
      color?: [number, number, number];
      indent?: number;
      lineGap?: number;
      after?: number;
    } = {}
  ) => {
    const font = opts.font ?? "helvetica";
    const style = opts.style ?? "normal";
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    const lineGap = opts.lineGap ?? size * 0.35;
    const after = opts.after ?? 8;
    doc.setFont(font, style);
    doc.setFontSize(size);
    if (opts.color) doc.setTextColor(...opts.color);
    else doc.setTextColor(30, 30, 30);

    const lines = doc.splitTextToSize(text || " ", maxWidth - indent) as string[];
    for (const line of lines) {
      ensureSpace(size + lineGap);
      doc.text(line, margin + indent, y);
      y += size + lineGap;
    }
    y += after;
  };

  const drawRaster = (image: RasterImage) => {
    const maxW = maxWidth;
    const scale = image.width > maxW ? maxW / image.width : 1;
    const w = image.width * scale;
    const h = image.height * scale;
    ensureSpace(h + 16);
    const dataUrl = `data:image/png;base64,${uint8ToBase64(image.data)}`;
    doc.addImage(dataUrl, "PNG", margin, y, w, h);
    y += h + 14;
  };

  const drawCodeBlock = (language: string, code: string) => {
    const label =
      language === "mermaid"
        ? "Mermaid diagram (source)"
        : language
          ? `Code (${language})`
          : "Code";
    writeWrapped(label, {
      style: "bold",
      size: 9,
      color: [90, 90, 90],
      after: 4,
    });
    const codeLines = doc.splitTextToSize(code || " ", maxWidth - 16) as string[];
    ensureSpace(Math.min(codeLines.length * 11 + 16, pageHeight - margin * 2));
    const startY = y - 2;
    doc.setFillColor(245, 245, 247);
    doc.roundedRect(margin, startY, maxWidth, codeLines.length * 11 + 12, 3, 3, "F");
    y = startY + 12;
    doc.setFont("courier", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(40, 40, 40);
    for (const line of codeLines) {
      ensureSpace(11);
      doc.text(line, margin + 8, y);
      y += 11;
    }
    y += 12;
  };

  const writeRich = (
    inlines: MdInline[],
    opts: { size?: number; after?: number; indent?: number } = {}
  ) => {
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    const after = opts.after ?? 10;
    const parts =
      inlines.length > 0 ? inlines : [{ kind: "text" as const, text: "" }];

    // Measure as plain for wrapping, then draw segment-by-segment on one line flow.
    // For simplicity with wrapping: flatten to styled chunks and walk with jsPDF.
    type Chunk = { text: string; style: "normal" | "bold" | "italic" | "bolditalic" };
    const chunks: Chunk[] = parts.map((p) => {
      if (p.kind === "bold") return { text: p.text, style: "bold" };
      if (p.kind === "italic") return { text: p.text, style: "italic" };
      if (p.kind === "link") return { text: `${p.text}`, style: "normal" };
      if (p.kind === "code") return { text: p.text, style: "normal" };
      return { text: p.text, style: "normal" };
    });

    let x = margin + indent;
    const maxX = margin + maxWidth;
    const lineHeight = size + size * 0.35;

    ensureSpace(lineHeight);
    doc.setTextColor(30, 30, 30);

    const newLine = () => {
      y += lineHeight;
      x = margin + indent;
      ensureSpace(lineHeight);
    };

    for (const chunk of chunks) {
      doc.setFont("helvetica", chunk.style);
      doc.setFontSize(size);
      const words = chunk.text.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;
        const w = doc.getTextWidth(word);
        if (x + w > maxX && x > margin + indent) newLine();
        if (w > maxWidth - indent) {
          const lines = doc.splitTextToSize(word, maxWidth - indent) as string[];
          for (let li = 0; li < lines.length; li += 1) {
            if (li > 0) newLine();
            doc.text(lines[li], x, y);
            x += doc.getTextWidth(lines[li]);
          }
          continue;
        }
        doc.text(word, x, y);
        x += w;
      }
    }
    y += lineHeight + after;
  };

  writeWrapped(title, { style: "bold", size: 20, after: 6 });
  writeWrapped(
    `Exported ${new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    })}`,
    { style: "italic", size: 9, color: [100, 100, 100], after: 18 }
  );

  ensureSpace(12);
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.8);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  const blocks = parseMarkdownBlocks(contentMd);
  const assets = await resolveBlockAssets(blocks, workspaceId);

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx];

    if (block.type === "heading") {
      const sizes = { 1: 16, 2: 14, 3: 12, 4: 11 } as const;
      y += block.level <= 2 ? 8 : 4;
      writeWrapped(inlinesToPlain(block.inlines), {
        style: "bold",
        size: sizes[block.level],
        after: 6,
      });
      continue;
    }

    if (block.type === "paragraph") {
      writeRich(block.inlines, { size: 11, after: 10 });
      continue;
    }

    if (block.type === "blockquote") {
      writeWrapped(inlinesToPlain(block.inlines), {
        style: "italic",
        size: 10,
        color: [80, 80, 80],
        indent: 14,
        after: 10,
      });
      continue;
    }

    if (block.type === "list") {
      block.items.forEach((item, itemIdx) => {
        const bullet = block.ordered ? `${itemIdx + 1}. ` : "•  ";
        writeRich(
          [{ kind: "text", text: bullet }, ...item],
          { size: 11, after: 4, indent: 12 }
        );
      });
      y += 6;
      continue;
    }

    if (block.type === "table") {
      ensureSpace(40);
      const formatCell = (raw: string) => {
        const inlines = parseInline(raw);
        const plain = inlinesToPlain(inlines);
        const meaningful = inlines.filter(
          (p) => !(p.kind === "text" && !p.text.trim())
        );
        const allBold =
          meaningful.length > 0 && meaningful.every((p) => p.kind === "bold");
        const allItalic =
          meaningful.length > 0 && meaningful.every((p) => p.kind === "italic");
        return {
          text: plain,
          bold: allBold,
          italic: allItalic,
        };
      };

      autoTable(doc, {
        startY: y,
        head: [block.headers.map((h) => formatCell(h).text)],
        body: block.rows.map((row) => row.map((c) => formatCell(c).text)),
        margin: { left: margin, right: margin },
        styles: {
          font: "helvetica",
          fontSize: 9,
          cellPadding: 4,
          overflow: "linebreak",
          valign: "middle",
        },
        headStyles: {
          fillColor: [244, 244, 245],
          textColor: [30, 30, 30],
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [252, 252, 253] },
        theme: "grid",
        didParseCell: (data) => {
          if (data.section === "head") return;
          const raw =
            block.rows[data.row.index]?.[data.column.index] ??
            String(data.cell.raw ?? "");
          const fmt = formatCell(raw);
          data.cell.text = [fmt.text];
          if (fmt.bold && fmt.italic) data.cell.styles.fontStyle = "bolditalic";
          else if (fmt.bold) data.cell.styles.fontStyle = "bold";
          else if (fmt.italic) data.cell.styles.fontStyle = "italic";
        },
      });
      const last = (
        doc as unknown as { lastAutoTable?: { finalY: number } }
      ).lastAutoTable;
      y = (last?.finalY ?? y) + 14;
      continue;
    }

    if (block.type === "image") {
      const png = assets.images.get(idx);
      if (png) drawRaster(png);
      else {
        writeWrapped(`[Image: ${block.alt || block.src}]`, {
          style: "italic",
          size: 10,
          color: [100, 100, 100],
        });
      }
      continue;
    }

    if (block.type === "code") {
      if (isMermaidSource(block.language, block.code)) {
        const png = assets.mermaid.get(idx);
        if (png) {
          drawRaster(png);
          continue;
        }
      }
      drawCodeBlock(block.language, block.code);
      continue;
    }

    if (block.type === "hr") {
      ensureSpace(16);
      y += 4;
      doc.setDrawColor(210, 210, 210);
      doc.line(margin, y, pageWidth - margin, y);
      y += 14;
    }
  }

  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(`${p} / ${total}`, pageWidth / 2, pageHeight - 28, {
      align: "center",
    });
    doc.text("OpenAgents", margin, pageHeight - 28);
  }

  doc.save(`${slugifyFilename(title)}.pdf`);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function exportDocument(
  format: ExportFormat,
  title: string,
  contentMd: string,
  workspaceId?: string | null
): Promise<void> {
  if (format === "md") return exportMarkdown(title, contentMd);
  if (format === "docx") return exportDocx(title, contentMd, workspaceId);
  return exportPdf(title, contentMd, workspaceId);
}
