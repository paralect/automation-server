import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { getSlackDirectory } from "@/lib/api.functions";
import { errorText } from "@/lib/errors";
import { slackDirectoryKey, slackDirectoryQuery } from "@/lib/queries";
import { idsOf, isMissingScope, mergeSelection, MISSING_SCOPE_HINT, NO_USERS_NOTICE, parseManualId, removeId, resolveChips, textOf, toggleId, } from "@/lib/slack-picker";
const COPY = {
    users: { choose: "Choose users", title: "Choose users", noun: "users", empty: "No users chosen.", search: "Search by name or @handle", idExample: "U01ABC23DEF" },
    channels: { choose: "Choose channels", title: "Choose channels", noun: "channels", empty: "No channels chosen. The bot answers in any channel it has been invited to.", search: "Search channels", idExample: "C01ABC23DEF" },
};
const DEBOUNCE_MS = 250;
function useDebounced(value) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [value]);
    return debounced;
}
function Chips({ chips, onRemove, disabled }) {
    return (<ul className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (<li key={chip.id} className="flex items-center gap-1 rounded-full border bg-input/20 py-0.5 pr-0.5 pl-2.5 text-xs dark:bg-input/30">
          <span className={cn(!chip.found && "font-mono")}>{chip.label}</span>
          {!chip.found && <span className="text-muted-foreground">not found</span>}
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${chip.label}`} disabled={disabled} onClick={() => onRemove(chip.id)}>
            <XIcon />
          </Button>
        </li>))}
    </ul>);
}
export function SlackPicker({ id, kind, value, onChange, enabled, project, }) {
    const [open, setOpen] = useState(false);
    const copy = COPY[kind];
    const ids = idsOf(value);
    // Without a token the API would only answer with an error, so it is not called at all.
    const directory = useQuery({ ...slackDirectoryQuery(project, kind, ""), enabled });
    const chips = resolveChips(ids, directory.data?.items);
    return (<div id={id} className="flex flex-col gap-2">
      {ids.length > 0 ? <Chips chips={chips} onRemove={(removed) => onChange(textOf(removeId(ids, removed)))}/> : <p className="text-xs text-muted-foreground">{copy.empty}</p>}
      {kind === "users" && ids.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{NO_USERS_NOTICE}</p>}
      <div>
        <Button type="button" variant="outline" size="sm" disabled={!enabled} onClick={() => setOpen(true)}>
          {copy.choose}
        </Button>
      </div>
      {open && (<PickerDialog kind={kind} project={project} initial={ids} known={directory.data?.items} onCancel={() => setOpen(false)} onDone={(chosen) => {
                onChange(textOf(mergeSelection(ids, chosen)));
                setOpen(false);
            }}/>)}
    </div>);
}
function PickerDialog({ kind, project, initial, known, onCancel, onDone, }) {
    const copy = COPY[kind];
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState([...initial]);
    const [search, setSearch] = useState("");
    const [manual, setManual] = useState("");
    const [manualError, setManualError] = useState();
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState();
    const debounced = useDebounced(search.trim());
    const query = useQuery(slackDirectoryQuery(project, kind, debounced));
    const error = refreshError ?? (query.error ? errorText(query.error) : undefined);
    // A list read before the failure is stale, so it is not offered next to the error.
    const items = error ? [] : (query.data?.items ?? []);
    const refresh = async () => {
        setRefreshing(true);
        setRefreshError(undefined);
        try {
            const fresh = await getSlackDirectory({ data: { project, kind, refresh: true } });
            queryClient.setQueryData(slackDirectoryQuery(project, kind, "").queryKey, fresh);
            await queryClient.invalidateQueries({ queryKey: slackDirectoryKey(project, kind), refetchType: "all" });
        }
        catch (err) {
            setRefreshError(errorText(err));
        }
        finally {
            setRefreshing(false);
        }
    };
    const addManual = () => {
        const parsed = parseManualId(kind, manual);
        if (!parsed.ok) {
            setManualError(parsed.error);
            return;
        }
        setManualError(undefined);
        setManual("");
        setDraft((prev) => (prev.includes(parsed.id) ? prev : [...prev, parsed.id]));
    };
    const selected = resolveChips(draft, known);
    const loading = (query.isPending || refreshing) && !error;
    return (<Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>Read live from your Slack workspace. Nothing is saved until you press Save on the page.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={copy.search} aria-label={copy.search} autoComplete="off" spellCheck={false}/>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              <ArrowsClockwiseIcon />
              Refresh
            </Button>
          </div>
          {error && (<div role="alert" className="flex flex-col gap-1">
              <FieldError>{error}</FieldError>
              {isMissingScope(error) && <p className="text-xs text-muted-foreground">{MISSING_SCOPE_HINT}</p>}
            </div>)}
          {loading && <p role="status" className="text-xs text-muted-foreground">Loading from Slack...</p>}
          {!loading && !error && items.length === 0 && <p className="text-xs text-muted-foreground">{search.trim() ? `No ${copy.noun} match "${search.trim()}".` : `Slack returned no ${copy.noun}.`}</p>}
          {items.length > 0 && (<ul className="flex max-h-64 flex-col overflow-y-auto rounded-md border" aria-label={copy.title}>
              {items.map((item) => (<li key={item.id} className="border-b last:border-b-0">
                  <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-muted/50">
                    <Checkbox checked={draft.includes(item.id)} onCheckedChange={() => setDraft((prev) => toggleId(prev, item.id))}/>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.detail && <span className="truncate text-muted-foreground">{item.detail}</span>}
                    {item.member === false && <span className="shrink-0 text-amber-700 dark:text-amber-400">bot not invited</span>}
                  </label>
                </li>))}
            </ul>)}
          {query.data?.truncated && <p className="text-xs text-muted-foreground">Your workspace has more than Slack lets us read here. Search, or add an ID by hand.</p>}
          {items.length >= 200 && <p className="text-xs text-muted-foreground">Showing the first 200. Search to narrow the list.</p>}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Selected ({draft.length})</span>
            {draft.length > 0 ? <Chips chips={selected} onRemove={(removed) => setDraft((prev) => removeId(prev, removed))}/> : <p className="text-xs text-muted-foreground">Nothing selected.</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`manual-${kind}`} className="text-xs font-medium">
              Add by ID
            </label>
            <div className="flex items-center gap-2">
              <Input id={`manual-${kind}`} value={manual} onChange={(e) => {
            setManual(e.target.value);
            setManualError(undefined);
        }} onKeyDown={(e) => {
            if (e.key !== "Enter")
                return;
            e.preventDefault();
            addManual();
        }} placeholder={copy.idExample} autoComplete="off" spellCheck={false} className="font-mono"/>
              <Button type="button" variant="outline" size="sm" onClick={addManual}>
                Add
              </Button>
            </div>
            {manualError ? <FieldError>{manualError}</FieldError> : <p className="text-xs text-muted-foreground">For IDs the list cannot show, such as people from another workspace in a Slack Connect channel.</p>}
          </div>
        </DialogBody>
        <DialogFooter className="flex-row justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onDone(draft)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>);
}
