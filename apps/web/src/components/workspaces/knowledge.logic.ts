/**
 * The kontext command that records a knowledge candidate in a project's
 * repository: a learning by default, titled by its first sentence, without
 * people's names (knowledge is for the team, as kontext writes it).
 */
export function kontextCaptureCommand(candidate: {
  readonly text: string;
  readonly finders: number;
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(candidate.text)?.[1] ?? candidate.text;
  const title = sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
  const found =
    candidate.finders > 1
      ? `${candidate.finders} agents found it on their own, on different work.`
      : "An agent marked it as holding beyond its task.";
  const body = `${candidate.text}\n\n${found} Proposed in Peer.`;
  return `kontext capture --kind learning --title ${quote(title)} --body ${quote(body)}`;
}
