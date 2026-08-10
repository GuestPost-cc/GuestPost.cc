function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function renderAuthActionEmail(options: {
  name: string | null
  title: string
  introduction: string
  actionLabel: string
  url: string
  expiry: string
  ignoreMessage: string
}): string {
  const greeting = options.name ? `Hi ${escapeHtml(options.name)} —` : "Hi —"
  const safeUrl = escapeHtml(options.url)
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a">
    <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(options.introduction)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
          <tr><td style="padding:22px 28px;background:#0f172a;color:#ffffff;font-size:20px;font-weight:700">GuestPost.cc</td></tr>
          <tr><td style="padding:32px 28px">
            <p style="margin:0 0 18px;color:#334155">${greeting}</p>
            <div style="width:44px;height:4px;background:#2563eb;border-radius:4px;margin-bottom:18px"></div>
            <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(options.title)}</h1>
            <p style="margin:0;color:#334155;font-size:16px;line-height:1.65">${escapeHtml(options.introduction)}</p>
            <p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(options.actionLabel)}</a></p>
            <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">If the button does not work, copy and paste this link:<br><code style="overflow-wrap:anywhere">${safeUrl}</code></p>
          </td></tr>
          <tr><td style="padding:20px 28px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5">
            <p style="margin:0 0 6px">${escapeHtml(options.expiry)}</p>
            <p style="margin:0">${escapeHtml(options.ignoreMessage)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`
}
