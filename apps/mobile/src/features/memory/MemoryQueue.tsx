import type { EnvironmentId, PeerMemoryScope } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText, AppTextInput } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function MemoryQueue({
  environmentId,
  scope,
  onChange,
}: {
  environmentId: EnvironmentId;
  scope: PeerMemoryScope;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queue = useEnvironmentQuery(
    open ? serverEnvironment.peerHubMemoryQueue({ environmentId, input: scope }) : null,
  );
  const retry = useAtomCommand(serverEnvironment.peerHubMemoryRetry, { reportFailure: false });
  const discard = useAtomCommand(serverEnvironment.peerHubMemoryDiscard, { reportFailure: false });
  const data = queue.error === null && !queue.isPending ? queue.data : null;
  const execute = async (operationId: string, reason?: string) => {
    setBusy(true);
    try {
      if (reason === undefined) {
        const result = await retry({ environmentId, input: { ...scope, operationId } });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          setNotice(error instanceof Error ? error.message : "Could not retry.");
          return;
        }
        setNotice(
          result.value.status === "stored"
            ? "Stored in shared memory."
            : "Still pending locally · not shared.",
        );
      } else {
        const result = await discard({ environmentId, input: { ...scope, operationId, reason } });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          setNotice(error instanceof Error ? error.message : "Could not discard.");
          return;
        }
        setNotice(`Discarded ${operationId}. Shared memory was not changed.`);
      }
      queue.refresh();
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-12 justify-center rounded-xl bg-card px-4"
      >
        <AppText>Pending and blocked local operations</AppText>
      </Pressable>
      {open ? (
        <>
          <AppText className="text-sm text-foreground-muted">
            Pending operations have not been shared. Retry sends the original expected version; it
            does not rebase a conflicting edit. Create a new correction against the latest version,
            then explicitly discard the original with a reason.
          </AppText>
          {notice ? <AppText accessibilityLiveRegion="polite">{notice}</AppText> : null}
          {queue.error ? (
            <AppText accessibilityRole="alert">{queue.error}</AppText>
          ) : data === null ? (
            <AppText accessibilityLiveRegion="polite">Loading local operations…</AppText>
          ) : data.operations.length === 0 ? (
            <AppText>No local operations are waiting.</AppText>
          ) : (
            data.operations.map((operation) => (
              <MemoryQueueOperation
                key={operation.operationId}
                operationId={operation.operationId}
                title={operation.command.type}
                status={operation.status}
                at={operation.at}
                blockedReason={operation.blockedReason}
                command={JSON.stringify(operation.command, null, 2)}
                busy={busy}
                onRetry={() => void execute(operation.operationId)}
                onDiscard={(reason) => void execute(operation.operationId, reason)}
              />
            ))
          )}
        </>
      ) : null}
    </View>
  );
}

function MemoryQueueOperation({
  operationId,
  title,
  status,
  at,
  blockedReason,
  command,
  busy,
  onRetry,
  onDiscard,
}: {
  operationId: string;
  title: string;
  status: string;
  at: string;
  blockedReason?: string | undefined;
  command: string;
  busy: boolean;
  onRetry: () => void;
  onDiscard: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-2 rounded-xl bg-card p-3">
      <AppText className="text-base font-semibold">
        {title} · {status}
      </AppText>
      <AppText selectable className="text-xs text-foreground-muted">
        {operationId} · {at}
      </AppText>
      {blockedReason ? <AppText accessibilityRole="alert">{blockedReason}</AppText> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-12 justify-center"
      >
        <AppText>Original command and scope</AppText>
      </Pressable>
      {expanded ? (
        <AppText selectable className="text-xs">
          {command}
        </AppText>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        accessibilityState={{ disabled: busy }}
        onPress={onRetry}
        className="min-h-12 justify-center"
      >
        <AppText>Retry original operation</AppText>
      </Pressable>
      <AppTextInput
        accessibilityLabel="Reason to discard this unshared operation"
        value={reason}
        onChangeText={setReason}
        placeholder="Reason to discard"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Discard local operation ${operationId}`}
        disabled={busy || !reason.trim()}
        accessibilityState={{ disabled: busy || !reason.trim() }}
        onPress={() => onDiscard(reason.trim())}
        className="min-h-12 justify-center"
      >
        <AppText>Discard local operation</AppText>
      </Pressable>
    </View>
  );
}
