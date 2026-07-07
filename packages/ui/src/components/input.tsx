import * as React from "react"
import { cn } from "../lib/utils"

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-[#23252a] bg-[#0f1011] px-3 py-2 text-sm text-[#f7f8f8] placeholder:text-[#62666d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5e69d1]/50 focus-visible:border-[#5e69d1] disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        className,
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = "Input"

export { Input }
