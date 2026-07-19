function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export interface PasswordResetEmailContext {
  name: string | null
  url: string
}

export function renderPasswordResetEmail({
  name,
  url,
}: PasswordResetEmailContext): string {
  const greeting = name ? `Hi ${escapeHtml(name)}` : "Hi"
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.5;">
    <h2>Reset your GuestPost password</h2>
    <p>${greeting} — we received a request to reset your password.</p>
    <p><a href="${escapeAttr(url)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none">Reset password</a></p>
    <p style="color:#666;font-size:14px">If the button doesn't work, copy and paste this link:<br><code>${escapeHtml(url)}</code></p>
    <p style="color:#666;font-size:12px">This single-use link expires in one hour. If you didn't request it, you can ignore this email and your password will remain unchanged.</p>
  </body></html>`
}
