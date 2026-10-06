import { useId } from "react";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function MemoryField({
  label,
  name,
  value,
  required = false,
  multiline = false,
  type = "text",
  hint,
}: {
  label: string;
  name: string;
  value?: string | undefined;
  required?: boolean;
  multiline?: boolean;
  type?: "text" | "number" | "datetime-local" | "search";
  hint?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {multiline ? (
        <Textarea
          id={id}
          name={name}
          defaultValue={value}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
      ) : (
        <Input
          id={id}
          name={name}
          type={type}
          defaultValue={value}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
      )}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function MemorySelect({
  label,
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  name: string;
  value?: string | undefined;
  options: readonly { value: string; label: string }[];
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label id={`${id}-label`} className="text-xs font-medium">
        {label}
      </label>
      <Select
        name={name}
        disabled={disabled}
        defaultValue={value}
        {...(onChange
          ? {
              value,
              onValueChange: (next: string | null) => {
                if (next !== null) onChange(next);
              },
            }
          : {})}
      >
        <SelectTrigger aria-labelledby={`${id}-label`}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function MemoryEvidenceFields({
  repositoryId,
  revision,
}: {
  repositoryId?: string | undefined;
  revision?: string | undefined;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">Evidence</legend>
      <MemorySelect
        label="Source kind"
        name="evidenceKind"
        value="code"
        options={["code", "test", "pr", "artifact", "knowledge", "legacy"].map((value) => ({
          value,
          label: value,
        }))}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <MemoryField
          label="Source path"
          name="evidencePath"
          hint="Leave empty to record a proposed finding without evidence."
        />
        <MemoryField label="Repository ID" name="repositoryId" value={repositoryId} />
        <MemoryField label="Full source commit" name="revision" value={revision} />
        <MemoryField
          label="Source blob hash"
          name="blobHash"
          hint="A location without an immutable fingerprint is marked weak."
        />
      </div>
      <MemoryField label="Test command" name="evidenceCommand" />
      <MemoryField label="Observed result" name="evidenceResult" multiline />
      <MemoryField label="Source URL" name="evidenceUrl" />
    </fieldset>
  );
}
