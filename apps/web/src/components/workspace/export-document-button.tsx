"use client";

import { useState } from "react";
import { Download, FileText, FileType2, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportDocument, type ExportFormat } from "@/lib/export-document";
import { useApp } from "@/lib/app-state";

type Props = {
  title: string;
  contentMd: string;
};

const OPTIONS: {
  format: ExportFormat;
  label: string;
  icon: typeof FileText;
}[] = [
  { format: "md", label: "Markdown (.md)", icon: FileText },
  { format: "docx", label: "Word (.docx)", icon: FileType2 },
  { format: "pdf", label: "PDF (.pdf)", icon: FileText },
];

export function ExportDocumentButton({ title, contentMd }: Props) {
  const { workspace } = useApp();
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const onExport = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      await exportDocument(format, title, contentMd, workspace?.id);
    } catch (err) {
      console.error("Export failed:", err);
      window.alert(
        err instanceof Error ? `Export failed: ${err.message}` : "Export failed."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
        aria-label="Export document"
        title="Export"
        disabled={!!busy}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export as</DropdownMenuLabel>
          {OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.format}
              disabled={!!busy}
              onClick={() => void onExport(opt.format)}
            >
              <opt.icon className="size-3.5 shrink-0" />
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
