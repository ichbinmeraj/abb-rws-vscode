import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MECHUNITS_UNKNOWN, decideMechunit, resolveMechunit, unitNameProblem, type MechunitUi } from '../src/mechunitResolver';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

function ui(answer?: string, typed?: string) {
  const log: string[] = [];
  const u: MechunitUi = {
    pick: async (items, title, placeHolder) => { log.push(`pick ${items.join(',')} | ${title} | ${placeHolder}`); return answer; },
    input: async (title, prompt, validate) => { log.push(`input | ${title} | ${prompt}`); return typed !== undefined && validate(typed) === undefined ? typed : undefined; },
  };
  return { u, log };
}

describe('which mechanical unit a command acts on', () => {
  it('exactly one unit is it', () => {
    assert.deepEqual(decideMechunit({ mechunits: ['ROB_1'] }), { kind: 'unit', unit: 'ROB_1' });
    assert.deepEqual(decideMechunit({ mechunits: ['IRB_1'] }), { kind: 'unit', unit: 'IRB_1' });
  });

  it('several make the person pick, in the controller\'s order', () => {
    assert.deepEqual(decideMechunit({ mechunits: ['ROB_1', 'STN_1'] }), { kind: 'ask', candidates: ['ROB_1', 'STN_1'] });
  });

  it('none means the list is unknown, not read or the read failed: no default name (review finding 10)', () => {
    assert.deepEqual(decideMechunit({ mechunits: [] }), { kind: 'unknown', reason: MECHUNITS_UNKNOWN });
    assert.deepEqual(decideMechunit({ mechunits: [''] }), { kind: 'unknown', reason: MECHUNITS_UNKNOWN });
    assert.match(MECHUNITS_UNKNOWN, /not read yet, or the read failed/);
  });

  it('resolves the one unit without a prompt', async () => {
    const { u, log } = ui();
    assert.equal(await resolveMechunit(u, 'Cell 3 (10.0.5.20:80)', { mechunits: ['ROB_1'] }, 'Set Active Tool'), 'ROB_1');
    assert.deepEqual(log, []);
  });

  it('asks with a title naming the command and the robot, and returns the pick', async () => {
    const { u, log } = ui('STN_1');
    assert.equal(await resolveMechunit(u, 'Cell 3 (10.0.5.20:80)', { mechunits: ['ROB_1', 'STN_1'] }, 'Teleport Robot'), 'STN_1');
    assert.deepEqual(log, ['pick ROB_1,STN_1 | Teleport Robot on Cell 3 (10.0.5.20:80) | Which mechanical unit of Cell 3 (10.0.5.20:80)? (it lists 2)']);
    const dismissed = ui(undefined);
    assert.equal(await resolveMechunit(dismissed.u, 'Cell 3', { mechunits: ['ROB_1', 'STN_1'] }, 'Teleport Robot'), undefined);
  });

  it('with the list unknown it asks for the name, with no preset, and never fills in ROB_1', async () => {
    const { u, log } = ui(undefined, 'ROB_2');
    assert.equal(await resolveMechunit(u, 'Cell 3 (10.0.5.20:80)', { mechunits: [] }, 'Set Active Work Object'), 'ROB_2');
    assert.equal(log.length, 1);
    assert.match(log[0], /^input \| Set Active Work Object on Cell 3 \(10\.0\.5\.20:80\) \| Which mechanical unit\? For Cell 3 \(10\.0\.5\.20:80\), the controller's list of mechanical units is unknown \(not read yet, or the read failed\)\./);
    assert.match(log[0], /the controller refuses a name it does not have\. Escape sends nothing\.$/);
    assert.doesNotMatch(log[0], /ROB_1/);
    const dismissed = ui(undefined, undefined);
    assert.equal(await resolveMechunit(dismissed.u, 'Cell 3', { mechunits: [] }, 'Set Active Tool'), undefined);
    assert.equal(dismissed.log.length, 1);
  });

  it('a typed name is a RAPID name, trimmed; anything else sends nothing', async () => {
    assert.equal(unitNameProblem('ROB_2'), undefined);
    assert.equal(unitNameProblem('  STN_1 '), undefined);
    assert.match(unitNameProblem('') ?? '', /press Escape to send nothing/);
    assert.match(unitNameProblem('   ') ?? '', /press Escape to send nothing/);
    assert.match(unitNameProblem('2ROB') ?? '', /a letter followed by/);
    assert.match(unitNameProblem('ROB 1') ?? '', /a letter followed by/);
    assert.match(unitNameProblem('../rw') ?? '', /a letter followed by/);
    const spaced = ui(undefined, ' ROB_2 ');
    assert.equal(await resolveMechunit(spaced.u, 'Cell 3', { mechunits: [] }, 'Teleport Robot'), 'ROB_2');
    // A box that hands back text its validation refused (a window that does not validate) sends nothing.
    const lax: MechunitUi = { pick: async () => undefined, input: async () => 'ROB 1' };
    assert.equal(await resolveMechunit(lax, 'Cell 3', { mechunits: [] }, 'Teleport Robot'), undefined);
  });

  it('Teleport, Jog, Set Active Tool, Set Active Work Object and the mechanical-unit read use it; the box has no preset value', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const handler = (id: string): string => {
      const start = src.indexOf(`tracedCommand('${id}'`);
      assert.ok(start >= 0, id);
      return src.slice(start, src.indexOf('tracedCommand(', start + 1));
    };
    const sites: Array<[string, string, string]> = [
      ['abbRobot.teleportRobot', 'mechunit', 'Teleport Robot'],
      ['abbRobot.jog', 'mechunit', 'Jog'],
      ['abbRobot.setActiveTool', 'mu', 'Set Active Tool'],
      ['abbRobot.setActiveWobj', 'mu', 'Set Active Work Object'],
      ['abbRobot.showMechunitDetails', 'mu', 'Show Mechunit Details'],
    ];
    for (const [id, name, purpose] of sites) {
      assert.match(handler(id), new RegExp(`const ${name} = await mechunitFor\\(entry, '${purpose}'\\);\\s*if \\(!${name}\\) \\{ return; \\}`), id);
    }
    assert.match(src, /resolveMechunit\(\{/);
    assert.match(src, /input: \(title, prompt, validate\) => vscode\.window\.showInputBox\(\{ title, prompt, validateInput: validate, ignoreFocusOut: true \}\)/);
  });
});

describe('the vendored client no longer guesses a mechanical unit (review finding 10, client half, abb-rws-client 1.5.3)', () => {
  it('a failed read of the units leaves the list as it was, never ROB_1', () => {
    const dist = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'RobotManager.js'), 'utf8');
    const line = dist.split('\n').find(l => /listMechunits\(\)\.catch\(/.test(l)) ?? '';
    assert.match(line, /return null;/, 'the failed read answers null');
    assert.doesNotMatch(line, /ROB_1/, 'the failed read does not name a unit');
    assert.match(dist, /if \(mechunits\) \{\s*this\._state\.mechunits = mechunits;/, 'a null read leaves the list as it was');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'package.json'), 'utf8')).version as string;
    assert.ok(/^1\.5\.[3-9]|^1\.[6-9]|^[2-9]/.test(version), `client ${version} is 1.5.3 or later`);
  });
});
