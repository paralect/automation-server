import { useState } from "react"
import { cn } from "cn"

import type { Project } from "@/lib/api.functions"

const COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-600",
  "bg-emerald-600",
  "bg-teal-600",
  "bg-sky-600",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-pink-500",
]

const colorOf = (id: string) => COLORS[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLORS.length]

/** The site's favicon when the project has a domain, otherwise its first letter on a color picked from the id. */
export function ProjectIcon({ project, className }: { project: Pick<Project, "id" | "name" | "domain">; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const { domain } = project
  const box = cn("flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]", className)

  if (domain && failed !== domain) {
    return (
      <span className={box}>
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
          alt=""
          className="size-full object-contain"
          onError={() => setFailed(domain)}
        />
      </span>
    )
  }
  return (
    <span className={cn(box, colorOf(project.id), "text-[0.65em] font-semibold text-white! uppercase")} aria-hidden>
      {project.name.trim().charAt(0) || "?"}
    </span>
  )
}
