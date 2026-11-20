import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CaretDownIcon, CheckIcon, GearSixIcon, WarningIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { IntegrationLogo, StatusBadge } from "@/components/integration-card";
import { ExternalLink } from "@/components/external-link";
import { IntegrationWorkflow } from "@/components/integration-workflow";
import { PageHeader, QueryError, RowsSkeleton } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { actionsSettingsUrl, isGithubReady, secretsUrl } from "@/lib/integration-workflows";
import { neededWorkflows, SERVICE_IDS, stepStatuses } from "@/lib/onboarding";
import { useProjects } from "@/lib/project";
import { settingsQuery, systemQuery, workflowCheckQuery, workflowTemplatesQuery } from "@/lib/queries";
export const Route = createFileRoute("/_authed/setup")({ component: Setup });
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const PERMISSIONS = [
    { name: "Actions", access: "Read and write", why: "Shows workflow runs and starts the Linear workflow." },
    { name: "Contents", access: "Read and write", why: "Writes workflow files when you install one." },
    { name: "Issues", access: "Read and write", why: "Turns Sentry alerts into issues." },
    { name: "Pull requests", access: "Read and write", why: "Opens the pull request that installs a workflow." },
    { name: "Workflows", access: "Read and write", why: "GitHub requires it for files under .github/workflows." },
    { name: "Metadata", access: "Read-only", why: "GitHub adds it to every token." },
];
const STEP_TITLES = {
    token: "Create a GitHub token",
    repository: "Choose the repositories",
    services: "Connect your services",
    workflows: "Install workflows and add secrets",
};
const STEP_ORDER = ["token", "repository", "services", "workflows"];
function Setup() {
    const { project } = useProjects();
    const settings = useQuery(settingsQuery(project.id));
    const templates = useQuery(workflowTemplatesQuery());
    const system = useQuery(systemQuery(project.id));
    const integrations = settings.data?.integrations ?? [];
    const githubReady = isGithubReady(integrations);
    const needed = neededWorkflows(integrations, templates.data);
    const checks = useQueries({
        queries: needed.map((n) => ({
            ...workflowCheckQuery(project.id, n.repo ?? "", n.template.id),
            enabled: githubReady && n.repo !== undefined,
        })),
    });
    const workflowStates = new Map();
    checks.forEach((check, i) => {
        const id = needed[i]?.template.id;
        if (id && check.data)
            workflowStates.set(id, check.data.template.state);
    });
    const statuses = stepStatuses(integrations, needed, workflowStates);
    const firstOpen = STEP_ORDER.find((id) => statuses[id] === "todo") ?? null;
    const [expanded, setExpanded] = useState(undefined);
    const shown = expanded === undefined ? firstOpen : expanded;
    const counted = STEP_ORDER.filter((id) => statuses[id] !== "idle");
    const done = counted.filter((id) => statuses[id] === "done").length;
    const error = settings.error ?? templates.error;
    if (error) {
        return (<QueryError error={error} onRetry={() => {
                void settings.refetch();
                void templates.refetch();
            }}/>);
    }
    return (<>
      <PageHeader title={`Set up ${project.name}`} description="Each project has its own token, repositories and webhooks. Work through these steps once.">
        {settings.data && (<span className="text-xs text-muted-foreground tabular-nums">
            {done} of {counted.length} done
          </span>)}
      </PageHeader>

      {!settings.data ? (<RowsSkeleton rows={4}/>) : (<ol className="flex max-w-3xl flex-col gap-3">
          {!settings.data.secretsWritable && (<Alert>
              <WarningIcon />
              <AlertTitle>Tokens cannot be saved yet</AlertTitle>
              <AlertDescription>
                Set SETTINGS_ENCRYPTION_KEY on the server and restart it. Without it the admin cannot store the GitHub
                token or any other secret.
              </AlertDescription>
            </Alert>)}
          {STEP_ORDER.map((id, index) => (<Step key={id} number={index + 1} title={STEP_TITLES[id]} status={statuses[id]} open={shown === id} onToggle={() => setExpanded(shown === id ? null : id)}>
              {id === "token" && <TokenStep />}
              {id === "repository" && <RepositoryStep />}
              {id === "services" && (<ServicesStep integrations={integrations} webhookUrls={system.data?.webhookUrls ?? {}}/>)}
              {id === "workflows" &&
                    (needed.length === 0 ? (<p className="text-xs text-muted-foreground">
                    Sentry and Linear hand work to Codex through a GitHub Actions workflow. Connect one of them and its
                    workflow shows up here. Other bundled workflows are on the{" "}
                    <Link to="/workflows" className="underline underline-offset-4">
                      Workflows page
                    </Link>
                    .
                  </p>) : (<div className="flex flex-col gap-3">
                    {needed.map((n) => (<div key={n.template.id} className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">For {n.integration.title}</span>
                        <IntegrationWorkflow template={n.template} repo={n.repo} repoLabel={n.template.integration.repoSetting.integration === "github"
                                ? "Issues repository on the GitHub integration"
                                : `Target repository on the ${n.integration.title} integration`} githubReady={githubReady}/>
                      </div>))}
                    <RepositorySettings repos={[...new Set(needed.flatMap((n) => (n.repo ? [n.repo] : [])))]}/>
                  </div>))}
            </Step>))}
        </ol>)}
    </>);
}
function Step({ number, title, status, open, onToggle, children, }) {
    const bodyId = `setup-step-${number}`;
    return (<li className={cn("rounded-xl bg-card ring-1 ring-foreground/10", open && "ring-foreground/20")}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className="flex w-full items-center gap-3 rounded-xl p-4 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums", status === "done" ? "bg-primary text-primary-foreground" : "ring-1 ring-foreground/20")}>
          {status === "done" ? <CheckIcon weight="bold" className="size-3.5"/> : number}
        </span>
        <span className={cn("flex-1 text-sm font-medium", status === "idle" && "text-muted-foreground")}>{title}</span>
        {status === "done" && <Badge variant="secondary">Done</Badge>}
        {status === "idle" && <Badge variant="outline">Nothing yet</Badge>}
        <CaretDownIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}/>
      </button>
      {open && (<div id={bodyId} className="flex flex-col gap-4 px-4 pb-4 sm:pl-14">
          {children}
        </div>)}
    </li>);
}
function Instructions({ start, children }) {
    return <ol start={start} className="flex list-decimal flex-col gap-2 pl-4 text-xs/relaxed marker:text-muted-foreground">{children}</ol>;
}
function OpenIntegration({ id, children }) {
    return (<Button size="sm" variant="outline" className="self-start" nativeButton={false} render={<Link to="/integrations/$id" params={{ id }}/>}>
      <GearSixIcon />
      {children}
    </Button>);
}
function TokenStep() {
    return (<>
      <p className="text-xs/relaxed text-muted-foreground">
        The server acts on GitHub with one fine-grained personal access token per project. It creates issues, reads
        Actions runs, starts workflows and installs workflow files.
      </p>
      <Instructions>
        <li>
          Open GitHub, then Settings, Developer settings, Personal access tokens, Fine-grained tokens, and click
          Generate new token. <ExternalLink href={NEW_TOKEN_URL}>Open the token page</ExternalLink>
        </li>
        <li>
          Set Resource owner to the account or organization that owns the repositories. An organization may have to
          approve the token before it works.
        </li>
        <li>Pick an expiration date you will remember. Automations stop when the token expires.</li>
        <li>Under Repository access, choose Only select repositories and pick every repository this project uses.</li>
        <li>Under Repository permissions, set these:</li>
      </Instructions>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Permission</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="hidden sm:table-cell">Used for</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PERMISSIONS.map((p) => (<TableRow key={p.name}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.access}</TableCell>
                <TableCell className="hidden whitespace-normal text-muted-foreground sm:table-cell">{p.why}</TableCell>
              </TableRow>))}
          </TableBody>
        </Table>
      </div>
      <Instructions start={6}>
        <li>Click Generate token and copy it. GitHub shows it only once.</li>
        <li>Paste it into the Token field of the GitHub integration and click Save.</li>
      </Instructions>
      <OpenIntegration id="github">Open the GitHub integration</OpenIntegration>
    </>);
}
function RepositoryStep() {
    return (<>
      <Instructions>
        <li>
          On the GitHub integration, set Issues repository as owner/name, for example acme/app. Sentry alerts become
          issues there, and the Codex issue fix workflow runs there.
        </li>
        <li>
          Optional: list more repositories under Actions repositories to follow their workflow runs on the GitHub
          Actions page.
        </li>
        <li>Save, then click Test connection. It confirms the token is valid and can see the repository.</li>
      </Instructions>
      <OpenIntegration id="github">Open the GitHub integration</OpenIntegration>
    </>);
}
const GUIDES = {
    sentry: {
        lead: "Turns Sentry issue alerts into GitHub issues.",
        steps: (webhook) => [
            "In Sentry, open Settings, then Developer Settings, and create a new Internal Integration.",
            <>Set Webhook URL to {webhook ? <Code>{webhook}</Code> : "the webhook URL shown on the Sentry integration page"}.</>,
            "Turn on Alert Rule Action and save.",
            "Copy the Client Secret into Client secret on the Sentry integration.",
            "Optional: create a token on the same page with Issue & Event read access and paste it into Auth token. It adds event counts to issues.",
            'Edit an issue alert and add the action "Send a notification via" your integration.',
        ],
    },
    linear: {
        lead: "Adding a label to a Linear issue makes Codex implement it and open a pull request.",
        steps: (webhook) => [
            "In Linear, open Settings, then API, then Webhooks, and create a webhook.",
            <>Set the URL to {webhook ? <Code>{webhook}</Code> : "the webhook URL shown on the Linear integration page"} and select the Issues resource type.</>,
            "Copy the signing secret into Webhook secret on the Linear integration.",
            "Create a label such as codex in Linear and enter the same name as Trigger label.",
            "Set Target repository to the repository that should receive the pull requests.",
        ],
    },
    posthog: {
        lead: "Sends a weekly PostHog report to a Slack channel.",
        steps: () => [
            "In PostHog, open project settings and copy the Project ID.",
            "Open account settings, then Personal API keys, and create a key limited to the project with Query read access.",
            "In Slack, create an app with Incoming Webhooks turned on, add a webhook to the report channel and copy its URL.",
            "Fill in Host, Project ID, Personal API key and Slack webhook URL on the PostHog integration. Use Preview report to try it.",
        ],
    },
    crisp: {
        lead: "Triages Crisp conversations into a private note, a GitHub issue or a Codex fix.",
        steps: (webhook) => [
            "In the Crisp Marketplace, create a plugin, request a production token with conversation read and write scopes, and install the plugin on your website.",
            <>Under Web Hooks, add {webhook ? <Code>{webhook}</Code> : "the webhook URL shown on the Crisp integration page"} for the session:set_segments and session:set_state events.</>,
            "Copy the Website ID, the token identifier and key, and the Web Hooks signing secret into the Crisp integration.",
            "Set an API key on the OpenRouter integration. Triage starts in shadow mode, which only posts private notes.",
            "Add the trigger segment, triage by default, to a conversation to triage it.",
        ],
    },
};
function ServicesStep({ integrations, webhookUrls, }) {
    return (<>
      <p className="text-xs/relaxed text-muted-foreground">Connect at least one. Each one works on its own.</p>
      <div className="flex flex-col gap-2">
        {SERVICE_IDS.map((id) => {
            const integration = integrations.find((i) => i.id === id);
            if (!integration)
                return null;
            const guide = GUIDES[id];
            const webhook = integration.webhookSource ? webhookUrls[integration.webhookSource] : undefined;
            return (<details key={id} className="group rounded-lg ring-1 ring-foreground/10">
              <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <IntegrationLogo id={id} className="size-8 p-1.5"/>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{integration.title}</span>
                  <span className="text-xs text-muted-foreground">{guide.lead}</span>
                </span>
                <StatusBadge integration={integration}/>
                <CaretDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"/>
              </summary>
              <div className="flex flex-col gap-3 px-3 pb-3 sm:pl-14">
                <Instructions>
                  {guide.steps(webhook?.startsWith("/") ? undefined : webhook).map((step, i) => (<li key={i}>{step}</li>))}
                </Instructions>
                <OpenIntegration id={id}>Configure {integration.title}</OpenIntegration>
              </div>
            </details>);
        })}
      </div>
    </>);
}
function RepositorySettings({ repos }) {
    return (<div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <span className="text-xs font-medium">In each repository</span>
      <Instructions>
        <li>
          Add the secret <Code>CODEX_AUTH_JSON</Code>. Run <Code>codex login</Code> on your machine and paste the whole
          contents of <Code>~/.codex/auth.json</Code> as its value. The workflows refuse to run in a public repository.
        </li>
        <li>
          In Settings, Actions, General, turn on Allow GitHub Actions to create and approve pull requests.
        </li>
      </Instructions>
      {repos.length > 0 && (<div className="flex flex-col gap-1 text-xs">
          {repos.map((repo) => (<span key={repo} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono">{repo}</span>
              <ExternalLink href={secretsUrl(repo)}>Secrets</ExternalLink>
              <ExternalLink href={actionsSettingsUrl(repo)}>Actions settings</ExternalLink>
            </span>))}
        </div>)}
    </div>);
}
function Code({ children }) {
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem] text-foreground">{children}</code>;
}
