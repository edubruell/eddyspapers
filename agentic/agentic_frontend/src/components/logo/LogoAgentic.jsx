// Eddy's hand-drawn detective-meerkat banner (Flux + GIMP), replacing the
// placeholder magnifying-glass mark. The webp already contains the full
// wordmark ("Eddy's Papers / AGENTIC SEARCH / by Eduard Brüll"), so the
// component is just the image at two sizes: a hero on the landing screen and a
// compact banner in the working-state sidebar header.
export default function LogoAgentic({ compact = false }) {
  return (
    <img
      src="/logo_agentic.webp"
      alt="Eddy's Papers — Agentic Search, by Eduard Brüll"
      className={compact ? "h-auto w-full" : "h-auto w-full max-w-[420px]"}
    />
  );
}
