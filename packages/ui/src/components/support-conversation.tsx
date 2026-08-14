"use client"

import {
  Bot,
  Building2,
  Headphones,
  Loader2,
  LockKeyhole,
  Send,
  UserRound,
} from "lucide-react"
import { type FormEvent, useId } from "react"
import { cn } from "../lib/utils"
import { Button } from "./button"
import { Skeleton } from "./skeleton"
import { Textarea } from "./textarea"

export type SupportConversationParty =
  | "CUSTOMER"
  | "PUBLISHER"
  | "SUPPORT"
  | "SYSTEM"

export type SupportConversationVisibility = "PUBLIC" | "INTERNAL"

export type SupportConversationMessageType =
  | "MESSAGE"
  | "INTERNAL_NOTE"
  | "SYSTEM_EVENT"

export interface SupportConversationSender {
  party: SupportConversationParty
  displayName: string
  isSelf: boolean
}

export interface SupportConversationMessage {
  id: string
  content: string
  visibility: SupportConversationVisibility
  messageType: SupportConversationMessageType
  participantRole?: string | null
  createdAt: string
  sender: SupportConversationSender
}

export interface SupportConversationProps {
  messages: readonly SupportConversationMessage[]
  isLoading?: boolean
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void
  olderMessagesError?: string | null
  label?: string
  emptyMessage?: string
  showRoleDetails?: boolean
  className?: string
}

/** Merge cursor pages without duplicating overlapping messages. */
export function mergeSupportConversationMessages<
  T extends SupportConversationMessage,
>(...pages: ReadonlyArray<readonly T[]>): T[] {
  const messages = new Map<string, T>()
  for (const page of pages) {
    for (const message of page) messages.set(message.id, message)
  }

  return Array.from(messages.values()).sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    if (
      Number.isFinite(leftTime) &&
      Number.isFinite(rightTime) &&
      leftTime !== rightTime
    ) {
      return leftTime - rightTime
    }
    return left.id.localeCompare(right.id)
  })
}

/** Merge a refetched cursor chain whose first page is the newest page. */
export function mergeSupportConversationPages<
  T extends SupportConversationMessage,
>(pages: readonly { messages: readonly T[] }[] | undefined): T[] {
  return mergeSupportConversationMessages(
    ...(pages ?? []).map((page) => page.messages),
  )
}

const PARTY_PRESENTATION: Record<
  SupportConversationParty,
  {
    label: string
    icon: typeof UserRound
    className: string
  }
> = {
  CUSTOMER: {
    label: "Customer",
    icon: UserRound,
    className:
      "border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200",
  },
  PUBLISHER: {
    label: "Publisher",
    icon: Building2,
    className:
      "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950/70 dark:text-sky-200",
  },
  SUPPORT: {
    label: "GuestPost Support",
    icon: Headphones,
    className:
      "border-indigo-300 bg-indigo-100 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-200",
  },
  SYSTEM: {
    label: "System",
    icon: Bot,
    className: "border-border bg-muted text-muted-foreground",
  },
}

function roleLabel(role: string | null | undefined): string | null {
  if (!role) return null
  const labels: Record<string, string> = {
    CUSTOMER: "Customer",
    PUBLISHER: "Publisher",
    OPS: "Operations",
    ADMIN: "Admin",
    FINANCE: "Finance",
  }
  return labels[role] ?? role.replaceAll("_", " ").toLowerCase()
}

export function SupportParticipantBadge({
  party,
  participantRole,
  showRoleDetails = false,
  className,
}: {
  party: SupportConversationParty
  participantRole?: string | null
  showRoleDetails?: boolean
  className?: string
}) {
  const presentation = PARTY_PRESENTATION[party]
  const Icon = presentation.icon
  const detail = showRoleDetails ? roleLabel(participantRole) : null
  const label =
    detail && detail !== presentation.label
      ? `${presentation.label} · ${detail}`
      : presentation.label

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        presentation.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  )
}

function parseMessageTime(value: string): {
  dateTime?: string
  label: string
} {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { label: "Time unavailable" }
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  }
}

