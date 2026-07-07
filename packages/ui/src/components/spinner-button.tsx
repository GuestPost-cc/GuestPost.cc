import { Loader2 } from "lucide-react"
import * as React from "react"
import { Button, type ButtonProps } from "./button"

export interface SpinnerButtonProps extends ButtonProps {
  loading?: boolean
}

const SpinnerButton = React.forwardRef<HTMLButtonElement, SpinnerButtonProps>(
  ({ loading, disabled, children, ...props }, ref) => {
    return (
      <Button ref={ref} disabled={disabled || loading} {...props}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {children}
      </Button>
    )
  },
)
SpinnerButton.displayName = "SpinnerButton"

export { SpinnerButton }
