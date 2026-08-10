import type {
  CommunicationEventType,
  NotificationSeverity,
} from "./communications"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function normalizeOrigin(value: string): URL {
  const origin = new URL(value)
  const localHttp =
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
  if (origin.protocol !== "https:" && !localHttp) {
    throw new Error("Email action origin must use HTTPS")
  }
  if (origin.username || origin.password || origin.pathname !== "/") {
    throw new Error(
      "Email action origin must not contain credentials or a path",
    )
  }
  return origin
}

export function buildEmailActionUrl(
  origin: string,
  actionPath: string,
): string {
  if (
    !actionPath.startsWith("/") ||
    actionPath.startsWith("//") ||
    /[\u0000-\u001f\u007f]/.test(actionPath)
  ) {
    throw new Error("Unsafe email action path")
  }
  return new URL(actionPath, normalizeOrigin(origin)).toString()
}

const accentBySeverity: Record<NotificationSeverity, string> = {
  INFO: "#2563eb",
  SUCCESS: "#15803d",
  WARNING: "#b45309",
  CRITICAL: "#b91c1c",
}

export interface CommunicationEmailContext {
  eventType: CommunicationEventType
  recipientName: string | null
  title: string
  message: string
  severity: NotificationSeverity
  actionUrl?: string | null
  actionLabel?: string | null
  reference?: string | null
  preferencesUrl?: string | null
}

export interface RenderedCommunicationEmail {
  subject: string
  html: string
  text: string
}

export function renderCommunicationEmail(
  context: CommunicationEmailContext,
): RenderedCommunicationEmail {
  const greeting = context.recipientName?.trim()
    ? `Hi ${context.recipientName.trim()},`
    : "Hello,"
  const actionLabel = context.actionLabel?.trim() || "View details"
  const accent = accentBySeverity[context.severity]
  const reference = context.reference?.trim()
  const subject = context.title.replace(/[\r\n]+/g, " ").slice(0, 160)
  const actionHtml = context.actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(context.actionUrl)}" style="display:inline-block;background:${accent};color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(actionLabel)}</a></p>`
    : ""
  const actionText = context.actionUrl
    ? `\n\n${actionLabel}: ${context.actionUrl}`
    : ""
  const preferencesHtml = context.preferencesUrl
    ? `<p style="margin:8px 0 0"><a href="${escapeHtml(context.preferencesUrl)}" style="color:#475569">Manage notification preferences</a></p>`
    : ""
  const referenceHtml = reference
    ? `<p style="margin:20px 0 0;color:#64748b;font-size:13px">Reference: ${escapeHtml(reference)}</p>`
    : ""

  return {
    subject,
    text: `${greeting}\n\n${context.title}\n\n${context.message}${actionText}${reference ? `\n\nReference: ${reference}` : ""}\n\nGuestPost.cc\nThis is an automated transactional message.`,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#0f172a">
    <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(context.message.slice(0, 140))}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
          <tr><td style="padding:22px 28px;background:#0f172a;color:#ffffff;font-size:20px;font-weight:700">GuestPost.cc</td></tr>
          <tr><td style="padding:32px 28px">
            <p style="margin:0 0 18px;color:#334155">${escapeHtml(greeting)}</p>
            <div style="width:44px;height:4px;background:${accent};border-radius:4px;margin-bottom:18px"></div>
            <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(context.title)}</h1>
            <p style="margin:0;color:#334155;font-size:16px;line-height:1.65">${escapeHtml(context.message)}</p>
            ${actionHtml}
            ${referenceHtml}
          </td></tr>
          <tr><td style="padding:20px 28px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5">
            <p style="margin:0">This is an automated transactional message from GuestPost.cc.</p>
            ${preferencesHtml}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  }
}
