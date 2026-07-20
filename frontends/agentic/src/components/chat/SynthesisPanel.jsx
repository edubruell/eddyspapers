import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { anchorIdFor } from "./SectionCard.jsx";

function scrollToHandle(handle) {
  const el = document.getElementById(anchorIdFor(handle));
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// A RePEc handle sometimes arrives as a link destination — `[label](`repec:...`)`
// or `[label](repec:...)` — instead of a bare backtick handle. That is not a real
// URL, so treat it the same as an in-page handle reference rather than a dead link.
function handleFromHref(href) {
  const cleaned = String(href ?? "").trim().replace(/^`+|`+$/g, "").trim();
  return /^RePEc:/i.test(cleaned) ? cleaned : null;
}

function JumpButton({ handle, children }) {
  return (
    <button
      type="button"
      onClick={() => scrollToHandle(handle)}
      className="cursor-pointer rounded bg-sky-50 px-1 text-[0.85em] text-[var(--primary)] underline-offset-2 hover:underline"
      title="Jump to this paper below"
    >
      {children ?? handle}
    </button>
  );
}

const components = {
  // External citation links open in a new tab without losing the reader's place —
  // but a repec handle mistakenly used as an href becomes an in-page jump instead.
  a({ href, children }) {
    const handle = handleFromHref(href);
    if (handle) return <JumpButton handle={handle}>{children}</JumpButton>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // `RePEc:…` backtick handles become in-page jumps to the evidence card.
  code({ children }) {
    const text = String(children ?? "");
    if (/^RePEc:/i.test(text.trim())) {
      return <JumpButton handle={text.trim()} />;
    }
    return <code>{children}</code>;
  },
};

export default function SynthesisPanel({ synthesis }) {
  if (!synthesis) return null;
  return (
    <div className="synthesis text-[15px] text-stone-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {synthesis}
      </ReactMarkdown>
    </div>
  );
}
