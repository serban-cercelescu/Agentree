/**
 * Channel names, shared by main and preload so the two can't drift apart.
 * The API shape itself lives in shared/types.ts, where the renderer sees it too.
 */
export const CH = {
  listSessions: "sessions:list",
  getSession: "sessions:get",
  patchNode: "sessions:patchNode",
  forkAt: "sessions:forkAt",

  // Watching is a subscription, so it needs a main→renderer direction too.
  watchStart: "watch:start",
  watchStop: "watch:stop",
  /** main → renderer: the watched transcript changed on disk. */
  changed: "watch:changed",
} as const;
