"use client";

import type { LucideIcon } from "lucide-react";
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
  PencilRuler,
  Table2,
} from "lucide-react";

export type FileFormatStyle = {
  /** Short label under the name (e.g. PDF, PNG). */
  label: string;
  Icon: LucideIcon;
  /** Chip border/bg/text colors. */
  chip: string;
  /** Icon tile background. */
  iconTile: string;
};

const SKILL_STYLE: FileFormatStyle = {
  label: "skill",
  Icon: PencilRuler,
  chip: "border-emerald-500/35 bg-emerald-500/10 text-emerald-950 hover:bg-emerald-500/15 dark:text-emerald-200",
  iconTile: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
};

const DOCUMENT_STYLE: FileFormatStyle = {
  label: "document",
  Icon: FileText,
  chip: "border-sky-500/35 bg-sky-500/10 text-sky-950 hover:bg-sky-500/15 dark:text-sky-200",
  iconTile: "bg-sky-500/20 text-sky-700 dark:text-sky-300",
};

const DEFAULT_FILE_STYLE: FileFormatStyle = {
  label: "file",
  Icon: File,
  chip: "border-slate-500/35 bg-slate-500/10 text-slate-950 hover:bg-slate-500/15 dark:text-slate-200",
  iconTile: "bg-slate-500/20 text-slate-700 dark:text-slate-300",
};

