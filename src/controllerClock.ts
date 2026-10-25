// Read / Set Controller Clock: wording and parsing, no `vscode`.

/**
 * What a read shows. ABB's Controller_Service document says the value from
 * GET /ctrl/clock is always UTC. A virtual controller answers the PC's local
 * time instead, so the value is shown as the controller gave it, with both
 * facts stated.
 */
export function clockReadMessage(datetime: string): string {
  return `Controller clock: ${datetime}\n`
    + 'ABB documents the value as UTC; a virtual controller answers this PC\'s local time.';
}

export function clockSetPrompt(): string {
  return 'Date/time as YYYY-MM-DD HH:MM:SS. Sent exactly as typed, no conversion; '
    + 'ABB documents the controller clock as UTC (real controllers only, a virtual controller refuses).';
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The prefill: UTC now, the time ABB documents for the set. */
export function clockSetDefault(now: Date): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} `
    + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

export function parseClockInput(v: string): [number, number, number, number, number, number] | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (!m) { return undefined; }
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
}

export function clockSetDone(typed: string): string {
  return `✓ Clock set to ${typed} (sent as typed; ABB documents the clock as UTC).`;
}

/** True when a clock write was answered 405 (`PUT /ctrl/clock`: method not supported by the resource). */
export function clockWriteRefused(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return /HTTP 405 from PUT \/ctrl\/clock/.test(raw);
}

/**
 * The sentence for that answer. ABB lists the clock write for real controllers only.
 */
export function clockWriteRefusedMessage(label: string, virtual: boolean): string {
  return virtual
    ? `${label}: this virtual controller does not accept a clock write (PUT /ctrl/clock answered 405). ABB lists the clock write for real controllers only; nothing was changed.`
    : `${label}: the controller answered 405 to the clock write (PUT /ctrl/clock: method not supported). Nothing was changed.`;
}
