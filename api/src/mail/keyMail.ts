import type { MailKind } from "../db/appdata.js";
import type { MailMessage } from "./mailer.js";

// The one message the signup route sends. It carries the only copy of the plaintext key
// that will ever exist (only the SHA-256 digest is stored), so it also has to carry
// everything needed to USE the key — otherwise the reader comes back for a resend, which
// rotates the key and costs another mail against the D6 cooldown.

// Where a human ends up when the automated path fails. Measured 2026-09-09: institutional
// gateways greylist a first-time sender (zew.de deferred, then delivered, with no bounce at
// all), so "it did not arrive" is a normal outcome, not an error — and the only recovery a
// stranger has is a person. Stated on the page, in the API response, and here.
export const SUPPORT_EMAIL = "eduard.bruell@zew.de";
export const DELIVERY_NOTE =
  `Delivery can take up to 24 hours. If nothing has arrived by then, write to ` +
  `${SUPPORT_EMAIL} and I will send you a key myself.`;

const MCP_URL = process.env.MCP_PUBLIC_URL ?? "https://agenticsearch.eduard-bruell.de/mcp";
const SITE_URL = process.env.SITE_PUBLIC_URL ?? "https://econpapers.eduard-bruell.de";

export function keyMail(args: { to: string; name: string; key: string; revokeUrl: string; kind: MailKind }): MailMessage {
  const rotated = args.kind === "resend";
  return {
    to: args.to,
    subject: rotated ? "Your new eddysearch MCP key" : "Your eddysearch MCP key",
    text: [
      `Hello ${args.name},`,
      "",
      rotated
        ? "Here is a new key for the eddysearch MCP server. Your previous key has been revoked, so replace it wherever you configured it."
        : "Here is your key for the eddysearch MCP server: semantic search over ~455k RePEc economics papers and ~88k registered authors.",
      "",
      `    ${args.key}`,
      "",
      "Add it to Claude Code with:",
      "",
      `    claude mcp add --transport http eddysearch ${MCP_URL} \\`,
      `      --header "Authorization: Bearer ${args.key}"`,
      "",
      "Keep this mail. The key is stored only as a hash, so it cannot be sent again;",
      "requesting a new one replaces this key.",
      "",
      `Tools: find_papers, keyword_search, find_people, verify_references, corpus_context,`,
      `and lit_search (a full literature sweep, returned as papers + BibTeX + CSV + script).`,
      `API reference: ${SITE_URL}/api/docs`,
      "",
      "To revoke this key and delete the name, address and institution stored with it:",
      `    ${args.revokeUrl}`,
      "",
      `If the key does not work, or you need anything else, write to ${SUPPORT_EMAIL}.`,
      `There is a person at the other end.`,
      "",
      "-- Eddy's Papers",
      SITE_URL,
    ].join("\n"),
  };
}
