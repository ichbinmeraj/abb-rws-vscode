// Download Module to File: the parts that need no `vscode`.

/** What View Module Text reads with: the text of a module that is loaded in a task. */
export interface ModuleTextReader {
  getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }>;
}

/**
 * The label the error dialog carries. Not 'Download module': the isWriteOp
 * heuristic in friendlyErrorMessage keys on 'module', and a file-path 404
 * message here sent users looking for a parent directory.
 */
export const MODULE_SAVE_LABEL = 'Save RAPID text';

export function moduleSaveName(module: string): string { return `${module}.mod`; }

/**
 * Read the loaded module's text and hand it to `write`. The module is not a
 * file on the controller (a system module such as BASE has none in $HOME), so
 * this goes through the same read as View Module Text. Returns the text length.
 */
export async function saveModuleText(
  reader: ModuleTextReader, task: string, module: string, write: (text: string) => void,
): Promise<number> {
  const { text } = await reader.getModuleText(task, module);
  write(text);
  return text.length;
}
