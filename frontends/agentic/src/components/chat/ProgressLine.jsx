export default function ProgressLine({ progress, done, msTotal }) {
  if (done) {
    const secs = msTotal != null ? (msTotal / 1000).toFixed(0) : null;
    return (
      <p className="text-xs text-stone-500">
        Review ready{secs ? ` · took ${secs}s` : ""}.
      </p>
    );
  }
  if (!progress) return null;
  const { label, current, total } = progress;
  const count =
    current != null && total != null ? ` (${current}/${total})` : "";
  return (
    <p className="text-xs text-stone-500">
      {label}
      {count}
    </p>
  );
}