export function SupportSystemEvent({
  message,
}: {
  message: SupportConversationMessage
}) {
  const time = parseMessageTime(message.createdAt)
  return (
    <li className="flex w-full justify-center">
      <article
        className="max-w-full rounded-full border border-dashed bg-muted/50 px-3 py-2 text-center text-xs text-muted-foreground"
        aria-label={`System event: ${message.content}`}
      >
        <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <SupportParticipantBadge party="SYSTEM" />
          <span
            dir="auto"
            className="min-w-0 break-words [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
          >
            {message.content}
          </span>
          {time.dateTime ? (
            <time dateTime={time.dateTime}>{time.label}</time>
          ) : (
            <span>{time.label}</span>
          )}
        </span>
      </article>
    </li>
  )
}

export function SupportMessage({
  message,
  showRoleDetails = false,
}: {
  message: SupportConversationMessage
  showRoleDetails?: boolean
}) {
  const isInternal =
    message.visibility === "INTERNAL" || message.messageType === "INTERNAL_NOTE"
  const senderName = message.sender.isSelf
    ? "You"
    : message.sender.displayName ||
      PARTY_PRESENTATION[message.sender.party].label
  const time = parseMessageTime(message.createdAt)

  return (
    <li
      className={cn(
        "flex w-full",
        message.sender.isSelf ? "justify-end" : "justify-start",
      )}
      data-message-side={message.sender.isSelf ? "outgoing" : "incoming"}
    >
      <article
        className={cn(
          "min-w-0 max-w-[92%] rounded-2xl border px-4 py-3 shadow-sm sm:max-w-[82%] lg:max-w-[72%]",
          isInternal
            ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
            : message.sender.isSelf
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-card-foreground",
        )}
        aria-label={`${isInternal ? "Internal note" : "Message"} from ${senderName}`}
      >
        <header className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 text-sm font-semibold">
            <bdi className="break-words [overflow-wrap:anywhere]">
              {senderName}
            </bdi>
          </span>
          <SupportParticipantBadge
            party={message.sender.party}
            participantRole={message.participantRole}
            showRoleDetails={showRoleDetails}
            className={cn(
              message.sender.isSelf &&
                !isInternal &&
                "border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground",
            )}
          />
          {isInternal && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:border-amber-700 dark:bg-amber-900/60 dark:text-amber-100">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
              Internal · staff only
            </span>
          )}
        </header>
        <p
          dir="auto"
          className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
        >
          {message.content}
        </p>
        <footer
          className={cn(
            "mt-2 text-[11px]",
            message.sender.isSelf && !isInternal
              ? "text-primary-foreground/80"
              : "text-muted-foreground",
          )}
        >
          {time.dateTime ? (
            <time dateTime={time.dateTime}>{time.label}</time>
          ) : (
            <span>{time.label}</span>
          )}
        </footer>
      </article>
    </li>
  )
}

