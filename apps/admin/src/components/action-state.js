import { useEffect, useState } from "react";
import { CheckCircleIcon, CircleNotchIcon, ClockIcon, HourglassIcon, MinusCircleIcon, ProhibitIcon, XCircleIcon, } from "@phosphor-icons/react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { ACTION_BADGE } from "@/lib/badge-styles";
import { formatElapsed } from "@/lib/time";
const ICON = {
    queued: ClockIcon,
    waiting: HourglassIcon,
    running: CircleNotchIcon,
    success: CheckCircleIcon,
    failure: XCircleIcon,
    cancelled: ProhibitIcon,
    skipped: MinusCircleIcon,
};
export const ACTION_TONE = {
    queued: "text-muted-foreground",
    waiting: "text-amber-600 dark:text-amber-400",
    running: "text-blue-600 dark:text-blue-400",
    success: "text-emerald-600 dark:text-emerald-400",
    failure: "text-destructive",
    cancelled: "text-muted-foreground",
    skipped: "text-muted-foreground",
};
export function ActionStateIcon({ state, className }) {
    const Glyph = ICON[state];
    return (<Glyph weight={state === "running" ? "bold" : "fill"} aria-hidden className={cn("size-4 shrink-0", ACTION_TONE[state], state === "running" && "motion-safe:animate-spin", className)}/>);
}
export function ActionStateBadge({ state, conclusion }) {
    const label = state === "failure" && conclusion && conclusion !== "failure" ? conclusion.replace(/_/g, " ") : state;
    return (<Badge {...ACTION_BADGE[state]} data-icon="inline-start">
      <ActionStateIcon state={state} className="text-current"/>
      {label}
    </Badge>);
}
export function useNow(active, intervalMs = 1000) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active)
            return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [active, intervalMs]);
    return now;
}
// GitHub timestamps have one-second resolution, so anything shorter reads as "<1 s" instead of a fake "0 ms".
export function Elapsed({ from, to, now }) {
    if (!from)
        return <span className="text-muted-foreground">-</span>;
    const ms = (to ? Date.parse(to) : now) - Date.parse(from);
    return <span className="tabular-nums">{ms < 1000 ? "<1 s" : formatElapsed(ms)}</span>;
}
