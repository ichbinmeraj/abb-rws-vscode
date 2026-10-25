// DIPC: Create Queue prompts and checks, no `vscode`. ABB's DIPC service
// (Rev L, RWS site Rev C, RWS 1.0 pages Rev M) documents the queue size
// (`dipc-queue-size`, the number of messages) as required, 1 to 32767, and the
// message size (`dipc-max-msg-size`) as 1 to 448 and optional on RWS 2.0, 1 to
// 444 and required on RWS 1.0. ABB documents no defaults, so none are made up.

type Generation = 'rw6' | 'rw7' | 'rw8' | null;

const COUNT_MAX = 32767;
const sizeMax = (gen: Generation): number => (gen === 'rw6' ? 444 : 448);

export function dipcCountPrompt(): string {
  return `Queue size: how many messages the queue holds, 1 to ${COUNT_MAX} (required)`;
}

export function dipcSizePrompt(gen: Generation): string {
  return gen === 'rw6'
    ? `Largest message in bytes, 1 to ${sizeMax(gen)} (required on RobotWare 6)`
    : `Largest message in bytes, 1 to ${sizeMax(gen)} (optional on RobotWare 7 and 8; empty leaves it to the controller)`;
}

const whole = (v: string): number | undefined => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export function validateDipcCount(v: string): string | undefined {
  if (!v.trim()) { return 'Required: the controller refuses a queue without a size'; }
  const n = whole(v);
  return n !== undefined && n >= 1 && n <= COUNT_MAX ? undefined : `A whole number from 1 to ${COUNT_MAX}`;
}

export function validateDipcSize(v: string, gen: Generation): string | undefined {
  if (!v.trim()) { return gen === 'rw6' ? 'Required on RobotWare 6' : undefined; }
  const n = whole(v);
  return n !== undefined && n >= 1 && n <= sizeMax(gen) ? undefined : `A whole number from 1 to ${sizeMax(gen)}`;
}

const DATA_TYPES = new Set(['string', 'num', 'dnum', 'bool']);

/**
 * What Read Message shows. The controller's `dipc-msgtype` answer on a read is
 * the message kind (`IPC_SEND` for a message sent with the send command), not
 * the data type the sender chose, so it is labelled as what it is.
 */
export function dipcMessageText(msg: { payload: string; type?: string } | null | undefined): string {
  if (!msg) { return 'No message (timed out)'; }
  const type = msg.type ?? '';
  if (DATA_TYPES.has(type)) { return `Message: ${msg.payload} (${type})`; }
  return type
    ? `Message: ${msg.payload} (message kind ${type}; the controller does not return the data type)`
    : `Message: ${msg.payload}`;
}