export function SupportConversation({
  messages,
  isLoading = false,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  onLoadOlderMessages,
  olderMessagesError,
  label = "Support conversation",
  emptyMessage = "No messages yet.",
  showRoleDetails = false,
  className,
}: SupportConversationProps) {
  if (isLoading) {
    return (
      <div className={cn("space-y-4", className)} aria-busy="true">
        <Skeleton className="h-24 w-4/5 rounded-2xl" />
        <Skeleton className="ml-auto h-24 w-3/4 rounded-2xl" />
        <span className="sr-only">Loading support conversation</span>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <p
        className={cn(
          "py-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyMessage}
      </p>
    )
  }

  return (
    <div className={cn("space-y-4", className)}>
      {(hasOlderMessages || olderMessagesError) && (
        <div className="flex flex-col items-center gap-2" aria-live="polite">
          {hasOlderMessages && onLoadOlderMessages && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadOlderMessages}
              disabled={isLoadingOlderMessages}
            >
              {isLoadingOlderMessages && (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {isLoadingOlderMessages
                ? "Loading older…"
                : "Load older messages"}
            </Button>
          )}
          {olderMessagesError && (
            <p role="alert" className="text-center text-sm text-destructive">
              {olderMessagesError}
            </p>
          )}
        </div>
      )}
      <ol aria-label={label} className="space-y-4">
        {messages.map((message) =>
          message.messageType === "SYSTEM_EVENT" ||
          message.sender.party === "SYSTEM" ? (
            <SupportSystemEvent key={message.id} message={message} />
          ) : (
            <SupportMessage
              key={message.id}
              message={message}
              showRoleDetails={showRoleDetails}
            />
          ),
        )}
      </ol>
    </div>
  )
}

export interface SupportComposerProps {
  content: string
  onContentChange: (content: string) => void
  onSubmit: () => void
  visibility?: SupportConversationVisibility
  onVisibilityChange?: (visibility: SupportConversationVisibility) => void
  allowedVisibilities?: readonly SupportConversationVisibility[]
  isPending?: boolean
  disabled?: boolean
  disabledReason?: string | null
  error?: string | null
  maxLength?: number
  publicPlaceholder?: string
  internalPlaceholder?: string
  className?: string
}

export function SupportComposer({
  content,
  onContentChange,
  onSubmit,
  visibility = "PUBLIC",
  onVisibilityChange,
  allowedVisibilities = ["PUBLIC"],
  isPending = false,
  disabled = false,
  disabledReason,
  error,
  maxLength = 10_000,
  publicPlaceholder = "Write a reply…",
  internalPlaceholder = "Write an internal note for staff…",
  className,
}: SupportComposerProps) {
  const id = useId()
  const textareaId = `${id}-message`
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const visibilityName = `${id}-visibility`
  const trimmedLength = content.trim().length
  const selectedVisibility = allowedVisibilities.includes(visibility)
    ? visibility
    : (allowedVisibilities[0] ?? "PUBLIC")
  const isDisabled = disabled || isPending || allowedVisibilities.length === 0

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isDisabled || trimmedLength === 0 || content.length > maxLength) return
    onSubmit()
  }

  return (
    <form
      onSubmit={submit}
      className={cn("space-y-4", className)}
      aria-busy={isPending}
      aria-label="Support reply"
    >
      {allowedVisibilities.length > 1 && onVisibilityChange && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Message visibility</legend>
          <div className="flex flex-wrap gap-2">
            {allowedVisibilities.map((option) => {
              const internal = option === "INTERNAL"
              return (
                <label key={option} className="cursor-pointer">
                  <input
                    type="radio"
                    name={visibilityName}
                    value={option}
                    checked={selectedVisibility === option}
                    onChange={() => onVisibilityChange(option)}
                    disabled={isDisabled}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
                      internal
                        ? "border-amber-300 text-amber-900 peer-checked:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:peer-checked:bg-amber-950"
                        : "peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground",
                    )}
                  >
                    {internal ? (
                      <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {internal ? "Internal note" : "Public reply"}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )}

      <div className="space-y-2">
        <label htmlFor={textareaId} className="text-sm font-medium">
          {selectedVisibility === "INTERNAL" ? "Internal note" : "Reply"}
        </label>
        <Textarea
          id={textareaId}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          rows={5}
          maxLength={maxLength}
          disabled={isDisabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          placeholder={
            selectedVisibility === "INTERNAL"
              ? internalPlaceholder
              : publicPlaceholder
          }
          dir="auto"
          className="min-h-28 resize-y [unicode-bidi:plaintext]"
        />
        <div
          id={helpId}
          className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between"
        >
          <span>
            {selectedVisibility === "INTERNAL"
              ? "Internal notes are visible only to authorized staff."
              : "Never include passwords, API keys, full card details, or payout credentials."}
          </span>
          <span className="shrink-0 tabular-nums">
            {content.length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {disabledReason && (
          <p className="text-sm text-muted-foreground">{disabledReason}</p>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={
            isDisabled || trimmedLength === 0 || content.length > maxLength
          }
        >
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : selectedVisibility === "INTERNAL" ? (
            <LockKeyhole className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Send className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {isPending
            ? "Sending…"
            : selectedVisibility === "INTERNAL"
              ? "Add internal note"
              : "Send reply"}
        </Button>
      </div>
    </form>
  )
}
