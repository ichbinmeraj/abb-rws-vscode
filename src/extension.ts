import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RobotManager } from './RobotManager';
import { StatusTreeProvider } from './StatusTreeProvider';
import { MotionTreeProvider } from './MotionTreeProvider';
import { RapidTreeProvider } from './RapidTreeProvider';
import { ModulesTreeProvider } from './ModulesTreeProvider';
import { ElogTreeProvider } from './ElogTreeProvider';
import { FileExplorerProvider } from './FileExplorerProvider';
import { IoTreeProvider } from './IoTreeProvider';
import type { SignalItem } from './IoTreeProvider';
import type { Signal } from 'abb-rws-client';

let globalManager: RobotManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const manager = new RobotManager();
  globalManager = manager;

  const statusProvider  = new StatusTreeProvider(manager);
  const motionProvider  = new MotionTreeProvider(manager);
  const rapidProvider   = new RapidTreeProvider(manager);
  const modulesProvider = new ModulesTreeProvider(manager);
  const elogProvider    = new ElogTreeProvider(manager);
  const filesProvider   = new FileExplorerProvider(manager);
  const ioProvider      = new IoTreeProvider(manager);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('abbRobot.status',  statusProvider),
    vscode.window.registerTreeDataProvider('abbRobot.motion',  motionProvider),
    vscode.window.registerTreeDataProvider('abbRobot.rapid',   rapidProvider),
    vscode.window.registerTreeDataProvider('abbRobot.modules', modulesProvider),
    vscode.window.registerTreeDataProvider('abbRobot.elog',    elogProvider),
    vscode.window.registerTreeDataProvider('abbRobot.files',   filesProvider),
    vscode.window.registerTreeDataProvider('abbRobot.io',      ioProvider),
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
    elogProvider.refresh();
    ioProvider.refresh();

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

    // Motors on/off
    vscode.commands.registerCommand('abbRobot.motorsOn', async () => {
      try {
        await manager.setMotorsOn();
        vscode.window.showInformationMessage('Motors ON.');
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Motors On failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    vscode.commands.registerCommand('abbRobot.motorsOff', async () => {
      try {
        await manager.setMotorsOff();
        vscode.window.showInformationMessage('Motors OFF.');
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Motors Off failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Set speed ratio
    vscode.commands.registerCommand('abbRobot.setSpeedRatio', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const current = manager.state.speedRatio ?? 100;
      const input = await vscode.window.showInputBox({
        title: 'Set Speed Ratio',
        prompt: 'Enter speed ratio (0–100). Only works in AUTO mode.',
        value: String(current),
        validateInput: v => {
          const n = parseInt(v, 10);
          return (isNaN(n) || n < 0 || n > 100) ? 'Must be a number 0–100' : undefined;
        },
      });
      if (input === undefined) return;
      try {
        await manager.setSpeedRatio(parseInt(input, 10));
        vscode.window.showInformationMessage(`Speed ratio set to ${input}%.`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Set speed ratio failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Read RAPID variable
    vscode.commands.registerCommand('abbRobot.readVariable', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const task   = await vscode.window.showInputBox({ title: 'Read RAPID Variable (1/3)', prompt: 'Task name', value: 'T_ROB1' });
      if (!task) return;
      const module = await vscode.window.showInputBox({ title: 'Read RAPID Variable (2/3)', prompt: 'Module name', value: 'user' });
      if (!module) return;
      const symbol = await vscode.window.showInputBox({ title: 'Read RAPID Variable (3/3)', prompt: 'Variable name', value: 'reg1' });
      if (!symbol) return;

      try {
        const value = await manager.getRapidVariable(task, module, symbol);
        vscode.window.showInformationMessage(`${task}/${module}/${symbol} = ${value}`, 'Copy').then(choice => {
          if (choice === 'Copy') vscode.env.clipboard.writeText(value);
        });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Read variable failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Read RAPID symbol properties
    vscode.commands.registerCommand('abbRobot.readSymbolProperties', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const task   = await vscode.window.showInputBox({ title: 'Symbol Properties (1/3)', prompt: 'Task name', value: 'T_ROB1' });
      if (!task) return;
      const module = await vscode.window.showInputBox({ title: 'Symbol Properties (2/3)', prompt: 'Module name', value: 'user' });
      if (!module) return;
      const symbol = await vscode.window.showInputBox({ title: 'Symbol Properties (3/3)', prompt: 'Symbol name' });
      if (!symbol) return;

      try {
        const props = await manager.getRapidSymbolProperties(task, module, symbol);
        const msg = [
          `Symbol: ${task}/${module}/${symbol}`,
          `Type: ${props.symtyp}  DataType: ${props.dattyp}`,
          `Dims: ${props.ndim > 0 ? props.dim : 'scalar'}`,
          `ReadOnly: ${props.ro}  Local: ${props.local}  TaskVar: ${props.taskvar}`,
        ].join('\n');
        vscode.window.showInformationMessage(msg, 'Copy').then(choice => {
          if (choice === 'Copy') vscode.env.clipboard.writeText(JSON.stringify(props, null, 2));
        });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Symbol properties failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Set execution cycle
    vscode.commands.registerCommand('abbRobot.setExecutionCycle', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Once', description: 'Run once then stop', value: 'once' },
          { label: 'Forever', description: 'Loop indefinitely', value: 'forever' },
          { label: 'As Is', description: 'Keep current cycle setting', value: 'asis' },
        ],
        { title: 'Set RAPID Execution Cycle', placeHolder: 'Select cycle mode' },
      );
      if (!choice) return;
      try {
        await manager.setExecutionCycle(choice.value as 'once' | 'forever' | 'asis');
        vscode.window.showInformationMessage(`Execution cycle set to: ${choice.label}`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Set cycle failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Write RAPID variable
    vscode.commands.registerCommand('abbRobot.writeVariable', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const task   = await vscode.window.showInputBox({ title: 'Write RAPID Variable (1/4)', prompt: 'Task name', value: 'T_ROB1' });
      if (!task) return;
      const module = await vscode.window.showInputBox({ title: 'Write RAPID Variable (2/4)', prompt: 'Module name', value: 'user' });
      if (!module) return;
      const symbol = await vscode.window.showInputBox({ title: 'Write RAPID Variable (3/4)', prompt: 'Variable name' });
      if (!symbol) return;
      const value  = await vscode.window.showInputBox({ title: 'Write RAPID Variable (4/4)', prompt: 'New value (RAPID syntax: 42, "hello", [1,0,0,0])' });
      if (value === undefined) return;

      try {
        await manager.setRapidVariable(task, module, symbol, value);
        vscode.window.showInformationMessage(`${symbol} set to: ${value}`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Write variable failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Refresh event log
    vscode.commands.registerCommand('abbRobot.refreshElog', async () => {
      await manager.refreshEventLog();
      elogProvider.refresh();
    }),

    // Clear event log
    vscode.commands.registerCommand('abbRobot.clearEventLog', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all event log messages from the controller?', { modal: true }, 'Clear',
      );
      if (confirm !== 'Clear') return;
      try {
        await manager.clearEventLog();
        elogProvider.refresh();
        vscode.window.showInformationMessage('Event log cleared.');
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Clear event log failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Refresh file browser
    vscode.commands.registerCommand('abbRobot.refreshFiles', () => {
      filesProvider.refresh();
    }),

    // Create directory on controller
    vscode.commands.registerCommand('abbRobot.createDirectory', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const parentPath = await vscode.window.showInputBox({
        title: 'Create Directory (1/2)',
        prompt: 'Parent path on controller',
        value: '$HOME',
      });
      if (!parentPath) return;
      const dirName = await vscode.window.showInputBox({
        title: 'Create Directory (2/2)',
        prompt: 'New directory name',
        validateInput: v => v.trim() ? undefined : 'Name is required',
      });
      if (!dirName) return;
      try {
        await manager.createDirectory(parentPath, dirName.trim());
        vscode.window.showInformationMessage(`Directory '${dirName}' created at ${parentPath}.`);
        filesProvider.refresh();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Create directory failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Download a file from the controller filesystem
    vscode.commands.registerCommand('abbRobot.downloadControllerFile', async (node: { path: string; entry: { name: string } }) => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(require('os').homedir(), node.entry.name)),
        title: `Save ${node.entry.name}`,
      });
      if (!saveUri) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${node.entry.name}…` },
        async () => {
          try {
            const content = await manager.listDirectory(node.path).then(() => {}).catch(() => {});
            // Use readFile to download
            const client = (manager as unknown as { client: import('abb-rws-client').RwsClient | null }).client;
            if (!client) throw new Error('Not connected');
            const text = await client.readFile(node.path);
            fs.writeFileSync(saveUri.fsPath, text, 'utf8');
            const open = await vscode.window.showInformationMessage(`✓ ${node.entry.name} saved.`, 'Open');
            if (open === 'Open') vscode.window.showTextDocument(saveUri);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    // Delete a file from the controller filesystem
    vscode.commands.registerCommand('abbRobot.deleteControllerFile', async (node: { path: string; entry: { name: string } }) => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${node.entry.name} from the controller?`, { modal: true }, 'Delete',
      );
      if (confirm !== 'Delete') return;
      try {
        await manager.deleteControllerFile(node.path);
        vscode.window.showInformationMessage(`${node.entry.name} deleted.`);
        filesProvider.refresh();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Get active UI instruction
    vscode.commands.registerCommand('abbRobot.getUiInstruction', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      try {
        const instr = await manager.getActiveUiInstruction();
        if (!instr) {
          vscode.window.showInformationMessage('No active UI instruction — RAPID is not waiting for input.');
          return;
        }
        const msg = [
          `Instruction: ${instr.instr}`,
          `Event: ${instr.event}`,
          `Level: ${instr.execlv}`,
          `Stack: ${instr.stack}`,
          instr.msg ? `Message: ${instr.msg}` : '',
        ].filter(Boolean).join('\n');
        vscode.window.showInformationMessage(msg, 'Copy Stack URL').then(choice => {
          if (choice === 'Copy Stack URL') vscode.env.clipboard.writeText(instr.stack);
        });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Get UI instruction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Read controller clock
    vscode.commands.registerCommand('abbRobot.getControllerClock', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      try {
        const datetime = await manager.getControllerClock();
        vscode.window.showInformationMessage(`Controller clock (UTC): ${datetime}`, 'Copy').then(choice => {
          if (choice === 'Copy') vscode.env.clipboard.writeText(datetime);
        });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Read clock failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Restart controller
    vscode.commands.registerCommand('abbRobot.restartController', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Restart', description: 'Normal restart — saves state, activates system parameter changes', value: 'restart' },
          { label: 'P-Start', description: 'Preserves system parameters, removes programs', value: 'pstart' },
          { label: 'I-Start', description: 'Restores original installation settings, discards all programs', value: 'istart' },
          { label: 'B-Start', description: 'Boot with last auto-saved state (crash recovery)', value: 'bstart' },
        ],
        { title: 'Restart Controller', placeHolder: 'Select restart mode' },
      );
      if (!choice) return;
      const confirm = await vscode.window.showWarningMessage(
        `${choice.label} the controller? The robot will be unavailable during restart.`,
        { modal: true }, 'Restart',
      );
      if (confirm !== 'Restart') return;
      try {
        await manager.restartController(choice.value as 'restart' | 'istart' | 'pstart' | 'bstart');
        vscode.window.showInformationMessage('Restart command sent. Disconnecting…');
        await manager.disconnect();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Restart failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Search RAPID symbols
    vscode.commands.registerCommand('abbRobot.searchSymbols', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      const task = await vscode.window.showInputBox({ title: 'Search RAPID Symbols (1/2)', prompt: 'Task name', value: 'T_ROB1' });
      if (!task) return;
      const symtyp = await vscode.window.showQuickPick(
        [
          { label: 'All', value: undefined },
          { label: 'Variables (var)', value: 'var' },
          { label: 'Persistents (per)', value: 'per' },
          { label: 'Constants (con)', value: 'con' },
          { label: 'Functions (fun)', value: 'fun' },
          { label: 'Procedures (prc)', value: 'prc' },
        ],
        { title: 'Search RAPID Symbols (2/2)', placeHolder: 'Filter by symbol type' },
      );
      if (!symtyp) return;
      try {
        const symbols = await manager.searchRapidSymbols({ task, symtyp: symtyp.value });
        if (symbols.length === 0) {
          vscode.window.showInformationMessage(`No symbols found in ${task}.`);
          return;
        }
        const lines = symbols.map(s => `${s.symtyp.padEnd(4)} ${s.dattyp.padEnd(16)} ${s.name}  (${s.symburl})`);
        const text = `Found ${symbols.length} symbols in ${task}:\n\n` + lines.join('\n');
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
        vscode.window.showTextDocument(doc);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Symbol search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Refresh I/O signals
    vscode.commands.registerCommand('abbRobot.refreshIo', async () => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing I/O signals…' },
        async () => {
          try {
            await manager.refreshIoSignals();
            ioProvider.refresh();
          } catch (e: unknown) {
            vscode.window.showErrorMessage(`Refresh I/O failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      );
    }),

    // Write a signal value (prompted input for AO/GO, or direct value for DO)
    vscode.commands.registerCommand('abbRobot.writeSignal', async (node?: SignalItem | Signal) => {
      if (!manager.state.connected) {
        vscode.window.showWarningMessage('Connect to the robot first.');
        return;
      }

      let signalName: string | undefined;
      let signalType: string | undefined;
      let currentValue: string | undefined;

      if (node && 'signal' in node) {
        // Called from tree item context menu
        signalName   = node.signal.name;
        signalType   = node.signal.type;
        currentValue = node.signal.lvalue;
      } else if (node && 'name' in node) {
        // Called with a Signal object directly
        signalName   = (node as Signal).name;
        signalType   = (node as Signal).type;
        currentValue = (node as Signal).lvalue;
      } else {
        // Called from command palette — ask for signal name
        signalName = await vscode.window.showInputBox({
          title: 'Write I/O Signal (1/2)',
          prompt: 'Signal name',
          placeHolder: 'DO_1',
        });
        if (!signalName) return;
      }

      const isDigital = signalType === 'DO';
      const isGroup   = signalType === 'GO';

      let value: string | undefined;

      if (isDigital) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '0 — Off / Low', value: '0' },
            { label: '1 — On / High', value: '1' },
          ],
          { title: `Write ${signalName}`, placeHolder: `Current value: ${currentValue ?? '?'}` },
        );
        if (!pick) return;
        value = pick.value;
      } else {
        value = await vscode.window.showInputBox({
          title: `Write ${signalName}`,
          prompt: isGroup ? 'New integer value' : 'New numeric value',
          value: currentValue,
          validateInput: v => {
            const n = Number(v);
            return isNaN(n) ? 'Must be a number' : undefined;
          },
        });
        if (value === undefined) return;
      }

      try {
        await manager.writeIoSignal(signalName, value);
        ioProvider.refresh();
        vscode.window.showInformationMessage(`${signalName} set to ${value}.`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Write signal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    // Toggle a digital output (DO) between 0 and 1
    vscode.commands.registerCommand('abbRobot.toggleSignal', async (signal: Signal) => {
      if (!manager.state.connected) return;
      const newValue = signal.lvalue === '1' ? '0' : '1';
      try {
        await manager.writeIoSignal(signal.name, newValue);
        ioProvider.refresh();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Toggle signal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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
