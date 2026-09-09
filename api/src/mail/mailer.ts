import nodemailer from "nodemailer";

// Outbound mail, used by exactly one caller: the self-serve signup route, which puts the
// minted key ONLY in the mail (public_access/01_signup_site.md D1). Behind an interface so
// route tests can assert what would have been sent without opening a socket.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  // Resolves only when the relay ACCEPTED the message. The signup route treats that accept
  // as the mailbox proving out (verified_at) — it is the strongest signal available without
  // a click-a-link round trip, and a later silent drop is not observable from here anyway.
  send(m: MailMessage): Promise<void>;
  readonly configured: boolean;
}

// No SMTP_HOST/SMTP_PASS (dev, CI) → log the message instead of failing. The signup route
// would otherwise be untestable and undevelopable without live credentials, and a dev box
// mailing real strangers is worse than a dev box mailing nobody.
const logMailer: Mailer = {
  configured: false,
  async send(m) {
    console.warn(`[mail] SMTP not configured — would send to ${m.to}: ${m.subject}`);
  },
};

function buildSmtpMailer(): Mailer {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? "1") === "1",
    auth: { user: process.env.SMTP_USER ?? "", pass: process.env.SMTP_PASS ?? "" },
  });
  const from = process.env.MAIL_FROM ?? process.env.SMTP_USER ?? "";
  return {
    configured: true,
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}

let singleton: Mailer | null = null;

export function getMailer(): Mailer {
  if (!singleton) {
    singleton = process.env.SMTP_HOST && process.env.SMTP_PASS ? buildSmtpMailer() : logMailer;
  }
  return singleton;
}

// Test seam. Passing null restores env-based selection on the next getMailer().
export function setMailer(m: Mailer | null): void {
  singleton = m;
}
