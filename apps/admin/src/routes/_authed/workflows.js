import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { installWorkflow, } from "@/lib/api.functions";
import { errorText } from "@/lib/errors";
import { settingsQuery, workflowStatusQuery, workflowTemplatesQuery } from "@/lib/queries";
import { useProjectId } from "@/lib/project";
export const Route = createFileRoute("/_authed/workflows")({
    validateSearch: z.object({ repo: z.string().optional() }),
    component: Workflows,
});
const INSTALL_MODES = ["pr", "direct"];
const MODES = { pr: "Pull request", direct: "Direct commit" };
const OUTCOME_COPY = {
    "pr-opened": "Pull request opened",
    "pr-exists": "Install pull request already open",
    committed: "Committed to the default branch",
    "already-installed": "Already installed",
};
const STATE_BADGE = {
    installed: { label: "Installed", variant: "secondary" },
    differs: { label: "Update available", variant: "default" },
    missing: { label: "Not installed", variant: "outline" },
};
function configuredRepos(integrations) {
    const value = (id, key) => integrations.find((i) => i.id === id)?.fields.find((f) => f.key === key)?.value;
    const repos = [value("github", "repo"), value("github", "actionsRepos"), value("linear", "targetRepo")].flat();
    return [...new Set(repos.filter((r) => typeof r === "string" && r.includes("/")))];
}
function Workflows() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const [mode, setMode] = useState("pr");
    const project = useProjectId();
    const settings = useQuery(settingsQuery(project));
    const templates = useQuery(workflowTemplatesQuery());
    const repos = settings.data ? configuredRepos(settings.data.integrations) : [];
    const repo = search.repo && repos.includes(search.repo) ? search.repo : repos[0];
    const status = useQuery({ ...workflowStatusQuery(project, repo ?? ""), enabled: repo !== undefined });
    const statuses = new Map(status.data?.templates.map((t) => [t.templateId, t]));
    const error = settings.error ?? templates.error;
    return (<>
      <PageHeader title="Workflows" description="Add the bundled GitHub Actions workflows to a repository.">
        <ToggleGroup value={[mode]} onValueChange={(next) => {
            const picked = INSTALL_MODES.find((m) => m === next[0]);
            if (picked)
                setMode(picked);
        }} variant="outline" aria-label="Install mode">
          {INSTALL_MODES.map((key) => (<ToggleGroupItem key={key} value={key}>
              {MODES[key]}
            </ToggleGroupItem>))}
        </ToggleGroup>
      </PageHeader>

      {error ? (<QueryError error={error} onRetry={() => {
                void settings.refetch();
                void templates.refetch();
            }}/>) : !settings.data || !templates.data ? (<RowsSkeleton rows={4}/>) : !repo ? (<EmptyState title="No repository configured" hint="Add a repository to the GitHub integration on the Integrations page first."/>) : (<>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={repo} onValueChange={(next) => next && navigate({ search: { repo: next }, replace: true })}>
              <SelectTrigger aria-label="Repository" className="min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repos.map((option) => (<SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>))}
              </SelectContent>
            </Select>
            {status.error ? <FieldError>{errorText(status.error)}</FieldError> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === "pr"
                ? "Installs open a pull request on a new branch."
                : `Installs commit straight to ${status.data?.defaultBranch ?? "the default branch"}.`}{" "}
            The GitHub token needs Contents, Pull requests and Workflows write access.{" "}
            <Link to="/integrations" className="underline underline-offset-4">
              GitHub settings
            </Link>
          </p>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-full min-w-72">Workflow</TableHead>
                  <TableHead>Repository needs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Install</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.data.map((template) => (<TemplateRow key={`${repo}:${template.id}`} template={template} repo={repo} mode={mode} status={statuses.get(template.id)}/>))}
              </TableBody>
            </Table>
          </div>
        </>)}
    </>);
}
function TemplateRow({ template, repo, mode, status, }) {
    const queryClient = useQueryClient();
    const project = useProjectId();
    const install = useMutation({
        mutationFn: () => installWorkflow({ data: { project, repo, templateId: template.id, mode } }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: workflowStatusQuery(project, repo).queryKey }),
    });
    const needs = [
        ...template.requiredSecrets.map((names) => names.join(" or ")),
        ...template.requiredVariables.map((v) => `${v} (variable)`),
    ];
    const pullRequest = install.data?.pullRequest ?? status?.pullRequest;
    return (<TableRow>
      <TableCell className="max-w-0 align-top whitespace-normal">
        <p className="font-medium">{template.title}</p>
        <p className="text-xs text-muted-foreground">{template.description}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={template.path}>
          {template.path}
        </p>
      </TableCell>
      <TableCell className="align-top">
        {needs.length === 0 ? (<span className="text-xs text-muted-foreground">Nothing</span>) : (<ul className="flex max-w-64 flex-wrap gap-1">
            {needs.map((name) => (<li key={name}>
                <Badge variant="outline" className="font-mono">
                  {name}
                </Badge>
              </li>))}
          </ul>)}
      </TableCell>
      <TableCell className="align-top">
        {status ? (<div className="flex flex-col items-start gap-1">
            <Badge variant={STATE_BADGE[status.state].variant}>{STATE_BADGE[status.state].label}</Badge>
            {status.state === "differs" && status.changedFiles.length > 0 && (<span className="font-mono text-xs text-muted-foreground" title={status.changedFiles.join("\n")}>
                {status.changedFiles.length} changed
              </span>)}
          </div>) : (<span className="text-xs text-muted-foreground">-</span>)}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" onClick={() => install.mutate()} disabled={install.isPending}>
            {install.isPending ? "Installing..." : status?.state === "differs" ? "Update" : "Install"}
          </Button>
          {install.error && <FieldError className="max-w-56 text-right whitespace-normal">{errorText(install.error)}</FieldError>}
          {install.data && (<p role="status" className="text-xs whitespace-nowrap">
              {OUTCOME_COPY[install.data.outcome]}
            </p>)}
          {pullRequest && (<a href={pullRequest.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs whitespace-nowrap underline-offset-4 hover:underline">
              Pull request #{pullRequest.number}
              <ArrowSquareOutIcon className="size-3"/>
            </a>)}
        </div>
      </TableCell>
    </TableRow>);
}
