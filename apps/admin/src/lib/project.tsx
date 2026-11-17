import { createContext, useContext } from "react"

import type { Project } from "./api.functions"

type ProjectContextValue = {
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

export const useProjectId = () => useProjects().project.id
