import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { binaryFileNote, extensionOf, looksLikeText } from '../src/controllerFile';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('Open Controller File: text or not', () => {
  it('a known text extension is text, a known binary one is not, whatever the content', () => {
    assert.equal(looksLikeText('MainModule.mod', '\0\0\0'), true);
    assert.equal(looksLikeText('EIO.cfg', 'EIO:CFG_1.0::\n'), true);
    assert.equal(looksLikeText('picture.PNG', 'MODULE M\nENDMODULE\n'), false);
    assert.equal(looksLikeText('backup.zip', ''), false);
    assert.equal(extensionOf('a.b.MOD'), 'mod');
    assert.equal(extensionOf('noext'), '');
    assert.equal(extensionOf('.hidden'), '');
  });

  it('an unknown extension goes by the content: a NUL character or many control characters means not text', () => {
    assert.equal(looksLikeText('notes', 'plain text with\r\nlines\tand tabs\n'), true);
    assert.equal(looksLikeText('notes', ''), true);
    assert.equal(looksLikeText('blob', 'abc\0def'), false);
    const control = Array.from({ length: 100 }, (_, i) => String.fromCharCode(i % 32)).join('');
    assert.equal(looksLikeText('blob', control), false);
    assert.equal(looksLikeText('blob', `${'text '.repeat(100)}\u0001`), true);
    assert.equal(looksLikeText('blob', '�'.repeat(20) + 'a'), false);
  });

  it('the note says the client read the file as text', () => {
    assert.equal(binaryFileNote('logo.png'), 'logo.png is not a text file. RAPID Live reads controller files as text, so what opened may not be an exact copy; download it with RobotStudio or Download File for one.');
  });

  it('the command opens text in the editor and anything else through vscode.open, with the note', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.openControllerFile'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /if \(looksLikeText\(node\.entry\.name, text\)\) \{ await openAsScratchFile\(node\.entry\.name, text\); return; \}/);
    assert.match(body, /const saved = await scratchFileFor\(node\.entry\.name, text\);/);
    assert.match(body, /vscode\.commands\.executeCommand\('vscode\.open', vscode\.Uri\.file\(saved\.path\)\)/);
    assert.match(body, /binaryFileNote\(node\.entry\.name\)/);
  });

  it('the host harness opens a text file', () => {
    const acceptance = fs.readFileSync(path.join(root, 'test', 'host', 'stub-ext', 'acceptance.js'), 'utf8');
    assert.match(acceptance, /TEXT_FILE = \/\\\.\(mod\|sys\|prg\|cfg\|txt\|log\|xml\|json\|csv\|md\|ini\|cmd\)\$\/i/);
  });
});
