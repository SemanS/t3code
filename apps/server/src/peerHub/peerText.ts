/**
 * peerText — text that reaches an agent from somebody else.
 *
 * What other members and their agents write (a note, a shared context, a committed entry, a
 * model's answer) is read by agents that never saw its author. So nothing in it may hide (the
 * characters a reader cannot see are dropped), nothing in it may open or close what Peer wraps it
 * in (the tags a harness or a model reads are made harmless), and Peer says it is reference, not
 * instruction. Everything here is cheap, whatever the text is: no regex is quadratic in it.
 *
 * @module peerHub/peerText
 */

/**
 * Characters a reader cannot see and no script needs: controls, zero-width space, directional and
 * invisible-format marks, Unicode tags and variation-selector supplements. The two joiners (U+200C,
 * U+200D) are not here: some scripts write words with them, and emoji sequences
 * are made of them (`strayJoiners` drops the ones that join nothing).
 */
const HIDDEN =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- the invisible characters are what it matches.
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0d\ufeff\uffa0\ufff9-\ufffb]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * A joiner (U+200C, U+200D) stays only where it joins: between two visible characters, and not
 * next to another joiner. At an edge, next to a space or in a run it carries nothing a reader
 * reads, and a row of them could carry something a reader does not.
 */
function strayJoiners(text: string): string {
  if (!text.includes("\u200c") && !text.includes("\u200d")) return text;
  const joiner = (char: string | undefined) => char === "\u200c" || char === "\u200d";
  const visible = (char: string | undefined) =>
    char !== undefined && !joiner(char) && !/\s/u.test(char);
  const chars = [...text];
  return chars
    .filter(
      (char, index) => !joiner(char) || (visible(chars[index - 1]) && visible(chars[index + 1])),
    )
    .join("");
}

/** Tags that mean something to the fence another text is in, to the harness or to a model: a quoted text cannot open or close them. */
const CONTROL_TAGS =
  /<(\/?)(shared-context|system-reminder|system|function_calls|invoke|parameter|antml:[\w-]+|user-prompt-submit-hook|command-(?:name|message|args)|local-command-\w+|task-notification)\b/gi;

/**
 * `text` cut to at most `max` UTF-16 units, never between the two halves of a character that takes
 * two (an emoji, a rare ideograph): a cut text is still text in every script.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `text` with the tags a quoted text must not carry made harmless (`<` becomes `‹`). */
export const neutral = (text: string): string => text.replace(CONTROL_TAGS, "‹$1$2");

/**
 * Text that did not come from this person (a model's answer, a committed entry) as one short line:
 * what a reader cannot see is dropped, and it cannot close the fence another text is in.
 */
export function plain(text: string, max: number): string {
  return cutText(
    neutral(strayJoiners(text.replace(/[\n\r\t]+/g, " ").replace(HIDDEN, "")))
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

/** Like `plain`, for a text of several lines: the line breaks stay. */
export function block(text: string, max: number): string {
  return cutText(
    neutral(
      strayJoiners(
        text
          .replace(/\r/g, "")
          .replace(HIDDEN, (char) => (char === "\n" || char === "\t" ? char : "")),
      ),
    ).trim(),
    max,
  );
}

/** Text from another work, fenced so an agent reads it as data and it cannot close the fence. */
export function fenced(lines: ReadonlyArray<string>): string {
  const body = lines.map((line) => `- ${neutral(line)}`).join("\n");
  return `<shared-context>\n${body}\n</shared-context>`;
}

/** `1 entry`, `2 entries`. */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** How long ago, as people say it. */
export function sinceText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Whether a prompt is what a person asked: not Peer's own words coming back (a woken agent's
 * prompt is the note that woke it) and not a slash command. How long it is says nothing: "ok" and
 * a whole request in a few characters of another script are both asks, and what Peer tells an
 * agent that was told already is nothing.
 */
export function askedByPerson(prompt: string): boolean {
  const text = prompt.trim();
  return (
    text !== "" &&
    !text.startsWith("/") &&
    !text.startsWith("<task-notification>") &&
    !text.startsWith("<system-reminder>") &&
    !/^Peer\s*[:·]/.test(text) &&
    !text.includes("Stop hook blocking error")
  );
}
