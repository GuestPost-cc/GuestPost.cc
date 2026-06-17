// Phase 7.10 — Email verification template.
//
// Plain inline HTML, no template engine — matches the existing email
// processor's untemplated approach in `apps/worker/src/processors/email.processor.ts`.
// If brand pushes for richer templates later, that's a separate themed-email
// phase (introduce MJML/react-email at that point, not now).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export interface VerificationEmailContext {
  name: string | null
  url: string
}

export function renderVerificationEmail({ name, url }: VerificationEmailContext): string {
  const greeting = name ? `Hi ${escapeHtml(name)}` : "Hi"
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.5;">
    <h2>Verify your email</h2>
    <p>${greeting} — please confirm your email address to start using GuestPost.cc.</p>
    <p><a href="${escapeAttr(url)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none">Verify email</a></p>
    <p style="color:#666;font-size:14px">If the button doesn't work, copy and paste this link:<br><code>${escapeHtml(url)}</code></p>
    <p style="color:#666;font-size:12px">This link expires in 24 hours. If you didn't sign up for GuestPost.cc, you can ignore this email.</p>
  </body></html>`
}