/** Extension → visual treatment for uploads / workspace files. */
const BY_EXT: Record<string, FileFormatStyle> = {
  pdf: {
    label: "PDF",
    Icon: FileType2,
    chip: "border-red-500/35 bg-red-500/10 text-red-950 hover:bg-red-500/15 dark:text-red-200",
    iconTile: "bg-red-500/20 text-red-700 dark:text-red-300",
  },
  doc: {
    label: "DOC",
    Icon: FileText,
    chip: "border-blue-500/35 bg-blue-500/10 text-blue-950 hover:bg-blue-500/15 dark:text-blue-200",
    iconTile: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  },
  docx: {
    label: "DOCX",
    Icon: FileText,
    chip: "border-blue-500/35 bg-blue-500/10 text-blue-950 hover:bg-blue-500/15 dark:text-blue-200",
    iconTile: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  },
  odt: {
    label: "ODT",
    Icon: FileText,
    chip: "border-blue-500/35 bg-blue-500/10 text-blue-950 hover:bg-blue-500/15 dark:text-blue-200",
    iconTile: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  },
  xls: {
    label: "XLS",
    Icon: FileSpreadsheet,
    chip: "border-green-600/35 bg-green-600/10 text-green-950 hover:bg-green-600/15 dark:text-green-200",
    iconTile: "bg-green-600/20 text-green-700 dark:text-green-300",
  },
  xlsx: {
    label: "XLSX",
    Icon: FileSpreadsheet,
    chip: "border-green-600/35 bg-green-600/10 text-green-950 hover:bg-green-600/15 dark:text-green-200",
    iconTile: "bg-green-600/20 text-green-700 dark:text-green-300",
  },
  ods: {
    label: "ODS",
    Icon: FileSpreadsheet,
    chip: "border-green-600/35 bg-green-600/10 text-green-950 hover:bg-green-600/15 dark:text-green-200",
    iconTile: "bg-green-600/20 text-green-700 dark:text-green-300",
  },
  csv: {
    label: "CSV",
    Icon: Table2,
    chip: "border-teal-600/35 bg-teal-600/10 text-teal-950 hover:bg-teal-600/15 dark:text-teal-200",
    iconTile: "bg-teal-600/20 text-teal-700 dark:text-teal-300",
  },
  ppt: {
    label: "PPT",
    Icon: Presentation,
    chip: "border-orange-500/35 bg-orange-500/10 text-orange-950 hover:bg-orange-500/15 dark:text-orange-200",
    iconTile: "bg-orange-500/20 text-orange-700 dark:text-orange-300",
  },
  pptx: {
    label: "PPTX",
    Icon: Presentation,
    chip: "border-orange-500/35 bg-orange-500/10 text-orange-950 hover:bg-orange-500/15 dark:text-orange-200",
    iconTile: "bg-orange-500/20 text-orange-700 dark:text-orange-300",
  },
  odp: {
    label: "ODP",
    Icon: Presentation,
    chip: "border-orange-500/35 bg-orange-500/10 text-orange-950 hover:bg-orange-500/15 dark:text-orange-200",
    iconTile: "bg-orange-500/20 text-orange-700 dark:text-orange-300",
  },
  png: {
    label: "PNG",
    Icon: FileImage,
    chip: "border-fuchsia-500/35 bg-fuchsia-500/10 text-fuchsia-950 hover:bg-fuchsia-500/15 dark:text-fuchsia-200",
    iconTile: "bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300",
  },
  jpg: {
    label: "JPG",
    Icon: FileImage,
    chip: "border-pink-500/35 bg-pink-500/10 text-pink-950 hover:bg-pink-500/15 dark:text-pink-200",
    iconTile: "bg-pink-500/20 text-pink-700 dark:text-pink-300",
  },
  jpeg: {
    label: "JPEG",
    Icon: FileImage,
    chip: "border-pink-500/35 bg-pink-500/10 text-pink-950 hover:bg-pink-500/15 dark:text-pink-200",
    iconTile: "bg-pink-500/20 text-pink-700 dark:text-pink-300",
  },
  gif: {
    label: "GIF",
    Icon: FileImage,
    chip: "border-rose-500/35 bg-rose-500/10 text-rose-950 hover:bg-rose-500/15 dark:text-rose-200",
    iconTile: "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  },
  webp: {
    label: "WEBP",
    Icon: FileImage,
    chip: "border-violet-500/35 bg-violet-500/10 text-violet-950 hover:bg-violet-500/15 dark:text-violet-200",
    iconTile: "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  },
  bmp: {
    label: "BMP",
    Icon: FileImage,
    chip: "border-purple-500/35 bg-purple-500/10 text-purple-950 hover:bg-purple-500/15 dark:text-purple-200",
    iconTile: "bg-purple-500/20 text-purple-700 dark:text-purple-300",
  },
  tif: {
    label: "TIF",
    Icon: FileImage,
    chip: "border-indigo-500/35 bg-indigo-500/10 text-indigo-950 hover:bg-indigo-500/15 dark:text-indigo-200",
    iconTile: "bg-indigo-500/20 text-indigo-700 dark:text-indigo-300",
  },
  tiff: {
    label: "TIFF",
    Icon: FileImage,
    chip: "border-indigo-500/35 bg-indigo-500/10 text-indigo-950 hover:bg-indigo-500/15 dark:text-indigo-200",
    iconTile: "bg-indigo-500/20 text-indigo-700 dark:text-indigo-300",
  },
  md: {
    label: "MD",
    Icon: FileCode2,
    chip: "border-cyan-600/35 bg-cyan-600/10 text-cyan-950 hover:bg-cyan-600/15 dark:text-cyan-200",
    iconTile: "bg-cyan-600/20 text-cyan-700 dark:text-cyan-300",
  },
  markdown: {
    label: "MD",
    Icon: FileCode2,
    chip: "border-cyan-600/35 bg-cyan-600/10 text-cyan-950 hover:bg-cyan-600/15 dark:text-cyan-200",
    iconTile: "bg-cyan-600/20 text-cyan-700 dark:text-cyan-300",
  },
  txt: {
    label: "TXT",
    Icon: FileText,
    chip: "border-stone-500/35 bg-stone-500/10 text-stone-950 hover:bg-stone-500/15 dark:text-stone-200",
    iconTile: "bg-stone-500/20 text-stone-700 dark:text-stone-300",
  },
  zip: {
    label: "ZIP",
    Icon: FileArchive,
    chip: "border-amber-600/35 bg-amber-600/10 text-amber-950 hover:bg-amber-600/15 dark:text-amber-200",
    iconTile: "bg-amber-600/20 text-amber-700 dark:text-amber-300",
  },
};

export function fileExt(pathOrLabel: string): string {
  const base = pathOrLabel.split("/").pop() || pathOrLabel;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function formatStyleForChip(chip: {
  kind: "document" | "file" | "skill" | "upload";
  label: string;
  path?: string;
  icon?: string;
}): FileFormatStyle {
  if (chip.kind === "skill") {
    // Icon component is resolved at render via skillIconComponent(chip.icon);
    // keep emerald skill chrome here.
    return SKILL_STYLE;
  }
  if (chip.kind === "document") return DOCUMENT_STYLE;
  const ext = fileExt(chip.path || chip.label);
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  if (chip.kind === "file") {
    return {
      ...DEFAULT_FILE_STYLE,
      label: "file",
      chip: "border-amber-500/35 bg-amber-500/10 text-amber-950 hover:bg-amber-500/15 dark:text-amber-200",
      iconTile: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
    };
  }
  return DEFAULT_FILE_STYLE;
}
