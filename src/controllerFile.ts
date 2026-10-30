// Open Controller File: whether a file read from the controller is text, so
// it opens in the editor, or not, so VS Code picks its viewer. Without `vscode`,
// so the unit tests can state the rule.
//
// The client reads a controller file as text (`readFile` decodes the body), so
// a binary file is not an exact copy: the viewer gets what the decode left.
// The rule: a known text extension is text, a known binary extension is not,
// anything else is text unless its content has a NUL character or many bytes
// outside printable text.

const TEXT_EXTENSIONS = new Set([
  'mod', 'sys', 'prg', 'pgf', 'modx', 'sysx', 'cfg', 'txt', 'log', 'xml', 'json', 'csv', 'md', 'ini', 'cmd', 'bat', 'ps1',
  'html', 'htm', 'js', 'ts', 'py', 'lua', 'yml', 'yaml',
]);
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'zip', 'gz', 'tar', '7z', 'rar', 'exe', 'dll', 'so', 'bin', 'dat', 'pdf', 'wav', 'mp3', 'mp4',
]);

/** The lower-cased extension of a file name, without its dot; '' without one. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether a file, by its name and what the client read, is text. */
export function looksLikeText(name: string, content: string): boolean {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) { return true; }
  if (BINARY_EXTENSIONS.has(ext)) { return false; }
  if (content.includes('\0')) { return false; }
  const sample = content.slice(0, 4096);
  if (sample.length === 0) { return true; }
  let odd = 0;
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    // Printable ASCII, tab, newline, carriage return and the characters a text decode keeps are text; control characters and the replacement character are not.
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) { odd++; }
    else if (c === 0xfffd) { odd++; }
  }
  return odd / sample.length < 0.05;
}

/** What the person is told when a file that is not text is opened: the client read it as text. */
export function binaryFileNote(name: string): string {
  return `${name} is not a text file. RAPID Live reads controller files as text, so what opened may not be an exact copy; download it with RobotStudio or Download File for one.`;
}
