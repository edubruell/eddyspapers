import { useState, useEffect, useMemo } from "react";
import { getJelCodes } from "../lib/api";

// Parse/serialise the comma-separated JEL string the search payload uses.
const parse = (v) =>
    v ? v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
const serialise = (arr) => arr.join(",");

// Depth → left padding. JEL is exactly three levels (category → subcategory → detail).
const PAD = ["pl-1", "pl-5", "pl-9"];

// Some AEA labels arrive HTML-entity-encoded (e.g. "Labor&ndash;Management"). Decode for
// display via a detached textarea — trusted reference text, and .value never executes markup.
const decodeEntities = (s) => {
    if (!s || !s.includes("&") || typeof document === "undefined") return s;
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
};

export default function JelPicker({ value, onChange }) {
    const [codes, setCodes] = useState([]);
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(() => new Set());
    const [open, setOpen] = useState(false);

    const selected = parse(value);
    const selSet = new Set(selected);

    useEffect(() => {
        let alive = true;
        getJelCodes()
            .then((data) => alive && setCodes(data.map((c) => ({ ...c, label: decodeEntities(c.label) }))))
            .catch(() => {}); // stays usable via typed codes if the taxonomy fetch fails
        return () => {
            alive = false;
        };
    }, []);

    const { roots, childrenOf, parentOf, labelOf } = useMemo(() => {
        const childrenOf = new Map();
        const parentOf = new Map();
        const labelOf = new Map();
        codes.forEach((c) => {
            labelOf.set(c.code, c.label);
            if (c.parent) {
                parentOf.set(c.code, c.parent);
                if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
                childrenOf.get(c.parent).push(c);
            }
        });
        return { roots: codes.filter((c) => c.level === 1), childrenOf, parentOf, labelOf };
    }, [codes]);

    // While searching, the visible set = matching nodes plus all their ancestors, so a
    // deep detail-code hit still shows its path and its parents auto-expand.
    const search = useMemo(() => {
        const q = query.trim().toUpperCase();
        if (!q) return null;
        const ql = q.toLowerCase();
        const visible = new Set();
        codes.forEach((c) => {
            if (c.code.startsWith(q) || (c.label ?? "").toLowerCase().includes(ql)) {
                visible.add(c.code);
                let p = parentOf.get(c.code);
                while (p) {
                    visible.add(p);
                    p = parentOf.get(p);
                }
            }
        });
        return visible;
    }, [codes, query, parentOf]);

    const toggleExpand = (code) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            next.has(code) ? next.delete(code) : next.add(code);
            return next;
        });

    const toggleSelect = (code) => {
        const next = new Set(selSet);
        next.has(code) ? next.delete(code) : next.add(code);
        onChange(serialise([...next]));
    };

    const remove = (code) => onChange(serialise(selected.filter((c) => c !== code)));

    const isOpen = (code) => (search ? search.has(code) : expanded.has(code));

    const renderNodes = (nodes, depth) =>
        nodes
            .filter((n) => !search || search.has(n.code))
            .map((n) => {
                const kids = childrenOf.get(n.code);
                const hasKids = kids && kids.length > 0;
                const open = isOpen(n.code);
                return (
                    <div key={n.code}>
                        <div className={`flex items-center ${PAD[depth]} hover:bg-stone-50`}>
                            {hasKids ? (
                                <button
                                    type="button"
                                    onClick={() => toggleExpand(n.code)}
                                    aria-label={open ? `Collapse ${n.code}` : `Expand ${n.code}`}
                                    className="shrink-0 p-1 text-stone-400 hover:text-stone-700"
                                >
                                    <svg
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
                                    >
                                        <path d="M6 4l4 4-4 4" />
                                    </svg>
                                </button>
                            ) : (
                                <span className="w-5 shrink-0" />
                            )}

                            <label className="flex items-center gap-2 flex-1 min-w-0 py-1.5 pr-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={selSet.has(n.code)}
                                    onChange={() => toggleSelect(n.code)}
                                    className="shrink-0 accent-sky-600 w-4 h-4"
                                />
                                <span className="font-semibold text-stone-800 shrink-0 w-9 text-xs">
                                    {n.code}
                                </span>
                                <span
                                    title={n.label}
                                    className={`truncate text-xs ${
                                        n.level === 1 ? "font-medium text-stone-700" : "text-stone-600"
                                    }`}
                                >
                                    {n.label}
                                </span>
                            </label>
                        </div>
                        {hasKids && open && renderNodes(kids, depth + 1)}
                    </div>
                );
            });

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="flex items-center gap-1.5 w-full text-left mb-1"
            >
                <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`w-3.5 h-3.5 text-stone-500 transition-transform ${open ? "rotate-90" : ""}`}
                >
                    <path d="M6 4l4 4-4 4" />
                </svg>
                <span className="text-xs font-semibold text-stone-600">JEL CODES</span>
                {selected.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-sky-100 text-sky-800 text-[10px] font-semibold px-1.5 py-0.5">
                        {selected.length}
                    </span>
                )}
            </button>

            {selected.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {selected.map((code) => (
                        <span
                            key={code}
                            className="inline-flex items-center gap-1 rounded-full bg-sky-100 text-sky-900 text-[11px] px-2 py-1"
                        >
                            <span className="font-semibold">{code}</span>
                            {labelOf.get(code) && (
                                <span className="max-w-[8rem] truncate text-sky-700">
                                    {labelOf.get(code)}
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={() => remove(code)}
                                aria-label={`Remove ${code}`}
                                className="ml-0.5 text-sky-500 hover:text-sky-800 text-sm leading-none"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {open && (
                <>
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter by code or topic (e.g. J31 or “wages”)"
                        className="w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-sm mb-1.5"
                    />

                    {/* Bounded height + overscroll-contain: the tree scrolls within itself
                        without hijacking the panel's own scroll, so it never dominates the
                        sidebar on standard searches. */}
                    <div className="rounded-md border border-stone-300 bg-white py-1 divide-y divide-stone-50 max-h-64 overflow-y-auto overscroll-contain">
                        {codes.length === 0 ? (
                            <p className="px-2 py-2 text-xs text-stone-400">Loading JEL codes…</p>
                        ) : search && search.size === 0 ? (
                            <p className="px-2 py-2 text-xs text-stone-400">No matching codes.</p>
                        ) : (
                            renderNodes(roots, 0)
                        )}
                    </div>

                    <div className="text-[10px] text-stone-500 mt-1">
                        Pick a category like J or a detail code like J31; broader picks include
                        everything under them. Only about 55% of papers carry JEL codes, so this
                        filter will hide the rest.
                    </div>
                </>
            )}
        </div>
    );
}
