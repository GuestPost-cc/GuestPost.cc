"use client"

import { Check, ChevronsUpDown } from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

export interface MultiSelectOption {
  value: string
  label: string
}

export interface MultiSelectProps {
  options: readonly MultiSelectOption[]
  value: readonly string[]
  onValueChange: (value: string[]) => void
  maxSelected?: number
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}

export function MultiSelect({
  options,
  value,
  onValueChange,
  maxSelected,
  placeholder = "Select options",
  searchPlaceholder = "Search...",
  emptyText = "No options found.",
  disabled,
  className,
  ariaLabel,
}: MultiSelectProps) {
  const selected = new Set(value)
  const selectedLabels = options
    .filter((option) => selected.has(option.value))
    .map((option) => option.label)
  const atLimit = maxSelected !== undefined && value.length >= maxSelected
  const summary =
    selectedLabels.length === 0
      ? placeholder
      : selectedLabels.length <= 2
        ? selectedLabels.join(", ")
        : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2}`

  const toggle = (optionValue: string) => {
    if (selected.has(optionValue)) {
      onValueChange(value.filter((candidate) => candidate !== optionValue))
      return
    }
    if (atLimit) return
    onValueChange([...value, optionValue])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span
            className={cn(
              "min-w-0 truncate text-left",
              selectedLabels.length === 0 && "text-muted-foreground",
            )}
          >
            {summary}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList role="listbox" aria-multiselectable="true">
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => {
              const isSelected = selected.has(option.value)
              const selectionDisabled = !isSelected && atLimit
              return (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  disabled={selectionDisabled}
                  aria-selected={isSelected}
                  onSelect={() => toggle(option.value)}
                >
                  <span
                    className={cn(
                      "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40",
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
          {maxSelected !== undefined && (
            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              {value.length}/{maxSelected} selected
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
