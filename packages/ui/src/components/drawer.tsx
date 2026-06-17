"use client"

/**
 * Phase 7.6.1 / 7.9 — mobile slide-in drawer built on Radix Dialog.
 *
 * Background. Phase 7.6 shipped a translate-x sidebar drawer across
 * the admin/publisher dashboards (and inherited it from portal). All
 * three drawers were missing escape-to-close, focus trap,
 * body-scroll-lock, and ARIA dialog semantics — keyboard + screen-reader
 * users had a degraded experience. Phase 7.6.1 (deferred into 7.9) ships
 * a single `<Drawer>` component to replace the hand-rolled `<aside>` +
 * backdrop pattern.
 *
 * What this component gives the consumer for free (via Radix Dialog):
 *   - `role="dialog"` + `aria-modal="true"` on content
 *   - focus trap inside content while open; focus restored to trigger on close
 *   - Escape-key close
 *   - body scroll-lock (Radix's Overlay sets overflow:hidden on <body>)
 *   - inert background (siblings get aria-hidden)
 *
 * What it does NOT do (deliberate):
 *   - Pathname-auto-close. That's framework-coupled (Next's
 *     `usePathname`) and belongs in the layout that uses the drawer,
 *     not in the framework-agnostic UI package. Layouts call
 *     `setOpen(false)` from a `useEffect([pathname])`.
 *
 * Usage (controlled mode — the only mode used today):
 *   const [open, setOpen] = useState(false)
 *   const pathname = usePathname()
 *   useEffect(() => setOpen(false), [pathname])
 *   <Drawer open={open} onOpenChange={setOpen}>
 *     <DrawerContent side="left">
 *       <DrawerTitle className="sr-only">Navigation</DrawerTitle>
 *       <SidebarContents />
 *     </DrawerContent>
 *   </Drawer>
 *
 * A visually-hidden `<DrawerTitle>` is REQUIRED inside `<DrawerContent>`
 * — Radix logs an accessibility warning without it. The spec covers
 * this.
 */

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "../lib/utils"

const Drawer = DialogPrimitive.Root
const DrawerTrigger = DialogPrimitive.Trigger
const DrawerPortal = DialogPrimitive.Portal
const DrawerClose = DialogPrimitive.Close

const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Mobile-only — desktop sidebar stays a static <aside>.
      "fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
))
DrawerOverlay.displayName = "DrawerOverlay"

interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Which edge of the screen the drawer slides in from. Defaults to "left". */
  side?: "left" | "right"
}

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DrawerContentProps
>(({ side = "left", className, children, ...props }, ref) => (
  <DrawerPortal>
    <DrawerOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Mobile-only positioning.
        "fixed inset-y-0 z-50 flex h-full w-64 flex-col bg-card lg:hidden",
        "transition-transform duration-200 ease-in-out",
        side === "left"
          ? "left-0 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          : "right-0 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DrawerPortal>
))
DrawerContent.displayName = "DrawerContent"

// Re-export DialogPrimitive.Title under a Drawer-flavored name. Layouts
// should render `<DrawerTitle className="sr-only">Navigation</DrawerTitle>`
// inside their `<DrawerContent>` to satisfy Radix's a11y requirement
// without affecting visual design.
const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
DrawerTitle.displayName = "DrawerTitle"

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerClose,
  DrawerOverlay,
  DrawerContent,
  DrawerTitle,
}
