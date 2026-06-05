import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { anchorIdFor } from "./SectionCard.jsx";

function scrollToHandle(handle) {
  const el = document.getElementById(anchorIdFor(handle));
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

const components = {
  // External citation links open in a new tab without losing the reader's place.
  a({ href, children }) {
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
      const handle = text.trim();
      return (
        <button
          type="button"
          onClick={() => scrollToHandle(handle)}
          className="cursor-pointer rounded bg-sky-50 px-1 text-[0.85em] text-[var(--primary)] underline-offset-2 hover:underline"
          title="Jump to this paper below"
        >
          {handle}
        </button>
      );
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
