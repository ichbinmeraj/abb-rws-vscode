// Which robot a command acts on, without `vscode`, so the unit tests can state it.

/** The robot id a command argument carries: a string, or an object with an `id`. */
export function extractRobotId(arg?: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg && typeof arg === 'object' && 'id' in arg && typeof (arg as { id: unknown }).id === 'string') {
    return (arg as { id: string }).id;
  }
  return undefined;
}

/**
 * The robot a command is for: the one its argument names, else the active one.
 * A named robot that is not in the list is undefined, never the active robot,
 * so a stale row can not send to another controller.
 */
export function entryForArg<T extends { id: string }>(
  entries: readonly T[], activeId: string | undefined, arg?: unknown,
): T | undefined {
  const named = extractRobotId(arg);
  const id = named ?? activeId;
  return id === undefined ? undefined : entries.find(e => e.id === id);
}

/**
 * The names that more than one saved robot carries (compared without case or
 * surrounding spaces). Two robots with one name read the same in every
 * confirmation, so the save warns; it blocks nothing.
 */
export function duplicateRobotNames(configs: ReadonlyArray<{ name: string }>): string[] {
  const seen = new Map<string, { shown: string; count: number }>();
  for (const { name } of configs) {
    const key = name.trim().toLowerCase();
    if (!key) { continue; }
    const hit = seen.get(key);
    if (hit) { hit.count++; } else { seen.set(key, { shown: name.trim(), count: 1 }); }
  }
  return [...seen.values()].filter(v => v.count > 1).map(v => v.shown);
}
