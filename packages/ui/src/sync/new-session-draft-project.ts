type NewDraftProjectInput<T extends { id: string }> = {
  projects: readonly T[]
  explicitProjectId?: string | null
  defaultProjectId?: string | null
  activeProjectId?: string | null
}

export const resolveNewDraftProject = <T extends { id: string }>(input: NewDraftProjectInput<T>): T | null => {
  const findProject = (id: string | null | undefined): T | null =>
    id ? input.projects.find((project) => project.id === id) ?? null : null
  return findProject(input.explicitProjectId)
    ?? findProject(input.defaultProjectId)
    ?? findProject(input.activeProjectId)
    ?? input.projects[0]
    ?? null
}
