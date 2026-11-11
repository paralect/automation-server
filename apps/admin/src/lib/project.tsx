import { createContext, useContext } from "react"

import type { Project } from "./api.functions"

type ProjectContextValue = {
  /** The selected project. Every project-scoped query and mutation uses its id. */
  project: Project
  projects: Project[]
  select(id: string): void
}

export const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProjects(): ProjectContextValue {
  const value = useContext(ProjectContext)
  if (!value) throw new Error("useProjects must be used inside the authed layout")
  return value
}

/** Id of the selected project. */
export const useProjectId = () => useProjects().project.id
