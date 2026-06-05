import { CATEGORY_DEFS } from "../../lib/categories.js";

export default function CategoryPills({ selected, onToggle, disabled }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CATEGORY_DEFS.map((cat) => {
        const active = selected.includes(cat.id);
        const base =
          "cursor-pointer select-none rounded-full border px-3 py-1 text-xs shadow-sm transition disabled:cursor-default";
        const cls = active
          ? "border-sky-500 bg-sky-200/70 text-sky-900"
          : "border-stone-300 bg-white text-stone-700 hover:border-stone-400";
        return (
          <button
            key={cat.id}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(cat.id)}
            className={`${base} ${cls}`}
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
