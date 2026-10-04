import type { EnvironmentId, PeerAgentView } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EyeIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentTimeline } from "./AgentView";
import { askPrompt, observedThread, type ObservedThread } from "./observe.logic";
import { StatusGlyph } from "./workStatus";
import { usePeerHubStatus } from "./WorkspaceAccess";

/**
 * A colleague's thread they share, as it happens: read-only, relayed by the
 * hub from their computer while you watch. Questions go to your own agent in
 * a new thread of yours; nothing reaches theirs.
 */
export function ObserveView({
  workspace,
  environment,
  thread,
}: {
  readonly workspace: string;
  readonly environment: string;
  readonly thread: string;
}) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const watched = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.peerHubObserveThread({
          environmentId,
          input: { workspace, environment, thread },
        }),
  );
  const view = watched.data ?? undefined;
  const observed = observedThread(status, workspace, environment, thread);
  const details = [observed?.person, observed?.task ?? observed?.project].filter(Boolean);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {view === undefined ? null : <StatusGlyph status={view.status} />}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {view?.title || observed?.title || "Shared thread"}
            </span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {details.join(" · ")}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <EyeIcon aria-hidden className="size-3.5" />
            Watching, read-only
          </span>
        </WorkspacePageHeader>
        {watched.error !== null && view === undefined ? (
          <p className="mx-auto w-full max-w-3xl px-6 py-6 text-sm text-muted-foreground">
            {watched.error}
          </p>
        ) : (
          <AgentTimeline
            view={view}
            goneText="That thread no longer runs on its owner's computer."
          />
        )}
        {observed === null ? null : (
          <AskAboutIt environmentId={environmentId} observed={observed} view={view} />
        )}
      </div>
    </SidebarInset>
  );
}

/** A question about the colleague's work, for your own agent in a new thread of yours. */
function AskAboutIt({
  environmentId,
  observed,
  view,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly observed: ObservedThread;
  readonly view: PeerAgentView | undefined;
}) {
  const newThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const asked = question.trim();
    if (asked === "" || busy || environmentId === null || view === undefined) return;
    setBusy(true);
    try {
      const projectId =
        observed.t3ProjectId ?? (await openScratchProject(environmentId))?.id ?? undefined;
      if (projectId === undefined) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Could not open a thread to ask in" }),
        );
        return;
      }
      const session = await newThread(scopeProjectRef(environmentId, projectId));
      if (session === null) return;
      useComposerDraftStore
        .getState()
        .setPrompt(session.draftId, askPrompt({ thread: observed, view, question: asked }));
      setQuestion("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-border px-6 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Ask about it: your own agent answers in a new thread of yours, from what you see here.{" "}
          {observed.person}’s agent hears nothing.
        </p>
        <div className="flex items-end gap-2">
          <Textarea
            className="min-w-0 flex-1"
            rows={2}
            value={question}
            disabled={view === undefined || environmentId === null}
            placeholder={`What would you like to know about ${observed.person}’s work?`}
            aria-label="Question about this work"
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
            }}
          />
          <Button
            size="sm"
            disabled={view === undefined || busy || question.trim() === ""}
            onClick={() => void ask()}
          >
            {busy ? "Opening…" : "Ask"}
          </Button>
        </div>
      </div>
    </div>
  );
}
