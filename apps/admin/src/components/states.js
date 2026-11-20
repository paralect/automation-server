import { Link } from "@tanstack/react-router";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ERROR_COPY, errorKind } from "@/lib/errors";
export function QueryError({ error, onRetry }) {
    const kind = errorKind(error);
    const copy = ERROR_COPY[kind];
    return (<Alert variant="destructive" role="alert">
      <WarningCircleIcon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.body}</p>
        <div className="mt-3">
          {kind === "session" ? (<Button variant="outline" size="sm" nativeButton={false} render={<Link to="/login"/>}>
              Go to login
            </Button>) : (<Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>)}
        </div>
      </AlertDescription>
    </Alert>);
}
export function EmptyState({ title, hint }) {
    return (<div className="flex flex-col items-center gap-1 rounded-lg border border-dashed p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>);
}
export function RowsSkeleton({ rows = 8 }) {
    return (<div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (<Skeleton key={i} className="h-10 w-full"/>))}
    </div>);
}
export function PageHeader({ title, description, children, }) {
    return (<div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-medium">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>);
}
