import type { PeerMemoryEvidence as Evidence } from "@t3tools/contracts";

function sourceUrl(value?: string) {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function MemoryEvidence({ sources }: { sources: readonly Evidence[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Evidence sources</h3>
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No source evidence is attached. This record is not a verified fact.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((source) => {
            const url = sourceUrl(source.url);
            return (
              <li
                key={JSON.stringify(source)}
                className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3 text-xs"
              >
                <p className="font-medium">
                  {source.kind}
                  {source.weak ? " · weak evidence" : " · immutable source reference"}
                </p>
                {source.path ? (
                  <p className="break-all font-mono">
                    {source.path}
                    {source.startLine
                      ? `:${source.startLine}${source.endLine ? `–${source.endLine}` : ""}`
                      : ""}
                    {source.symbol ? ` · ${source.symbol}` : ""}
                  </p>
                ) : null}
                {source.repositoryId ? (
                  <p className="break-all">Repository {source.repositoryId}</p>
                ) : null}
                {source.revision ? (
                  <p className="break-all font-mono">Commit {source.revision}</p>
                ) : null}
                {source.blobHash ? (
                  <p className="break-all font-mono">Blob {source.blobHash}</p>
                ) : null}
                {source.command ? (
                  <p className="break-words font-mono">Command: {source.command}</p>
                ) : null}
                {source.result ? (
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono">
                    {source.result}
                  </pre>
                ) : null}
                {source.outputHash ? (
                  <p className="break-all font-mono">Output hash {source.outputHash}</p>
                ) : null}
                {source.baseRevision ? (
                  <p className="break-all">
                    Base {source.baseRevision} · diff {source.diffHash ?? "unrecorded"}
                  </p>
                ) : null}
                {source.environment ? <p>Environment {source.environment}</p> : null}
                {url ? (
                  <a
                    className="break-all underline underline-offset-2"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
