// Where each module file on disk came from: the parts that need no `vscode`.

import { originKey, textHash, type FileOrigin } from './taskResolver';
import { controllerHash } from './pushGuard';

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
 * against: ctrlHash is the controller's own copy, read back after the pull or
 * the push, the base the changed-on-controller check compares with. The folder
 * layout is not changed by it.
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

  async record(fsPath: string, task: string, text: string, robotId?: string, at: string = new Date().toISOString(), controller?: { text: string; changeCount?: number }): Promise<void> {
    const origin: FileOrigin = { task, hash: textHash(text), robotId, at };
    if (controller) {
      origin.ctrlHash = controllerHash(controller.text);
      if (controller.changeCount !== undefined) { origin.ctrlChangeCount = controller.changeCount; }
    }
    await this.store.update(ORIGINS_KEY, { ...this.all(), [originKey(fsPath)]: origin });
  }

  /** Add the controller's copy to an existing record (the GET right after a push or a pull); nothing without a record. */
  async recordController(fsPath: string, controller: { text: string; changeCount?: number }): Promise<void> {
    const current = this.get(fsPath);
    if (!current) { return; }
    const origin: FileOrigin = { ...current, ctrlHash: controllerHash(controller.text) };
    if (controller.changeCount !== undefined) { origin.ctrlChangeCount = controller.changeCount; }
    await this.store.update(ORIGINS_KEY, { ...this.all(), [originKey(fsPath)]: origin });
  }

  private all(): Record<string, FileOrigin> {
    return this.store.get<Record<string, FileOrigin>>(ORIGINS_KEY, {});
  }
}
