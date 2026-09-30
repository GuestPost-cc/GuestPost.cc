"use client"

import { useEffect, useState } from "react"

export function GlobalLoadingBar({ active }: { active: boolean }) {
  if (!active) return null

  return <DelayedLoadingBar />
}

function DelayedLoadingBar() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setVisible(true), 150)
    return () => window.clearTimeout(timeoutId)
  }, [])

  if (!visible) return null

  return (
    <div
      aria-label="Loading"
      aria-valuetext="Loading"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
      role="progressbar"
    >
      <div className="global-loading-bar__segment h-full bg-primary" />
    </div>
  )
}
