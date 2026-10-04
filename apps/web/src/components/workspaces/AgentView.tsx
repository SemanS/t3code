import type { EnvironmentId, PeerAgentEntry, PeerAgentView } from "@t3tools/contracts";
import {
  BotIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { StatusGlyph } from "./workStatus";
import { failureMessage } from "./WorkspaceAccess";

const TOOL_ICON: Readonly<Record<string, LucideIcon>> = {
  Bash: SquareTerminalIcon,
  Read: FileTextIcon,
  Edit: PencilIcon,
  MultiEdit: PencilIcon,
  Write: PencilIcon,
  NotebookEdit: PencilIcon,
  Grep: SearchIcon,
  Glob: SearchIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Task: BotIcon,
  Agent: BotIcon,
  TodoWrite: ListChecksIcon,
};

/**
 * One of this computer's herdr agents, in Peer: what it has done so far (from
 * its own transcript when Peer knows its session, else the end of its
 * terminal) and a box for its next prompt. herdr keeps the agent running;
 * Peer is where you follow and steer it.
 */
export function AgentView({ agentId }: { readonly agentId: string }) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const view =
    useEnvironmentQuery(
      environmentId === null
        ? null
        : serverEnvironment.peerHubWatchAgent({ environmentId, input: { agentId } }),
    ).data ?? undefined;
  const focusAgent = useAtomCommand(serverEnvironment.peerHubFocusAgent, { reportFailure: false });
  const paneId = view?.paneId;
  const details = view === undefined ? [] : [view.agent, "herdr", view.branch].filter(Boolean);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {view === undefined ? null : <StatusGlyph status={view.status} />}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {view?.title || "Agent"}
            </span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {details.join(" · ")}
            </span>
          </div>
          {environmentId !== null && paneId !== undefined && !view?.gone ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void focusAgent({ environmentId, input: { paneId } }).then((result) => {
                  const message = failureMessage(result);
                  if (message !== null) {
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Could not show that agent in herdr",
                        description: message,
                      }),
                    );
                  }
                })
              }
            >
              Show in herdr
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <AgentTimeline view={view} />
        <AgentComposer environmentId={environmentId} view={view} />
      </div>
    </SidebarInset>
  );
}

/** The agent's steps, following the newest unless the reader scrolled back. */
function AgentTimeline({ view }: { readonly view: PeerAgentView | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Each new view of the agent scrolls to its newest step, unless the reader scrolled back.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (view === undefined || element === null || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [view]);
  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
        {view === undefined ? (
          <p className="text-sm text-muted-foreground">Connecting…</p>
        ) : view.gone ? (
          <p className="text-sm text-muted-foreground">This agent no longer runs in herdr.</p>
        ) : view.entries !== undefined ? (
          view.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            view.entries.map((entry) => <AgentStep key={entry.id} entry={entry} cwd={view.cwd} />)
          )
        ) : (
          <>
            {view.hint === undefined ? null : (
              <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                {view.hint}
              </p>
            )}
            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground wrap-break-word">
              {view.terminal ?? ""}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

function AgentStep({
  entry,
  cwd,
}: {
  readonly entry: PeerAgentEntry;
  readonly cwd: string | undefined;
}) {
  if (entry.kind === "prompt") {
    return (
      <div className="max-w-xl self-end rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
        {entry.text}
      </div>
    );
  }
  if (entry.kind === "text") return <ChatMarkdown text={entry.text} cwd={cwd} />;
  const Icon = TOOL_ICON[entry.name] ?? WrenchIcon;
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          entry.failed ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-foreground", entry.name === "Bash" && "font-mono")}>
          {entry.summary}
        </p>
        {entry.result === undefined ? null : (
          <p
            className={cn("truncate", entry.failed ? "text-destructive" : "text-muted-foreground")}
          >
            {entry.result}
          </p>
        )}
      </div>
    </div>
  );
}

/** The next prompt, sent into the agent's terminal through herdr. */
function AgentComposer({
  environmentId,
  view,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly view: PeerAgentView | undefined;
}) {
  const promptAgent = useAtomCommand(serverEnvironment.peerHubPromptAgent, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const blocked = view?.status === "blocked";
  const unavailable = environmentId === null || view === undefined || view.gone;
  const send = () => {
    const prompt = text.trim();
    if (prompt === "" || sending || unavailable || blocked) return;
    setSending(true);
    void promptAgent({ environmentId, input: { agentId: view.agentId, text: prompt } })
      .then((result) => {
        const message = failureMessage(result);
        if (message === null) {
          setText("");
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send the prompt",
            description: message,
          }),
        );
      })
      .finally(() => setSending(false));
  };
  return (
    <div className="border-t border-border px-6 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {blocked ? (
          <p className="text-xs text-warning-foreground">
            It is waiting for an answer in its terminal. Answer it in herdr, then continue here.
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            className="min-w-0 flex-1"
            rows={2}
            value={text}
            disabled={unavailable || blocked}
            placeholder={
              view?.status === "working"
                ? "It is working; a prompt now waits for its turn"
                : "Tell it what to do next"
            }
            aria-label="Prompt for the agent"
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <Button
            size="sm"
            disabled={unavailable || blocked || sending || text.trim() === ""}
            onClick={send}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
