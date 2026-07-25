"use client";

import { useEffect, useId, useRef, useState } from "react";

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

/** Renders a Mermaid diagram inside Typeset/read-only surfaces and BlockNote. */
export function MermaidBlock({ chart }: { chart: string }) {
  const reactId = useId().replace(/:/g, "");
  const renderSeq = useRef(0);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = chart.trim();
    if (!trimmed) {
      setSvg("");
      setError(null);
      return;
    }

    let cancelled = false;
    const seq = ++renderSeq.current;
    const renderId = `mmd-${reactId}-${seq}`;

    void (async () => {
      try {
        const mermaid = await getMermaid();
        const isValid = await mermaid.parse(trimmed, { suppressErrors: true });
        if (!isValid) {
          if (!cancelled) {
            setSvg("");
            setError("Invalid Mermaid syntax");
          }
          return;
        }
        const { svg: rendered } = await mermaid.render(renderId, trimmed);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg("");
          setError(err instanceof Error ? err.message : "Mermaid error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  if (error) {
    return (
      <pre className="not-typeset overflow-x-auto rounded border bg-muted/40 p-2 text-xs text-red-600">
        {error}
        {"\n"}
        {chart}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="not-typeset my-2 text-xs text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="not-typeset my-2 overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
