import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RobotManager } from './RobotManager';
import { StatusTreeProvider } from './StatusTreeProvider';
import { MotionTreeProvider } from './MotionTreeProvider';
import { RapidTreeProvider } from './RapidTreeProvider';
import { ModulesTreeProvider } from './ModulesTreeProvider';

let globalManager: RobotManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const manager = new RobotManager();
  globalManager = manager;

  const statusProvider  = new StatusTreeProvider(manager);
  const motionProvider  = new MotionTreeProvider(manager);
  const rapidProvider   = new RapidTreeProvider(manager);
  const modulesProvider = new ModulesTreeProvider(manager);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('abbRobot.status',  statusProvider),
    vscode.window.registerTreeDataProvider('abbRobot.motion',  motionProvider),
    vscode.window.registerTreeDataProvider('abbRobot.rapid',   rapidProvider),
    vscode.window.registerTreeDataProvider('abbRobot.modules', modulesProvider),
  );

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(circle-slash) ABB Robot';
  statusBar.tooltip = 'ABB Robot — not connected';
  statusBar.command = 'abbRobot.connect';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Refresh all views on state change
  manager.onDidChange(() => {
    statusProvider.refresh();
    motionProvider.refresh();
    rapidProvider.refresh();
    modulesProvider.refresh();

    const s = manager.state;
    if (!s.connected) {
      statusBar.text = '$(circle-slash) ABB Robot';
      statusBar.tooltip = 'ABB Robot — not connected';
      statusBar.command = 'abbRobot.connect';
      statusBar.backgroundColor = undefined;
    } else {
      const icon = s.ctrlstate === 'motoron' ? '$(circle-filled)' : '$(warning)';
      statusBar.text = `${icon} ABB [${s.ctrlstate ?? '…'}] RAPID: ${s.execstate ?? '…'}`;
      statusBar.tooltip = `Host: ${s.host}  Mode: ${s.opmode ?? '…'}`;
      statusBar.command = 'abbRobot.disconnect';
      statusBar.backgroundColor = s.execstate === 'running'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    }

    vscode.commands.executeCommand('setContext', 'abbRobot.connected', s.connected);
  });

  // ─── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(

    vscode.commands.registerCommand('abbRobot.configure', async () => {
      const cfg = vscode.workspace.getConfiguration('abbRobot');

      const host = await vscode.window.showInputBox({
        title: 'ABB Robot — Connection Settings (1/3)',
        prompt: 'Controller IP address or hostname',
        value: cfg.get<string>('host', '192.168.125.1'),
        validateInput: v => v.trim() ? undefined : 'Host is required',
      });
      if (host === undefined) return;

      const username = await vscode.window.showInputBox({
        title: 'ABB Robot — Connection Settings (2/3)',
        prompt: 'RWS username',
        value: cfg.get<string>('username', 'Default User'),
        validateInput: v => v.trim() ? undefined : 'Username is required',
      });
      if (username === undefined) return;

      const password = await vscode.window.showInputBox({
        title: 'ABB Robot — Connection Settings (3/3)',
        prompt: 'RWS password',
        value: cfg.get<string>('password', 'robotics'),
        password: true,
      });
      if (password === undefined) return;

      await cfg.update('host',     host.trim(),     vscode.ConfigurationTarget.Global);
      await cfg.update('username', username.trim(), vscode.ConfigurationTarget.Global);
      await cfg.update('password', password,        vscode.ConfigurationTarget.Global);

      const connect = await vscode.window.showInformationMessage(
        `✓ Saved — host: ${host.trim()}  user: ${username.trim()}`,
        'Connect Now',
      );
      if (connect === 'Connect Now') {
        vscode.commands.executeCommand('abbRobot.connect');
      }
    }),

    vscode.commands.registerCommand('abbRobot.connect', async () => {
      const cfg      = vscode.workspace.getConfiguration('abbRobot');
      const host     = cfg.get<string>('host',     '192.168.125.1');
      const username = cfg.get<string>('username', 'Default User');
      const password = cfg.get<string>('password', 'robotics');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host}…`, cancellable: true },
        async (progress, token) => {
          const maxRetries = 20;
          const retryDelay = 3000;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (token.isCancellationRequested) return;
            try {
              await manager.connect(host, username, password);
              return;
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              const isBusy = msg.includes('503') || msg.toLowerCase().includes('busy');
              if (isBusy && attempt < maxRetries) {
                progress.report({ message: `Controller busy — retrying in 3 s… (${attempt}/${maxRetries})` });
                await new Promise(r => setTimeout(r, retryDelay));
              } else {
                vscode.window.showErrorMessage(`Connect failed: ${msg}`);
                return;
              }
            }
          }
        },
      );
    }),

    vscode.commands.registerCommand('abbRobot.disconnect', async () => {
      await manager.disconnect();
      vscode.window.showInformationMessage('Disconnected from ABB robot.');
    }),

    vscode.commands.registerCommand('abbRobot.startRapid', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Starting RAPID…' },
        async () => {
          try {
            await manager.startRapid();
            vscode.window.showInformationMessage('RAPID started.');
          } catch (e: unknown) {
            vscode.window.showErrorMessage(
              `Start RAPID failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('abbRobot.stopRapid', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Stopping RAPID…' },
        async () => {
          try {
            await manager.stopRapid();
            vscode.window.showInformationMessage('RAPID stopped.');
          } catch (e: unknown) {
            vscode.window.showErrorMessage(
              `Stop RAPID failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('abbRobot.resetRapid', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Resetting RAPID PP…' },
        async () => {
          try {
            await manager.resetRapid();
            vscode.window.showInformationMessage('RAPID PP reset.');
          } catch (e: unknown) {
            vscode.window.showErrorMessage(
              `Reset RAPID failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    // PP to Main — same as resetRapid but surfaced separately in the Modules panel
    vscode.commands.registerCommand('abbRobot.ppToMain', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Moving PP to Main…' },
        async () => {
          try {
            await manager.resetRapid();
            vscode.window.showInformationMessage('✓ Program pointer moved to Main.');
          } catch (e: unknown) {
            vscode.window.showErrorMessage(
              `PP to Main failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    vscode.commands.registerCommand('abbRobot.refresh', () => {
      manager.refresh();
    }),

    // Upload a .mod file from disk → load into a task
    vscode.commands.registerCommand('abbRobot.uploadModule', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'RAPID Module': ['mod', 'MOD'] },
        title: 'Select RAPID module to upload',
      });
      if (!uris || uris.length === 0) return;

      const localPath = uris[0].fsPath;
      const fileName  = require('path').basename(localPath);

      // Always load into the first active task (T_ROB1 on a standard single-robot cell)
      const taskName = manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading ${fileName}…`,
        },
        async (progress) => {
          try {
            progress.report({ message: 'Unloading old program…' });
            await manager.loadProgram(localPath, taskName!);
            vscode.window.showInformationMessage(
              `✓ ${fileName} loaded and ready. Press Start Program to run.`);
          } catch (e: unknown) {
            const err = e as Error & { ppFailed?: boolean };
            if (err.ppFailed) {
              // Module loaded OK, only PP to Main failed
              vscode.window.showWarningMessage(err.message);
            } else {
              vscode.window.showErrorMessage(
                `Load failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        },
      );
    }),

    // Download a module from the controller → save to disk
    vscode.commands.registerCommand('abbRobot.downloadModule', async (moduleName: string) => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }

      // If called without argument (e.g. from command palette), ask for name
      if (!moduleName) {
        moduleName = await vscode.window.showInputBox({
          prompt: 'Module name to download (without .mod extension)',
          placeHolder: 'MyProgram',
        }) ?? '';
        if (!moduleName) return;
      }

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `${moduleName}.mod`)),
        filters: { 'RAPID Module': ['mod'] },
        title: `Save ${moduleName}.mod`,
      });
      if (!saveUri) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${moduleName}.mod…`,
        },
        async () => {
          try {
            const content = await manager.downloadModule(moduleName);
            fs.writeFileSync(saveUri.fsPath, content, 'utf8');
            const open = await vscode.window.showInformationMessage(
              `✓ ${moduleName}.mod saved to ${saveUri.fsPath}`,
              'Open File',
            );
            if (open === 'Open File') {
              vscode.window.showTextDocument(saveUri);
            }
          } catch (e: unknown) {
            vscode.window.showErrorMessage(
              `Download failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),
  );

}

export async function deactivate() {
  if (globalManager) {
    await globalManager.disconnect();
    globalManager = undefined;
  }
}
