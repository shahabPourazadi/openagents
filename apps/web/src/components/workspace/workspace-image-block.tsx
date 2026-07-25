"use client";

import { createImageBlockConfig, imageParse } from "@blocknote/core";
import {
  createReactBlockSpec,
  FigureWithCaption,
  LinkWithCaption,
  ResizableFileBlockWrapper,
} from "@blocknote/react";
import { ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/app-state";
import {
  isMissingAssetPlaceholder,
  isWorkspaceAssetPath,
  resolveWorkspaceMediaUrl,
} from "@/lib/workspace-media";

type ImageBlockProps = {
  block: {
    id: string;
    props: {
      url: string;
      name: string;
      caption: string;
      showPreview: boolean;
      previewWidth?: number;
    };
  };
  editor: unknown;
};

/**
 * Resolves workspace asset images and re-fetches when the assets list changes
 * (e.g. after the agent persists a diagram) or when the user clicks a missing
 * placeholder — without mutating the markdown URL.
 */
function WorkspaceImagePreview(props: ImageBlockProps) {
  const { workspace, workspaceAssets } = useApp();
  const url = props.block.props.url || "";
  const workspaceId = workspace?.id ?? null;
  const assetKey = workspaceAssets.map((a) => a.path).sort().join("\0");

  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const resolved = await resolveWorkspaceMediaUrl(url, workspaceId);
        if (cancelled) return;
        if (blobRef.current?.startsWith("blob:")) {
          URL.revokeObjectURL(blobRef.current);
        }
        blobRef.current = resolved.startsWith("blob:") ? resolved : null;
        setDownloadUrl(resolved);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, workspaceId, assetKey, retry]);

  useEffect(() => {
    return () => {
      if (blobRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(blobRef.current);
      }
    };
  }, []);

  const alt = props.block.props.name || "";
  const src = loading && !downloadUrl ? url : downloadUrl || url;
  const missing = Boolean(downloadUrl && isMissingAssetPlaceholder(downloadUrl));
  const canRetry =
    missing && (isWorkspaceAssetPath(url) || Boolean(url.trim()));

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="bn-visual-media"
      src={src}
      alt={alt}
      width={props.block.props.previewWidth}
      contentEditable={false}
      draggable={false}
      title={canRetry ? "Click to reload image" : undefined}
      style={canRetry ? { cursor: "pointer" } : undefined}
      onClick={
        canRetry
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setRetry((n) => n + 1);
            }
          : undefined
      }
    />
  );
}

function ImageToExternalHTML(props: ImageBlockProps) {
  if (!props.block.props.url) {
    return <p>Add image</p>;
  }

  const alt = props.block.props.name || "";
  const image = props.block.props.showPreview ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.block.props.url}
      alt={alt}
      width={props.block.props.previewWidth}
    />
  ) : (
    <a href={props.block.props.url}>
      {props.block.props.name || props.block.props.url}
    </a>
  );

  if (props.block.props.caption) {
    return props.block.props.showPreview ? (
      <FigureWithCaption caption={props.block.props.caption}>
        {image}
      </FigureWithCaption>
    ) : (
      <LinkWithCaption caption={props.block.props.caption}>
        {image}
      </LinkWithCaption>
    );
  }

  return image;
}

function WorkspaceImageBlock(props: ImageBlockProps) {
  return (
    <ResizableFileBlockWrapper
      {...(props as Parameters<typeof ResizableFileBlockWrapper>[0])}
      buttonIcon={<ImageIcon size={24} />}
    >
      <WorkspaceImagePreview {...props} />
    </ResizableFileBlockWrapper>
  );
}

// BlockNote's createImageBlockConfig overload confuses createReactBlockSpec's
// generics; runtime shape matches ReactImageBlock.
const createWorkspaceImageBlockInner = (
  createReactBlockSpec as (config: unknown, impl: unknown) => () => unknown
)(createImageBlockConfig, (config: unknown) => ({
  meta: {
    fileBlockAccept: ["image/*"],
  },
  render: WorkspaceImageBlock,
  parse: imageParse(config as never),
  toExternalHTML: ImageToExternalHTML,
  runsBefore: ["file"],
}));

/** Drop-in replacement for BlockNote's default image block. */
export function createWorkspaceImageBlock() {
  return createWorkspaceImageBlockInner() as ReturnType<
    typeof createWorkspaceImageBlockInner
  >;
}
