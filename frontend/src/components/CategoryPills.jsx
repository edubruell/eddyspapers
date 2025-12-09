export default function CategoryPills({
                                          categories,
                                          selectedCats,
                                          onToggleCategory
                                      }) {
    return (
        <div className="flex flex-wrap gap-2">
            {categories.map((cat) => {
                const active = selectedCats.includes(cat.id);
                const base =
                    "cursor-pointer select-none rounded-full border px-3 py-1 text-xs md:text-[13px] shadow-sm transition";
                const inactive =
                    "border-stone-300 bg-white text-stone-700 hover:border-stone-400";
                const activeCls =
                    "border-orange-500 bg-orange-200/70 text-orange-900";
                return (
                    <button
                        key={cat.id}
                        type="button"
                        onClick={() => onToggleCategory(cat.id)}
                        className={`${base} ${active ? activeCls : inactive}`}
                    >
                        {cat.label}
                    </button>
                );
            })}
        </div>
    );
}
