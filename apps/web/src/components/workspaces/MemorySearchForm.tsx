import { useState } from "react";
import { Button } from "../ui/button";
import { MemoryField } from "./MemoryFields";

export interface MemorySearchFilters {
  query?: string;
  repositoryId?: string;
  commit?: string;
  environment?: string;
  validAt?: string;
  knownAt?: string;
}

const localDate = (value?: string) =>
  value === undefined
    ? undefined
    : new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);

export function MemorySearchForm({
  filters,
  onSearch,
}: {
  filters: MemorySearchFilters;
  onSearch: (filters: MemorySearchFilters) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        try {
          const values = new FormData(event.currentTarget);
          const text = (name: string) => String(values.get(name) ?? "").trim();
          const date = (name: string) =>
            text(name) ? new Date(text(name)).toISOString() : undefined;
          const validAt = date("validAt");
          const knownAt = date("knownAt");
          onSearch({
            ...(text("query") ? { query: text("query") } : {}),
            ...(text("repositoryId") ? { repositoryId: text("repositoryId") } : {}),
            ...(text("commit") ? { commit: text("commit") } : {}),
            ...(text("environment") ? { environment: text("environment") } : {}),
            ...(validAt ? { validAt } : {}),
            ...(knownAt ? { knownAt } : {}),
          });
        } catch {
          setError("Enter valid dates before searching.");
        }
      }}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <MemoryField label="Search memory" name="query" type="search" value={filters.query} />
        </div>
        <Button type="submit" size="sm">
          Search
        </Button>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Checkout and time filters
        </summary>
        <div className="grid gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-3">
          <MemoryField label="Repository ID" name="repositoryId" value={filters.repositoryId} />
          <MemoryField label="Exact checkout commit" name="commit" value={filters.commit} />
          <MemoryField label="Environment" name="environment" value={filters.environment} />
          <MemoryField
            label="Valid at"
            name="validAt"
            type="datetime-local"
            value={localDate(filters.validAt)}
            hint="When the claim applies in the world."
          />
          <MemoryField
            label="Known at"
            name="knownAt"
            type="datetime-local"
            value={localDate(filters.knownAt)}
            hint="What was known at this time. Today's access rules still apply."
          />
        </div>
        <p className="pt-2 text-muted-foreground">
          Dates use your local timezone; the manifest records UTC filters.
        </p>
      </details>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
