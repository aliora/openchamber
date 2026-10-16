// Whether a mounted composer holds a message the user has not sent yet.
// Composers register a probe that reads their live text and attachments;
// nothing is written while the user types, so asking costs one read per
// mounted composer and typing costs nothing.

type UnsentDraftProbe = () => boolean;

const probes = new Set<UnsentDraftProbe>();

/** Registers a mounted composer. Returns the call that unregisters it. */
export const registerUnsentDraftProbe = (probe: UnsentDraftProbe): (() => void) => {
  probes.add(probe);
  return () => {
    probes.delete(probe);
  };
};

/** True when any mounted composer holds text, files or references not sent yet. */
export const hasUnsentComposerDraft = (): boolean => {
  for (const probe of probes) {
    if (probe()) return true;
  }
  return false;
};
