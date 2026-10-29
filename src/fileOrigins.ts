// Where each module file on disk came from: the parts that need no `vscode`.

import { originKey, textHash, type FileOrigin } from './taskResolver';

/** The store the record lives in (`context.workspaceState` in the extension). */
export interface OriginStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const ORIGINS_KEY = 'abbRobot.fileOrigins.v1';

/**
 * The task and a hash of the text, per file path, for each file Pull, Pull
 * All, Open, Download or a successful Push wrote or sent, kept per workspace.
 * The task decides where a later Push, Load or Diff of that file goes
 * (src/taskResolver.ts). The hash is the text as it left or reached the
 * controller, the base a later check of the controller's copy compares
 * against. The folder layout is not changed by it.
 */
export class FileOrigins {
  constructor(private readonly store: OriginStore) {}

  get(fsPath: string | undefined): FileOrigin | undefined {
    return fsPath ? this.all()[originKey(fsPath)] : undefined;
  }

  /** The recorded task of a file, if any. */
  taskOf(fsPath: string | undefined): string | undefined {
    return this.get(fsPath)?.task;
  }

  async record(fsPath: string, task: string, text: string, robotId?: string, at: string = new Date().toISOString()): Promise<void> {
    const origin: FileOrigin = { task, hash: textHash(text), robotId, at };
    await this.store.update(ORIGINS_KEY, { ...this.all(), [originKey(fsPath)]: origin });
  }

  private all(): Record<string, FileOrigin> {
    return this.store.get<Record<string, FileOrigin>>(ORIGINS_KEY, {});
  }
}
