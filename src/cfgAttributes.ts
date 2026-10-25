// The attributes of a CFG instance that are sent to the controller. A read of
// an instance returns `rdonly` and `instanceid` next to the real attributes;
// they are metadata, not attributes to write (RobotWare 6 answers a create that
// carries them with 400 "Error in serving post request"). No `vscode`.

const READ_ONLY = new Set(['rdonly', 'instanceid']);

export function writableAttributes(input: Record<string, unknown>): { attrs: Record<string, string>; removed: string[] } {
  const attrs: Record<string, string> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (READ_ONLY.has(k.toLowerCase())) { removed.push(k); continue; }
    attrs[k] = String(v);
  }
  return { attrs, removed };
}
