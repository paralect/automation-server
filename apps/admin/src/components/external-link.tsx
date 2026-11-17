import type { ReactNode } from "react"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
      {children}
      <ArrowSquareOutIcon className="size-3" aria-hidden />
    </a>
  )
}
