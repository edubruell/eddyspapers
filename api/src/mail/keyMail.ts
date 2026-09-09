import type { MailKind } from "../db/appdata.js";
import type { MailMessage } from "./mailer.js";

// The one message the signup route sends. It carries the only copy of the plaintext key
// that will ever exist (only the SHA-256 digest is stored), so it also has to carry
// everything needed to USE the key — otherwise the reader comes back for a resend, which
// rotates the key and costs another mail against the D6 cooldown.
//
// Sent as text AND html. The plain part is not a fallback stub: clients strip HTML, and a
// reader who only ever sees the text part must still be able to install the key from it.

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

const SIGNATURE = "Eduard Brüll";

// Remote images are blocked by default in most clients, so the logo is decoration only —
// every word that matters lives in the text next to it.
const LOGO_URL = `${SITE_URL}/logo_mail.png`;

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INK = "#292524";
const MUTED = "#57534e";
const LINK = "#075985";
const PAPER = "#eee7da";
const BORDER = "#d6d3d1";

const codeBlock = (body: string): string =>
  `<div style="margin:0 0 20px;padding:12px 14px;background:#292524;border-radius:8px">` +
  `<code style="font:13px/1.6 SFMono-Regular,Consolas,Menlo,monospace;color:#f5f5f4;` +
  `white-space:pre-wrap;word-break:break-all">${body}</code></div>`;

export function keyMail(args: { to: string; name: string; key: string; revokeUrl: string; kind: MailKind }): MailMessage {
  const rotated = args.kind === "resend";
  const firstName = args.name.trim().split(/\s+/)[0] || args.name;

  const opening = rotated
    ? "Here is a new key for the eddysearch MCP server. Your previous key has been switched off, so please replace it wherever you set it up."
    : "Thank you for trying Eddy's Papers. Here is your key for the eddysearch MCP server, which puts about 455,000 economics papers and 88,000 registered authors inside your AI assistant.";

  const addLine = `claude mcp add --transport http eddysearch ${MCP_URL} \\\n  --header "Authorization: Bearer ${args.key}"`;

  const text = [
    `Hello ${firstName},`,
    "",
    opening,
    "",
    `    ${args.key}`,
    "",
    "Add it to Claude Code with:",
    "",
    `    ${addLine.replace("\n", "\n    ")}`,
    "",
    "Please keep this mail. The key is stored only as a hash, so it cannot be sent to you",
    "again. Asking for another one replaces this key.",
    "",
    "Tools: find_papers, keyword_search, find_people, verify_references, corpus_context,",
    "and lit_search (a full literature sweep, returned as papers, BibTeX, CSV and the script).",
    `Setup help, the two Claude Code skills and the tool list: ${SITE_URL}/mcp`,
    "",
    "To switch this key off and delete the name, address and institution stored with it:",
    `    ${args.revokeUrl}`,
    "",
    "I am always thankful for feedback. If something does not work, if you run into a bug or",
    "see behaviour that looks odd, please write to me at " + SUPPORT_EMAIL + ". I read every",
    "message myself.",
    "",
    "Best wishes,",
    SIGNATURE,
    SITE_URL,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(rotated ? "Your new Eddy's Papers key" : "Your Eddy's Papers key")}</title>
</head><body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px">
<tr><td style="padding:28px 28px 32px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">

<img src="${LOGO_URL}" alt="Eddy's Papers" width="240" style="width:240px;max-width:100%;height:auto;display:block;margin:0 0 24px">

<p style="margin:0 0 16px">Hello ${escape(firstName)},</p>

<p style="margin:0 0 20px">${escape(opening)}</p>

${codeBlock(escape(args.key))}

<p style="margin:0 0 12px">Add it to Claude Code with this one line:</p>

${codeBlock(escape(addLine))}

<p style="margin:0 0 20px">Please keep this mail. The key is stored only as a hash, so it cannot be sent to you again. Asking for another one replaces this key.</p>

<p style="margin:0 0 20px">Your key opens <strong>find_papers</strong>, <strong>keyword_search</strong>, <strong>find_people</strong>, <strong>verify_references</strong>, <strong>corpus_context</strong> and <strong>lit_search</strong>, which sweeps a whole literature in one call and hands back the papers, a BibTeX file, a CSV and the search script. Setup help for other assistants, the tool list and two ready-made Claude Code skills are on <a href="${SITE_URL}/mcp" style="color:${LINK}">the access page</a>.</p>

<p style="margin:0 0 24px;font-size:14px;color:${MUTED}">To switch this key off and delete the name, address and institution stored with it, open <a href="${escape(args.revokeUrl)}" style="color:${LINK};word-break:break-all">this link</a>.</p>

<hr style="border:none;border-top:1px solid #e7e5e4;margin:0 0 20px">

<p style="margin:0 0 20px">I am always thankful for feedback. If something does not work, if you run into a bug or see behaviour that looks odd, please write to me at <a href="mailto:${SUPPORT_EMAIL}" style="color:${LINK}">${SUPPORT_EMAIL}</a>. I read every message myself.</p>

<p style="margin:0">Best wishes,<br>${SIGNATURE}</p>

</td></tr></table>
<p style="margin:16px 0 0;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED}">
<a href="${SITE_URL}" style="color:${MUTED}">${SITE_URL.replace("https://", "")}</a>
</p>
</td></tr></table>
</body></html>`;

  return {
    to: args.to,
    subject: rotated ? "Your new Eddy's Papers key" : "Your Eddy's Papers key",
    text,
    html,
  };
}
