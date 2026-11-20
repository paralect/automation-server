import { formatAbsolute, formatRelative } from "@/lib/time";
export function Time({ iso, relativeOnly }) {
    return (<time dateTime={iso} title={iso} className="whitespace-nowrap">
      {relativeOnly ? (formatRelative(iso)) : (<>
          {formatAbsolute(iso)}
          <span className="block text-xs text-muted-foreground">{formatRelative(iso)}</span>
        </>)}
    </time>);
}
