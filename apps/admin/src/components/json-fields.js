export function JsonFields({ fields }) {
    if (Object.keys(fields).length === 0)
        return null;
    return (<details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        fields
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap break-all">
        {JSON.stringify(fields, null, 2)}
      </pre>
    </details>);
}
