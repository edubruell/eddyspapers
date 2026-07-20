import { useEffect, useRef } from "react";

export default function SearchBox({ value, onChange, onKeyDown }) {
    const ref = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);

    return (
        <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            className="w-full resize-none overflow-hidden rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-300 max-h-40"
            placeholder="Enter your abstract or search text here..."
        />
    );
}
