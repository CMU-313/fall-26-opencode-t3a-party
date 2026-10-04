// Centralizes the permission-metadata keys the familiarity feature uses, so tools, the permission service and
// the UI all agree on their names and shapes instead of each matching a magic string.

export const FILES_KEY = "unfamiliarFiles"
export const FORCED_KEY = "unfamiliarForced"
// Marks an informational request: the student opted into "always allow unfamiliar", so this AI edit to unfamiliar
// files was allowed without a prompt and is surfaced only as a one-line notice.
export const AUTO_ALLOWED_KEY = "unfamiliarAutoAllowed"

// Absolute paths of files an AI edit touches that the student has not read or edited.
export function files(metadata: Record<string, unknown> | undefined): string[] {
  const value = metadata?.[FILES_KEY]
  return Array.isArray(value) ? value.filter((file): file is string => typeof file === "string") : []
}

// True when the prompt is only being shown because of unfamiliar files, past a rule that would otherwise allow it.
export function forced(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[FORCED_KEY] === true
}

// True for a non-blocking notice about an unfamiliar AI edit the student has pre-approved.
export function autoAllowed(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[AUTO_ALLOWED_KEY] === true
}

export * as FamiliarityMetadata from "./metadata"
