/**
 * PeerHub publishes the one opted-in local adapter package, like hubPolicy's
 * provisioned state. Provider adapters read it without a circular service dependency.
 */
let directory: string | undefined;

export const setClaudeModDirectory = (next: string | undefined): void => {
  directory = next;
};
export const readClaudeModDirectory = (): string | undefined => directory;
