import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";

/** React Email components, for autocomplete. */
const EMAIL_COMPONENTS = ["Html", "Head", "Body", "Preview", "Container", "Section", "Row", "Column", "Heading", "Text", "Link", "Button", "Img", "Hr", "Font", "Tailwind", "Markdown", "CodeBlock", "CodeInline"];

/**
 * A TSX editor (CodeMirror 6, loaded on first use so other pages don't pay for it). Uncontrolled:
 * `value` seeds it (and replaces the text when it changes from outside), `onChange` reports edits.
 */
export function CodeEditor({ value, onChange, label, readOnly = false, className, onSave }: { value: string; onChange: (value: string) => void; label: string; readOnly?: boolean; className?: string; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection }, { EditorState }, { defaultKeymap, history, historyKeymap, indentWithTab }, { javascript }, lang, { autocompletion, completeFromList }] =
        await Promise.all([
          import("@codemirror/view"),
          import("@codemirror/state"),
          import("@codemirror/commands"),
          import("@codemirror/lang-javascript"),
          import("@codemirror/language"),
          import("@codemirror/autocomplete"),
        ]);
      if (cancelled || !host.current) return;
      const tsx = javascript({ jsx: true, typescript: true });
      const theme = EditorView.theme({
        "&": { fontSize: "12.5px", height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
        ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)", caretColor: "var(--foreground)" },
        ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted-foreground)", border: "none", borderRight: "1px solid var(--border)" },
        ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 60%, transparent)" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)" },
        ".cm-tooltip": { backgroundColor: "var(--popover, var(--background))", border: "1px solid var(--border)" },
      });
      const state = EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          // Email markup has long lines (inline styles); wrap instead of scrolling sideways.
          EditorView.lineWrapping,
          lang.indentOnInput(),
          lang.bracketMatching(),
          lang.syntaxHighlighting(lang.defaultHighlightStyle, { fallback: true }),
          tsx,
          tsx.language.data.of({ autocomplete: completeFromList(EMAIL_COMPONENTS.map((label) => ({ label, type: "class", detail: "@react-email/components" }))) }),
          autocompletion(),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (saveRef.current?.(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString());
          }),
          theme,
        ],
      });
      view.current = new EditorView({ state, parent: host.current });
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
    // Created once; `value` changes from outside are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className={cn("min-h-0 overflow-hidden rounded-md border", className)} />;
}
