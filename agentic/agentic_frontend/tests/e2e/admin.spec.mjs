import { test, expect } from "@playwright/test";

// Drives the /admin key console against the mock registry: lock → unlock → mint (plaintext
// reveal, once) → list → revoke → show-revoked. No live backend/DB.
test("admin: unlock, mint, reveal once, list, revoke", async ({ page }) => {
  await page.goto("/admin");

  // Lock screen: the mock 401s without a Bearer token.
  const tokenField = page.getByPlaceholder(/esk_… or admin password/i);
  await expect(tokenField).toBeVisible();

  // Unlock with any token (mock accepts any Bearer).
  await tokenField.fill("s3cret-admin");
  await page.getByRole("button", { name: /^Enter$/ }).click();

  // Registry view: empty to start.
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No keys yet.")).toBeVisible();

  // Mint a key — free-text label carries the recipient.
  await page.getByPlaceholder(/Alice Müller/i).fill("Bob Keynes (LSE) — bob@example.org");
  await page.getByRole("button", { name: /Create key/i }).click();

  // Plaintext shown once, in the reveal modal, with a copy button.
  await expect(page.getByText(/only time/i)).toBeVisible();
  const plaintext = page.getByText(/esk_mock_.*_plaintext/);
  await expect(plaintext).toBeVisible();
  await page.getByRole("button", { name: /I’ve saved it|I've saved it/ }).click();

  // Reveal is one-shot: the plaintext is gone and never appears in the table (the list
  // endpoint returns no `key`), so it cannot be recovered.
  await expect(plaintext).toHaveCount(0);

  // The key appears in the table with its label + active state.
  const row = page.getByRole("row", { name: /Bob Keynes/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("active")).toBeVisible();
  await expect(row.getByText(/esk_mock_.*_plaintext/)).toHaveCount(0);

  // Revoke with inline confirm.
  await row.getByRole("button", { name: /^Revoke$/ }).click();
  await row.getByRole("button", { name: /^Confirm$/ }).click();

  // Gone from the active list.
  await expect(page.getByText("No keys yet.")).toBeVisible();

  // Show revoked → the outgoing request carries ?all=1 and the row reappears, marked revoked.
  const allReq = page.waitForRequest((r) => /\/admin\/keys\?all=1\b/.test(r.url()));
  await page.getByLabel(/Show revoked/i).check();
  await allReq;
  const revokedRow = page.getByRole("row", { name: /Bob Keynes/ });
  await expect(revokedRow).toBeVisible();
  await expect(revokedRow.getByText("revoked")).toBeVisible();
});

// Sign-out forgets the stored admin token and returns to the lock screen.
test("admin: sign out clears the token and re-locks", async ({ page }) => {
  await page.goto("/admin");
  await page.getByPlaceholder(/esk_… or admin password/i).fill("s3cret-admin");
  await page.getByRole("button", { name: /^Enter$/ }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await page.getByRole("button", { name: /Sign out/i }).click();

  // Lock screen back, and the token is gone from storage.
  await expect(page.getByPlaceholder(/esk_… or admin password/i)).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("agentic_admin_key"));
  expect(stored).toBeNull();
});
