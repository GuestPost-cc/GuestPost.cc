import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  mergeSupportConversationMessages,
  mergeSupportConversationPages,
  SupportComposer,
  SupportConversation,
  type SupportConversationMessage,
} from "../support-conversation"

const createdAt = "2026-08-14T10:30:00.000Z"

function message(
  overrides: Partial<SupportConversationMessage> = {},
): SupportConversationMessage {
  return {
    id: "message-1",
    content: "A plain-text support reply",
    visibility: "PUBLIC",
    messageType: "MESSAGE",
    participantRole: "CUSTOMER",
    createdAt,
    sender: {
      party: "CUSTOMER",
      displayName: "Customer organization",
      isSelf: false,
    },
    ...overrides,
  }
}

describe("SupportConversation", () => {
  it("aligns only the exact viewer's message as outgoing", () => {
    render(
      <SupportConversation
        messages={[
          message({
            id: "mine",
            sender: {
              party: "PUBLISHER",
              displayName: "Publisher member",
              isSelf: true,
            },
          }),
          message({
            id: "colleague",
            sender: {
              party: "PUBLISHER",
              displayName: "Publisher colleague",
              isSelf: false,
            },
          }),
        ]}
      />,
    )

    expect(
      screen.getByRole("article", { name: "Message from You" }).parentElement,
    ).toHaveAttribute("data-message-side", "outgoing")
    expect(
      screen.getByRole("article", { name: "Message from Publisher colleague" })
        .parentElement,
    ).toHaveAttribute("data-message-side", "incoming")
    expect(screen.getAllByText("Publisher")).toHaveLength(2)
  })

  it("keeps customer and publisher identities visibly distinct", () => {
    render(
      <SupportConversation
        messages={[
          message(),
          message({
            id: "publisher",
            sender: {
              party: "PUBLISHER",
              displayName: "Example Publisher",
              isSelf: false,
            },
          }),
        ]}
      />,
    )

    expect(screen.getByText("Customer organization")).toBeInTheDocument()
    expect(screen.getByText("Customer")).toBeInTheDocument()
    expect(screen.getByText("Example Publisher")).toBeInTheDocument()
    expect(screen.getByText("Publisher")).toBeInTheDocument()
  })

  it("renders internal notes and system events with distinct semantics", () => {
    render(
      <SupportConversation
        showRoleDetails
        messages={[
          message({
            id: "internal",
            content: "Investigate before replying",
            visibility: "INTERNAL",
            messageType: "INTERNAL_NOTE",
            participantRole: "FINANCE",
            sender: {
              party: "SUPPORT",
              displayName: "Finance reviewer",
              isSelf: false,
            },
          }),
          message({
            id: "system",
            content: "Ticket reopened",
            messageType: "SYSTEM_EVENT",
            participantRole: null,
            sender: {
              party: "SYSTEM",
              displayName: "System",
              isSelf: false,
            },
          }),
        ]}
      />,
    )

    expect(
      screen.getByRole("article", {
        name: "Internal note from Finance reviewer",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("Internal · staff only")).toBeInTheDocument()
    expect(screen.getByText("GuestPost Support · Finance")).toBeInTheDocument()
    expect(
      screen.getByRole("article", { name: "System event: Ticket reopened" }),
    ).toBeInTheDocument()
  })

  it("uses semantic chronology, machine-readable time, and safe text direction", () => {
    render(
      <SupportConversation
        messages={[
          message({ content: "مرحبا — https://example.test/very-long-path" }),
        ]}
      />,
    )

    const conversation = screen.getByRole("list", {
      name: "Support conversation",
    })
    const article = within(conversation).getByRole("article")
    expect(article.querySelector("time")).toHaveAttribute("datetime", createdAt)
    expect(article.querySelector("p")).toHaveAttribute("dir", "auto")
    expect(article.querySelector("bdi")).toHaveTextContent(
      "Customer organization",
    )
  })

  it("renders loading and empty states", () => {
    const { rerender } = render(<SupportConversation messages={[]} isLoading />)
    expect(screen.getByText("Loading support conversation")).toBeInTheDocument()

    rerender(
      <SupportConversation
        messages={[]}
        emptyMessage="No public replies yet."
      />,
    )
    expect(screen.getByText("No public replies yet.")).toBeInTheDocument()
  })

  it("loads older history with an accessible pending and error state", async () => {
    const user = userEvent.setup()
    const onLoadOlderMessages = vi.fn()
    const { rerender } = render(
      <SupportConversation
        messages={[message()]}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: "Load older messages" }),
    )
    expect(onLoadOlderMessages).toHaveBeenCalledOnce()

    rerender(
      <SupportConversation
        messages={[message()]}
        hasOlderMessages
        isLoadingOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
        olderMessagesError="Older messages could not be loaded."
      />,
    )
    expect(
      screen.getByRole("button", { name: "Loading older…" }),
    ).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Older messages could not be loaded.",
    )
  })

  it("merges overlapping cursor pages in chronological order", () => {
    const newest = message({
      id: "newest",
      createdAt: "2026-08-14T12:00:00.000Z",
    })
    const overlap = message({
      id: "overlap",
      createdAt: "2026-08-14T11:00:00.000Z",
      content: "Current projection",
    })
    const older = message({
      id: "older",
      createdAt: "2026-08-14T09:00:00.000Z",
    })

    expect(
      mergeSupportConversationMessages(
        [older, { ...overlap, content: "Stale projection" }],
        [overlap, newest],
      ).map(({ id, content }) => ({ id, content })),
    ).toEqual([
      { id: "older", content: "A plain-text support reply" },
      { id: "overlap", content: "Current projection" },
      { id: "newest", content: "A plain-text support reply" },
    ])
  })

  it("keeps the displaced page-boundary message after the newest page refetches", () => {
    const pageSize = 200
    const makeRange = (start: number, end: number) =>
      Array.from({ length: end - start + 1 }, (_, offset) => {
        const sequence = start + offset
        return message({
          id: `message-${sequence.toString().padStart(4, "0")}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
        })
      })

    // A new message shifted message 202 from the newest page into the next
    // page. A cursor chain refetch must reload that page from its new cursor;
    // retaining the old page separately would leave a gap at message 202.
    const merged = mergeSupportConversationPages([
      { messages: makeRange(203, 402) },
      { messages: makeRange(3, 202) },
    ])
    const sequences = merged.map((entry) => Number(entry.id.slice(-4)))

    expect(merged).toHaveLength(pageSize * 2)
    expect(sequences[0]).toBe(3)
    expect(sequences.at(-1)).toBe(402)
    expect(sequences).toContain(202)
    expect(
      sequences.every(
        (sequence, index) =>
          index === 0 || sequence === sequences[index - 1] + 1,
      ),
    ).toBe(true)
  })
})

describe("SupportComposer", () => {
  it("submits trimmed non-empty content and exposes native visibility radios", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onVisibilityChange = vi.fn()
    const onContentChange = vi.fn()
    render(
      <SupportComposer
        content="Ready to send"
        onContentChange={onContentChange}
        onSubmit={onSubmit}
        visibility="PUBLIC"
        onVisibilityChange={onVisibilityChange}
        allowedVisibilities={["PUBLIC", "INTERNAL"]}
      />,
    )

    expect(screen.getByRole("radio", { name: "Public reply" })).toBeChecked()
    await user.click(screen.getByRole("radio", { name: "Internal note" }))
    expect(onVisibilityChange).toHaveBeenCalledWith("INTERNAL")
    await user.click(screen.getByRole("button", { name: "Send reply" }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it("associates inline errors and disables read-only conversations", () => {
    render(
      <SupportComposer
        content="Draft"
        onContentChange={() => {}}
        onSubmit={() => {}}
        disabled
        disabledReason="This ticket is closed. Reopen it to reply."
        error="The reply could not be sent."
      />,
    )

    const textbox = screen.getByRole("textbox", { name: "Reply" })
    expect(textbox).toBeDisabled()
    expect(textbox).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The reply could not be sent.",
    )
    expect(
      screen.getByText("This ticket is closed. Reopen it to reply."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled()
  })

  it("shows a character limit and pending state", () => {
    render(
      <SupportComposer
        content="12345"
        onContentChange={() => {}}
        onSubmit={() => {}}
        maxLength={10}
        isPending
      />,
    )

    expect(screen.getByText("5 / 10")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled()
    expect(screen.getByRole("form")).toHaveAttribute("aria-busy", "true")
  })
})
