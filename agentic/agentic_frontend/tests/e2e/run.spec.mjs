import { test, expect } from "@playwright/test";

// Drives the agentic UI against the mock SSE backend and asserts the full
// run renders: stepper → strategy (NOT the R script) → synthesis → evidence.
test("brief → run → strategy, synthesis, and evidence render", async ({ page }) => {
  await page.goto("/");

  // Landing: wordmark + task box.
  await expect(page.getByText("AGENTIC SEARCH")).toBeVisible();
  const task = page.getByPlaceholder(/Describe what you're looking for/i);
  await expect(task).toBeVisible();

  await task.fill(
    "effects of minimum wage on youth employment in low-income labor markets",
  );
  await page.getByRole("button", { name: /Run search/i }).click();

  // Strategy panel appears with plain-language text — and never the R script.
  await expect(page.getByText("Search strategy")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/sweep for papers on minimum wage/i)).toBeVisible();

  // The R script must never be surfaced.
  await expect(page.getByText(/semantic_search\(/)).toHaveCount(0);
  await expect(page.getByText(/emit_section\(/)).toHaveCount(0);

  // Synthesis (markdown) streams in.
  await expect(page.getByText("Overview")).toBeVisible({ timeout: 20000 });

  // Evidence sections rendered; expand the first and confirm a paper card shows.
  const evidence = page.getByText("Evidence", { exact: true });
  await expect(evidence).toBeVisible();
  const firstSection = page.getByRole("button", { name: /found ·.*shown/i }).first();
  await firstSection.click();

  // A paper card has a BibTeX action once expanded.
  await expect(page.getByRole("button", { name: "BibTeX" }).first()).toBeVisible({
    timeout: 10000,
  });

  // Done line shows after the stream completes.
  await expect(page.getByText(/Review ready/i)).toBeVisible({ timeout: 20000 });
});
