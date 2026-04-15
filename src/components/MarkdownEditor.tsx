import { useEffect, useMemo, useState } from "react";
import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { lintGutter, type Diagnostic, linter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";

export type Annotation = {
  line: number; // 1-based
  message: string;
  agent?: string;
  severity?: "info" | "warn" | "error";
};

type Props = {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  annotations?: Annotation[];
  placeholder?: string;
};

export default function MarkdownEditor({
  value,
  onChange,
  readOnly,
  annotations,
  placeholder,
}: Props) {
  // `@uiw/react-codemirror` handles lifecycle; we keep extensions stable.
  const lintExtensions = useMemo(() => {
    const toSeverity = (s?: Annotation["severity"]): Diagnostic["severity"] => {
      if (s === "error") return "error";
      if (s === "warn") return "warning";
      return "info";
    };

    const diagFor = (view: EditorView): Diagnostic[] => {
      const anns = annotations ?? [];
      if (!anns.length) return [];

      const docs: Diagnostic[] = [];
      for (const a of anns) {
        const line = Math.max(1, Math.floor(a.line || 1));
        if (line > view.state.doc.lines) continue;
        const ln = view.state.doc.line(line);
        const header = a.agent ? `[${a.agent}] ` : "";
        docs.push({
          from: ln.from,
          to: ln.to,
          severity: toSeverity(a.severity),
          message: `${header}${a.message}`,
        });
      }
      return docs;
    };

    // Recreate when annotations change so the closure is fresh.
    return [lintGutter(), linter(diagFor)] as const;
  }, [annotations]);

  const extensions = useMemo(() => [markdown(), ...lintExtensions], [lintExtensions]);

  // Dark theme is more consistent with the terminals.
  const theme = useMemo(() => oneDark, []);

  const [localValue, setLocalValue] = useState(value);
  useEffect(() => setLocalValue(value), [value]);

  const cmProps: ReactCodeMirrorProps = {
    value: localValue,
    height: "100%",
    theme,
    extensions,
    basicSetup: {
      lineNumbers: true,
      highlightActiveLine: true,
      foldGutter: true,
      autocompletion: false,
    },
    editable: !readOnly,
    placeholder,
    onChange: (v) => {
      setLocalValue(v);
      onChange?.(v);
    },
  };

  // Phase 3: annotations are shown as gutter markers (lint gutter).
  return (
    <div className="h-full min-h-0">
        <CodeMirror {...cmProps} />
    </div>
  );
}
