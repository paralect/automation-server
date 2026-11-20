import { createContext, useContext } from "react";
export const ProjectContext = createContext(null);
export function useProjects() {
    const value = useContext(ProjectContext);
    if (!value)
        throw new Error("useProjects must be used inside the authed layout");
    return value;
}
export const useProjectId = () => useProjects().project.id;
