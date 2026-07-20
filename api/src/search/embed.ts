// Query-time embeddings via local Ollama — the Node-side replacement for
// tidyllm::ollama_embedding() (PLAN.md §2.1). Must stay in lockstep with the
// corpus: articles.embeddings were built with mxbai-embed-large (FLOAT[1024]).

export const EMBED_MODEL = "mxbai-embed-large";
export const EMBED_DIM = 1024;

const ollamaBase = (): string => process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434";

export async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch(`${ollamaBase()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  const vec = data.embeddings?.[0];
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM}-dim embedding, got ${vec?.length ?? "none"}`);
  }
  return vec;
}

// Inline literal is injection-safe ONLY because every element is verified to be a
// finite number first (NaN/Infinity can't survive JSON.parse, but the exported
// *WithVector functions accept caller-supplied arrays). Sidesteps node-api array
// binding; the R side binds a list for the same query.
export const vectorLiteral = (vec: number[]): string => {
  if (!vec.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("embedding vector must contain only finite numbers");
  }
  return `[${vec.join(",")}]::FLOAT[${EMBED_DIM}]`;
};
