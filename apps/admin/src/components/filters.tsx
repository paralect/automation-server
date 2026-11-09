import { useEffect, useState } from "react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ALL = "__all__"

export function EnumFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly T[]
  onChange: (value: T | undefined) => void
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL ? undefined : (next as T))}
    >
      <SelectTrigger aria-label={label} className="w-36">
        <SelectValue>{(v: string) => (v === ALL ? `Any ${label.toLowerCase()}` : v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`Any ${label.toLowerCase()}`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TextFilter({
  label,
  value,
  suggestions,
  onChange,
  className,
}: {
  label: string
  value: string | undefined
  suggestions?: readonly string[]
  onChange: (value: string | undefined) => void
  className?: string
}) {
  const [draft, setDraft] = useState(value ?? "")
  const listId = suggestions ? `${label}-suggestions` : undefined

  useEffect(() => setDraft(value ?? ""), [value])
  useEffect(() => {
    const next = draft.trim() || undefined
    if (next === value) return
    const timer = setTimeout(() => onChange(next), 350)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])

  return (
    <>
      <Input
        aria-label={label}
        placeholder={label}
        value={draft}
        list={listId}
        onChange={(event) => setDraft(event.target.value)}
        className={className ?? "w-40"}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions?.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </>
  )
}
