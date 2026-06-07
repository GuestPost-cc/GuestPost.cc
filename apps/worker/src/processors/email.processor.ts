import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES } from "@guestpost/shared"
import * as nodemailer from "nodemailer"

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT) || 1025,
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
})

export function createEmailWorker() {
  const worker = new Worker(
    QUEUES.EMAIL,
    async (job) => {
      const { to, subject, html } = job.data

      let finalSubject = subject
      let finalHtml = html

      switch (job.name) {
        case "send-welcome":
          finalSubject = finalSubject || "Welcome to GuestPost.cc"
          finalHtml = finalHtml || `<h1>Welcome to GuestPost.cc</h1><p>We are glad you are here.</p>`
          console.log(`[EMAIL] Welcome email to ${to}`)
          break
        case "send-invoice":
          console.log(`[EMAIL] Invoice to ${to}: ${subject}`)
          break
        case "send-magic-link":
          console.log(`[EMAIL] Magic link to ${to}`)
          break
        default:
          console.log(`[EMAIL] ${subject} to ${to}`)
          break
      }

      await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"GuestPost.cc" <noreply@guestpost.cc>',
        to,
        subject: finalSubject,
        html: finalHtml,
      })

      return { sent: true, to }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    console.log(`[EMAIL] Job ${job.id} completed`)
  })

  worker.on("failed", (job, err) => {
    console.error(`[EMAIL] Job ${job?.id} failed:`, err)
  })

  return worker
}
