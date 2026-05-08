import * as vscode from 'vscode';
import type { RapidLanguageIndex } from './RapidLanguageIndex';

/**
 * Find All References for RAPID. Shift+F12 on a routine / variable name
 * lists every occurrence across the workspace.
 *
 * The index does the actual scanning. We just translate the VS Code
 * provider hook into an index call.
 */
export class RapidReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: RapidLanguageIndex) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
    if (!range) { return []; }
    const word = document.getText(range);
    if (word.length < 2) { return []; }   // single chars produce too much noise
    return this.index.findReferences(word, context.includeDeclaration);
  }
}
