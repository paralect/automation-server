import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { installWorkflow, type InstallMode, type PullRequestRef, type WorkflowCheck } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { REPO_RE, secretsUrl, type LinkedTemplate } from "@/lib/integration-workflows"
import { useProjectId } from "@/lib/project"
import { workflowCheckQuery } from "@/lib/queries"

type View =
  | { kind: "no-github" }
  | { kind: "no-repo" }
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "installed"; branch: string }
  | { kind: "pr-open"; pullRequest: PullRequestRef; branch: string }
  | { kind: "not-installed"; outdated: boolean; branch: string }

function viewOf(githubReady: boolean, repo: string | undefined, check: { data?: WorkflowCheck; error: unknown }): View {
  if (!githubReady) return { kind: "no-github" }
  if (!repo) return { kind: "no-repo" }
  if (check.error) return { kind: "error", message: errorText(check.error) }
  if (!check.data) return { kind: "checking" }
  const { template, defaultBranch: branch } = check.data
  if (template.state === "installed") return { kind: "installed", branch }
  if (template.pullRequest) return { kind: "pr-open", pullRequest: template.pullRequest, branch }
  return { kind: "not-installed", outdated: template.state === "differs", branch }
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * Checks whether the workflow an integration relies on is in its repository, and installs it when it is not.
 * `repo` may be a value the operator is still typing, so the check waits for a valid owner/name to settle.
 */
export function IntegrationWorkflow({
  template,
  repo: typedRepo,
  repoLabel,
  githubReady,
}: {
  template: LinkedTemplate
  repo: string | undefined
  repoLabel: string
  githubReady: boolean
}) {
  const project = useProjectId()
  const queryClient = useQueryClient()
  const trimmed = typedRepo?.trim()
  const repo = useDebounced(trimmed && REPO_RE.test(trimmed) ? trimmed : undefined, 500)
  const check = useQuery({
    ...workflowCheckQuery(project, repo ?? "", template.id),
    enabled: githubReady && repo !== undefined,
  })
  const install = useMutation({
    mutationFn: (mode: InstallMode) => installWorkflow({ data: { project, repo: repo ?? "", templateId: template.id, mode } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [project, "workflow-status", repo] }),
  })

  const view = viewOf(githubReady, repo, check)
  const secrets = template.requiredSecrets.map((names) => names.join(" or "))

  return (
    <section aria-label="GitHub workflow" className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">GitHub workflow</span>
        <Badge variant="outline" className="font-mono">
          {template.path.split("/").pop()}
        </Badge>
        <Badge variant={template.integration.required ? "secondary" : "outline"}>
          {template.integration.required ? "Required" : "Optional"}
        </Badge>
        {repo && githubReady && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Check again"
            title="Check again"
            onClick={() => void check.refetch()}
            disabled={check.isFetching}
          >
            <ArrowClockwiseIcon className={check.isFetching ? "animate-spin" : undefined} />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{template.description}</p>

      {view.kind === "no-github" && (
        <p className="text-xs">
          Connect GitHub first, the check and the install use its token.{" "}
          <Link to="/integrations/$id" params={{ id: "github" }} className="underline underline-offset-4">
            Set up GitHub
          </Link>
        </p>
      )}
      {view.kind === "no-repo" && (
        <p className="text-xs text-muted-foreground">Set {repoLabel} as owner/name to check the repository.</p>
      )}
      {view.kind === "checking" && <Skeleton className="h-5 w-64" aria-label="Checking the repository" />}
      {view.kind === "error" && <FieldError>{view.message}</FieldError>}
      {view.kind === "installed" && (
        <p role="status" className="flex items-center gap-1.5 text-xs">
          <CheckCircleIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          Installed in {repo} on {view.branch}. Nothing to do.
        </p>
      )}
      {view.kind === "pr-open" && (
        <p role="status" className="flex flex-wrap items-center gap-1.5 text-xs">
          <GitPullRequestIcon className="size-3.5 shrink-0" />
          The install pull request is open. Merge it into {view.branch} to finish.
          <ExternalLink href={view.pullRequest.url}>Pull request #{view.pullRequest.number}</ExternalLink>
        </p>
      )}
      {view.kind === "not-installed" && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs">
            <WarningCircleIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            {view.outdated
              ? `${repo} has an older version of this workflow.`
              : `${repo} does not have this workflow yet.`}{" "}
            {template.integration.required && !view.outdated && "The integration cannot run without it."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => install.mutate("pr")} disabled={install.isPending}>
              <GitPullRequestIcon />
              {install.isPending && install.variables === "pr" ? "Opening..." : "Install with a pull request"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (window.confirm(`Commit ${template.files.length} files straight to ${view.branch} in ${repo}?`)) {
                  install.mutate("direct")
                }
              }}
              disabled={install.isPending}
            >
              {install.isPending && install.variables === "direct" ? "Committing..." : `Commit to ${view.branch}`}
            </Button>
          </div>
        </div>
      )}
      {install.error && <FieldError>{errorText(install.error)}</FieldError>}

      {repo && githubReady && secrets.length > 0 && view.kind !== "error" && (
        <p className="text-xs text-muted-foreground">
          The workflow also needs the repository secret{" "}
          {secrets.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <code className="font-mono text-foreground">{name}</code>
            </span>
          ))}
          . The server cannot see secrets, so add it yourself.{" "}
          <ExternalLink href={secretsUrl(repo)}>Repository secrets</ExternalLink>
        </p>
      )}
    </section>
  )
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-4"
    >
      {children}
      <ArrowSquareOutIcon className="size-3" />
    </a>
  )
}
