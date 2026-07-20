import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { checkScript } from "../../sandbox/checkScript.js";

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: string; offendingNode: string; hint: string };

export async function validateScript(script: string): Promise<ValidateResult> {
  const tmp = join(tmpdir(), `eddysearch_val_${Date.now()}_${Math.random().toString(36).slice(2)}.R`);
  try {
    await writeFile(tmp, script, "utf-8");
    return await checkScript(tmp);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
