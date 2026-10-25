import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string; title: string }> };
};
const titles = new Map(manifest.contributes.commands.map(c => [c.command, c.title]));

type Gen = 'RWS 1.0' | 'RWS 2.0';

/** The lines under the first `### ` heading matching `heading` in a README's "## Known limits" section. */
function subsection(readme: string, heading: RegExp): string {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex(l => /^## Known limits\s*$/.test(l));
  assert.ok(start >= 0, 'a "## Known limits" section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) { end = lines.length; }
  const section = lines.slice(start + 1, end);
  const i = section.findIndex(l => l.startsWith('### ') && heading.test(l));
  assert.ok(i >= 0, `a subsection matching ${heading}`);
  const out: string[] = [];
  for (const l of section.slice(i + 1)) { if (l.startsWith('#')) { break; } out.push(l); }
  return out.join('\n');
}

/** A command's title up to its ellipsis, as the README names it. */
const titleOf = (id: string): string => {
  const t = titles.get(id);
  assert.ok(t, `${id} is contributed`);
  return t.replace(/….*$/, '');
};

// Commands that rest on a client operation the vendored client lists as never run
// (no logged 2xx) on a generation.
const neverRun: Array<{ commands: string[]; ops: string[]; gens: Gen[] }> = [
  { commands: ['abbRobot.jog'], ops: ['jog'], gens: ['RWS 1.0'] },
  { commands: ['abbRobot.lockOpMode'], ops: ['lockOperationMode'], gens: ['RWS 1.0'] },
  { commands: ['abbRobot.unlockOpMode'], ops: ['unlockOperationMode'], gens: ['RWS 1.0'] },
  { commands: ['abbRobot.getUiInstruction'], ops: ['setUiInstructionParam'], gens: ['RWS 2.0'] },
  { commands: ['abbRobot.setControllerClock'], ops: ['setControllerClock'], gens: ['RWS 1.0', 'RWS 2.0'] },
  { commands: ['abbRobot.restoreBackup'], ops: ['restoreBackup'], gens: ['RWS 2.0'] },
  { commands: ['abbRobot.showProgramPointer'], ops: ['getMotionPointer'], gens: ['RWS 1.0', 'RWS 2.0'] },
];

/** One operation's row in the vendored client's path tables (dist/paths/<file>.js), its comments included. */
function clientPathRow(file: string, op: string): string {
  const src = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'paths', `${file}.js`), 'utf8');
  const at = src.indexOf(`    ${op}: {`);
  assert.ok(at >= 0, `the vendored client has a ${op} path row`);
  return src.slice(at, src.indexOf('\n    },', at));
}

// Buttons on an error dialog (src/refusalUi.ts) not yet run from the button on a generation.
// `source` is how the label is written there; `button` is how the README names it.
const dialogs: Array<{ button: string; source: string; ops: string[]; gens: Gen[] }> = [
  { button: 'Request Remote Control', source: "'Request Remote Control'", ops: ['requestRmmp'], gens: ['RWS 1.0'] },
  { button: 'Allow Motion Control…', source: "ALLOW_MOTION_CONTROL_BUTTON = 'Allow Motion Control…'", ops: ['setAllowMotionControl'], gens: ['RWS 2.0'] },
];

// RMMP on RWS 1.0: the line names the `exec` level, which has not been sent on RobotWare 6.
// The `modify` grant is stated only while the vendored client records `requestRmmp` live there.
const rmmpExecOnly = { command: 'abbRobot.requestRmmp', gen: 'RWS 1.0' as Gen };

// The README's RobotWare 6 line against the vendored client's. The RWS 1.0 form the client
// lacks although ABB documents it (a `-` in the RWS 1.0 column of its operations table, and
// named in its RobotWare 6 line), the RWS 1.0 forms it has built but not run (`built` in
// that column, and listed under RWS 1.0 in its never-run list), and the RWS 1.0 forms that
// ran on a 6.16.03 virtual controller (`live` in that column, off that list, and a path-table
// row that names RW 6.16.03).
const rws1Missing: Array<{ readme: string; op: string }> = [
  { readme: 'Modify Position', op: 'modifyPosition' },
];
const rws1Built: Array<{ readme: string; op: string }> = [
  { readme: 'signal simulation', op: 'setSignalSimulated' },
  { readme: 'unblocking signals', op: 'unblockSignals' },
  { readme: 'enabling or disabling an I/O device', op: 'setIoDeviceLState' },
];
const rws1Ran: Array<{ readme: string; op: string; file: string }> = [
  { readme: 'setting a base frame', op: 'setMechunitBaseFrame', file: 'motion' },
  { readme: 'the keyless motors-on', op: 'setKeylessMotorOn', file: 'panel' },
  { readme: 'reading the task selection', op: 'getTaskSelection', file: 'rapid' },
];

/** An operation's RWS 1.0 column in the vendored client's operations table. */
const rws1Column = (clientReadme: string, op: string): string | undefined =>
  new RegExp(`^\\| \`${op}\` \\| \\w+ \\| ([\\w-]+) \\|`, 'm').exec(clientReadme)?.[1];

const heading: Record<Gen, RegExp> = { 'RWS 1.0': /^### RWS 1\.0/, 'RWS 2.0': /^### RWS 2\.0/ };

describe('Known limits in the README', () => {
  const clientReadme = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'README.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  it('each operation named is one the vendored client lists as never run on that generation', () => {
    for (const { ops, gens } of neverRun) {
      for (const gen of gens) {
        const list = subsection(clientReadme, heading[gen]);
        for (const op of ops) { assert.match(list, new RegExp(`^- \`${op}\``, 'm'), `${op} on ${gen}`); }
      }
    }
  });

  it('names each such command by its title under that generation', () => {
    for (const { commands, gens } of neverRun) {
      for (const gen of gens) {
        const list = subsection(readme, heading[gen]);
        for (const id of commands) { assert.ok(list.includes(titleOf(id)), `${titleOf(id)} under ${gen}`); }
      }
    }
  });

  it('names each error-dialog button not yet run from the button, with its generation, under Dialogs', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'refusalUi.ts'), 'utf8');
    const list = subsection(readme, /^### Dialogs/);
    for (const { button, source: written, ops, gens } of dialogs) {
      assert.ok(source.includes(written), `${button} is a button in src/refusalUi.ts`);
      for (const gen of gens) {
        // The operation is one the vendored client documents.
        for (const op of ops) { assert.ok(clientReadme.includes(`\`${op}`), `${op} in the client README`); }
        const line = list.split('\n').find(l => l.includes(`**${button}**`));
        assert.ok(line, `${button} under Dialogs`);
        assert.ok(line.includes(gen), `${button}: ${gen}`);
        assert.match(line, /not yet run/, `${button}: says it has not run`);
        for (const op of ops) { assert.ok(line.includes(`\`${op}\``), `${button}: ${op}`); }
      }
    }
  });

  it('lists Request Remote Control under RWS 1.0 at the exec level, and states the modify grant the vendored client records', () => {
    const line = subsection(readme, heading[rmmpExecOnly.gen]).split('\n')
      .find(l => l.startsWith('- ') && l.includes(titleOf(rmmpExecOnly.command)));
    assert.ok(line, `${titleOf(rmmpExecOnly.command)} under ${rmmpExecOnly.gen}`);
    assert.match(line, /`exec` level: not yet sent on RobotWare 6\./);
    const dialog = subsection(readme, /^### Dialogs/).split('\n').find(l => l.includes('**Request Remote Control**'));
    assert.ok(dialog, 'Request Remote Control under Dialogs');
    // The client's own record: never run on RWS 1.0 (no grant may be claimed), or live there,
    // with `modify` granted at the FlexPendant on a 6.16.03 virtual controller in MANR and
    // `exec` not yet sent.
    const neverRunRws1 = /^- `requestRmmp`/m.test(subsection(clientReadme, heading['RWS 1.0']));
    const row = clientPathRow('usersUas', 'requestRmmp');
    for (const l of [line, dialog]) {
      if (neverRunRws1) {
        assert.doesNotMatch(l, /granted/, 'the vendored client lists requestRmmp as never run on RWS 1.0, so no grant is claimed there');
      } else {
        assert.match(row, /evidence: 'live'/);
        assert.match(row, /RW 6\.16\.03 \(MANR\): modify answered 202 and was granted at the FlexPendant; exec is still to be tried on RWS 1\.0/);
        assert.match(l, /`modify` (request )?was granted at the FlexPendant on a 6\.16\.03 virtual controller in manual reduced speed\./);
      }
    }
    assert.match(subsection(clientReadme, /^### Open at this release/), /RobotWare 6: `exec` has not been sent\./);
    // The command's pick list says the same for exec on RobotWare 6.
    const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(source, /'not yet sent on RobotWare 6; ABB does not say what exec covers there'/);
    assert.doesNotMatch(source, /ABB documents nothing for exec/);
  });

  it('says that RobotWare 8 refuses the jog and every RAPID start until motion control is allowed, and how RAPID Live allows it', () => {
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 8: the controller refuses the jog'));
    assert.ok(line, 'a RobotWare 8 line on motion control');
    assert.ok(line.includes(titleOf('abbRobot.jog')), 'names Jog Robot');
    assert.ok(line.includes(titleOf('abbRobot.startRapid')), 'names Start RAPID');
    assert.match(line, /Run Routine/);
    assert.match(line, /even for a program that moves nothing/);
    assert.ok(line.includes(titleOf('abbRobot.allowMotionControl')), 'names Allow Motion Control (RobotWare 8)');
    assert.ok(line.includes('`setAllowMotionControl`'), 'names the client method');
    assert.match(line, /The client withdraws it as the first request of a disconnect; if that withdrawal does not go through, whether the controller still counts it is not known\./);
    // No lifetime is claimed: what the controller does when a withdrawal does not go through is not known.
    assert.doesNotMatch(line, /at most/);
    assert.match(line, /Stop RAPID is a program stop; RAPID Live gives no emergency stop or normal stop\./);
    assert.match(line, /nothing is retried/);
    assert.match(line, /Run Routine after it, Withdraw and the withdrawal at disconnect ran on an 8\.2\.1 virtual controller; Start RAPID's and the jog's confirmations have not run against a controller\./);
    assert.match(line, /the allowance belongs to the control station, and when RAPID Live ends without the withdrawal \(a crash\), the controller keeps it for that station for more than 7 minutes; unless the robot's settings name a `controlStation`, RAPID Live registers under an id made for its connection, so no other window or tool takes it over\. With a fixed `controlStation`, the client withdraws such a leftover at its first registration, and the robot reads not allowed\.$/);
    // The withdrawals held off in this release are named, and RAPID Live's switch constant is off.
    const held = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 8: in this release RAPID Live does not withdraw motion control when you switch the active robot'));
    assert.ok(held, 'a line on the withdrawals held off');
    const mc = fs.readFileSync(path.join(root, 'src', 'motionControl.ts'), 'utf8');
    assert.match(mc, /export const MOTION_CONTROL_SWITCH: \{ withdrawOnSwitch: boolean \} = \{ withdrawOnSwitch: false \};/,
      'the switch withdrawal was turned on: update the held-off line, the confirmation text and the CHANGELOG');
    // The vendored client explains the start refusal as motion-control-off, as the jog's, and holds off its two withdrawals.
    assert.match(subsection(clientReadme, /^### Open at this release/),
      /The client explains that refusal as `GRANT_DENIED`, `refusal\.kind` `motion-control-off`, on every call that starts RAPID/);
    const triggers = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'access', 'motionControl.js'), 'utf8');
    assert.match(triggers, /modeChange: false,\s*takeBack: false/,
      'the vendored client turned on a withdrawal on a mode change or a take-back: update the held-off line and the confirmation text');
  });

  it('allows motion control only in the allow flow, after the typed-name confirmation of tier declaration', () => {
    // RAPID Live calls setAllowMotionControl only in src/motionControl.ts.
    for (const file of fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.ts') && f !== 'motionControl.ts')) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', file), 'utf8'), /setAllowMotionControl\s*\(/, file);
    }
    const mc = fs.readFileSync(path.join(root, 'src', 'motionControl.ts'), 'utf8');
    // Every call there passes a literal; true appears once.
    const calls = mc.match(/\.setAllowMotionControl\s*\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 2, calls.join(', '));
    for (const c of calls) { assert.match(c, /^\.setAllowMotionControl\((true|false)\)$/, c); }
    assert.equal(calls.filter(c => c === '.setAllowMotionControl(true)').length, 1);
    // It is inside runAllow, after the confirmation, whose request has the tier declaration.
    const from = mc.indexOf('export async function runAllow(');
    const allow = mc.slice(from, mc.indexOf('\n}\n', from));
    const confirmed = allow.indexOf('if (!await confirmWrite(ui, ctx.robot, request)) { return \'not-sent\'; }');
    assert.ok(confirmed > 0, 'the allow flow asks through confirmWrite and returns when it is not confirmed');
    assert.ok(confirmed < allow.indexOf('setAllowMotionControl(true)'), 'the confirmation comes before the call');
    assert.match(allow, /const request = declarationRequest\(confirmation, /);
    assert.match(mc, /return \{ label: ALLOW_LABEL, tier: 'declaration', sideEffects: lines, confirmation \};/);
  });

  it('says the MP line reads the motionpointer entry on both generations, what the client read with a program running, and why the read stays listed', () => {
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- ') && l.includes(titleOf('abbRobot.showProgramPointer')));
    assert.ok(line, `${titleOf('abbRobot.showProgramPointer')} under Open at this release`);
    // The client's own request for the motion pointer, as its path table holds it: the
    // program pointer resource on both generations, built while the evidence index does not
    // credit it.
    const row = clientPathRow('rapid', 'getMotionPointer');
    assert.match(row, /rws1: \{ method: 'GET', path: '\/rw\/rapid\/tasks\/\{task\}\/pcp' \}/,
      'the vendored client changed its RWS 1.0 motion pointer read: update the Motion Pointer line, the RWS 1.0 list and the neverRun row');
    assert.match(row, /rws2: \{ method: 'GET', path: '\/rw\/rapid\/tasks\/\{task\}\/pcp' \}/,
      'the vendored client changed its RWS 2.0 motion pointer read: update the Motion Pointer line, the CHANGELOG and docs/RWS_COVERAGE.md');
    assert.match(row, /evidence: 'built'/,
      'the vendored client credits the motion pointer read: say so in the Motion Pointer line and take it out of both lists');
    // The vendored client's record of a filled motion pointer, and why the read stays built.
    assert.match(row, /The parsed motion pointer \(row 9 col 16\) was logged on RW 6\.16\.03 and 7\.21\.4 virtual controllers\./,
      'the vendored client changed its record of the filled motion pointer: update the Motion Pointer line, the CHANGELOG and docs/RWS_COVERAGE.md');
    // The client's reason: the shared answer carries the entry with no position before a
    // program starts, and the logs keep no answer body.
    assert.match(row, /Stays built: it sends the same request as getProgramPointer, whose answer carries this entry with no position when no program has started, and the logs keep no answer body, so a logged 2xx does not show that a position was read\./,
      'the vendored client changed why the motion pointer read stays built: update the Motion Pointer line, the CHANGELOG and docs/RWS_COVERAGE.md');
    assert.match(subsection(clientReadme, /^### Open at this release/),
      /^- `getMotionPointer` stays in both lists although its request answers 2xx: it sends the same `GET \/rw\/rapid\/tasks\/\{task\}\/pcp` as `getProgramPointer`, and that answer carries the motionpointer entry with no position when no program has started\. The logs keep no answer body, so a logged 2xx does not show that a motion pointer with a position was read, and the evidence index does not credit it\. On RobotWare 6\.16\.03 and 7\.21\.4 virtual controllers it read row 9 col 16 while a MoveAbsJ ran\. On RobotWare 8 no program ran for it: the start was refused without the motion-control declaration\.$/m);
    assert.match(line, /the client reads the motion pointer from the `motionpointer` entry of the task's program pointer resource, on both generations/);
    assert.match(line, /On RobotWare 6\.16\.03 and 7\.21\.4 virtual controllers the client read a filled motion pointer \(row 9, column 16\) while a MoveAbsJ ran\./);
    assert.match(line, /On RobotWare 8 no program ran for it: the start was refused without the motion-control declaration\./);
    assert.match(line, /The read stays in both lists below\. It sends the same request as the program pointer read, whose answer carries that entry with no position when no program has started\. The client's logs keep no answer body, so a logged 2xx answer does not show that a position was read\./);
    assert.doesNotMatch(readme, /cannot tell the two reads apart/);
    assert.match(line, /While the controller reports none \(no program started\), the MP line shows dashes\./);
    assert.doesNotMatch(readme, /MP line stays empty/);
    assert.doesNotMatch(readme, /not yet run with a position filled in/);
    // Each list entry points at that line.
    for (const gen of ['RWS 1.0', 'RWS 2.0'] as const) {
      const entry = subsection(readme, heading[gen]).split('\n').find(l => l.includes(titleOf('abbRobot.showProgramPointer')));
      assert.ok(entry, `${titleOf('abbRobot.showProgramPointer')} under ${gen}`);
      assert.match(entry, /\(`getMotionPointer`\), listed although its request answers; see Open at this release$/, gen);
    }
    // The corrected-requests paragraph names it, and the coverage notes say the same.
    assert.match(readme, /the motion pointer \(the\s+`motionpointer` entry of the program pointer resource, on both generations\)/);
    const coverage = fs.readFileSync(path.join(root, 'docs', 'RWS_COVERAGE.md'), 'utf8');
    assert.match(coverage, /client 1\.5\.1 reads the position from the `motionpointer` entry of `GET \/rw\/rapid\/tasks\/\{task\}\/pcp` on both generations/);
    // The client's whole reason: the shared answer carries the entry with no position
    // before a program starts, and the logs keep no answer body.
    assert.match(coverage, /there it read row 9, column 16 while a MoveAbsJ ran\. The client keeps the read in its never-run lists\. It sends the same request as the program pointer read, whose answer carries this entry with no position when no program has started\. The client's logs keep no answer body, so a logged 2xx answer does not show that a position was read\./);
    assert.doesNotMatch(coverage, /still lists the read as never run/);
    assert.doesNotMatch(coverage, /cannot tell the two reads apart/);
    assert.doesNotMatch(coverage, /does not read on either generation/);
    assert.doesNotMatch(coverage, /not yet run with a position filled in/);
    // The notes prepared as 1.3.0 (folded into 1.4.0) say the same.
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const from = changelog.indexOf('\n### Prepared as 1.3.0 (not published)');
    assert.ok(from >= 0, 'the notes prepared as 1.3.0 in the CHANGELOG');
    const notes = changelog.slice(from, changelog.indexOf('\n## ', from + 1));
    assert.match(notes, /there it read\s+row 9, column 16 while a MoveAbsJ ran\. The client keeps the read in its\s+never-run lists\. It sends the same request as the program pointer read,\s+whose answer carries this entry with no position when no program has\s+started\. The client's logs keep no answer body, so a logged 2xx answer does\s+not show that a position was read\./);
    assert.match(notes, /the\s+client read a filled one on 6\.16\.03 and 7\.21\.4 virtual controllers and\s+keeps it in its never-run lists: before a program starts, that resource\s+carries the entry with no position, and the client's logs keep no answer\s+body\./);
    assert.doesNotMatch(notes, /still lists the read as\s+never run/);
    assert.doesNotMatch(notes, /cannot\s+tell\s+the\s+two\s+reads\s+apart/);
    assert.doesNotMatch(notes, /cannot\s+tell\s+it\s+from\s+the\s+program\s+pointer\s+read/);
    assert.doesNotMatch(notes, /not yet run with a position filled in/);
  });

  it('names under RobotWare 6 the RWS 1.0 form the vendored client lacks, the ones it has built but not run, and the ones that ran', () => {
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 6: `abb-rws-client` has no RWS 1.0 form for'));
    assert.ok(line, 'a RobotWare 6 line on the RWS 1.0 forms of the client');
    const [missing, ...rest] = line.split('. ');
    const built = rest.find(s => s.includes('are built from ABB\'s RWS 1.0 pages and not yet run'));
    assert.ok(built, 'a sentence on the RWS 1.0 forms built and not yet run');
    const clientLine = subsection(clientReadme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 6 (RWS 1.0):'));
    assert.ok(clientLine, 'the vendored client has a RobotWare 6 line');
    const neverRunRws1 = subsection(clientReadme, heading['RWS 1.0']);
    for (const m of rws1Missing) {
      assert.equal(rws1Column(clientReadme, m.op), '-', `the vendored client now has an RWS 1.0 form for ${m.readme}: move it to the built sentence`);
      assert.ok(clientLine.includes(`the client has no RWS 1.0 form for \`${m.op}\``), `the vendored client names ${m.op} as missing on RWS 1.0`);
      assert.ok(missing.includes(m.readme), `README names ${m.readme} as missing`);
      assert.ok(!built.includes(m.readme), `README does not call ${m.readme} built`);
    }
    for (const b of rws1Built) {
      assert.equal(rws1Column(clientReadme, b.op), 'built', `${b.op} on RWS 1.0 is no longer built-not-run in the vendored client: update the README's RobotWare 6 line`);
      assert.match(neverRunRws1, new RegExp(`^- \`${b.op}\``, 'm'), `${b.op} under RWS 1.0 in the vendored client's never-run list`);
      assert.ok(built.includes(b.readme), `README names ${b.readme} as built and not yet run`);
      assert.ok(!missing.includes(b.readme), `README no longer says the client lacks ${b.readme}`);
    }
    const ran = rest.find(s => s.includes('ran on a 6.16.03 virtual controller'));
    assert.ok(ran, 'a sentence on the RWS 1.0 forms that ran on a 6.16.03 virtual controller');
    for (const r of rws1Ran) {
      assert.equal(rws1Column(clientReadme, r.op), 'live', `${r.op} on RWS 1.0 is no longer live in the vendored client: update the README's RobotWare 6 line`);
      assert.doesNotMatch(neverRunRws1, new RegExp(`^- \`${r.op}\``, 'm'), `${r.op} is off the vendored client's RWS 1.0 never-run list`);
      assert.match(clientPathRow(r.file, r.op), /RW 6\.16\.03/, `the vendored client's ${r.op} row names the RW 6.16.03 run`);
      assert.ok(ran.includes(r.readme), `README names ${r.readme} as run on a 6.16.03 virtual controller`);
      assert.ok(!built.includes(r.readme), `README no longer calls ${r.readme} built and not yet run`);
      assert.ok(!missing.includes(r.readme), `README does not say the client lacks ${r.readme}`);
    }
    // The extension line on its own commands claims no RWS 1.0 client methods.
    assert.doesNotMatch(subsection(readme, /^### Open at this release/), /their RWS 1\.0 forms have not run/);
  });

  it('says RAPID Live has no command for the client writes it does not offer, and sends none of them', () => {
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RAPID Live has no command for'));
    assert.ok(line, 'a line on the client writes RAPID Live has no command for');
    for (const name of ['Modify Position', 'removing a breakpoint', 'setting a base frame', 'signal simulation',
      'unblocking signals', 'enabling or disabling an I/O device', 'the keyless motors-on']) {
      assert.ok(line.includes(name), `names ${name}`);
    }
    assert.match(line, /on any generation\.$/);
    for (const file of fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
      for (const op of ['modifyPosition', 'removeBreakpoint', 'setMechunitBaseFrame', 'setSignalSimulated',
        'unblockSignals', 'setIoDeviceLState', 'setKeylessMotorOn']) {
        assert.doesNotMatch(source, new RegExp(`\\b${op}\\s*\\(`), `${file} calls ${op}`);
      }
    }
  });

  it('says Restore Backup keeps the backup on both generations, as the vendored client sends it, and where it has run', () => {
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- Restore Backup keeps the backup'));
    assert.ok(line, 'a line on Restore Backup keeping the backup');
    const row = clientPathRow('ctrl', 'restoreBackup');
    assert.match(row, /evidence: \{ rws1: 'live', rws2: 'built' \}/);
    assert.match(row, /rws2: \{ method: 'POST', path: '\/ctrl\/backup\/restore', fields: \['backup', 'delete-dir'\] \}/);
    assert.match(row, /rws1: \{ method: 'POST', path: '\/ctrl\/backup', action: 'restore', fields: \['backup', 'delete-dir'\] \}/);
    assert.match(line, /on both generations the client sends ABB's `delete-dir` as false/);
    assert.match(line, /The restore has run on RobotWare 6\. It has not been sent on RobotWare 7 or 8/);
  });

  it('says what the load and the unload report for a module the controller renamed, as the vendored client does', () => {
    const clientLine = subsection(clientReadme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 7 (seen once, on 7.21.4): a module named like one of its own global symbols'));
    assert.ok(clientLine, 'the vendored client has a line on the module name clash');
    assert.match(clientLine, /`loadProgram` reports the name the controller gave the module/,
      'the vendored client no longer reports the name it gave the module: update the name-clash line');
    assert.match(clientLine, /\(403 -1073414145, its reason written in the event log\)/);
    assert.match(clientLine, /that refusal of `unloadModule` carries the newest event-log message, which may be about something else/,
      'the vendored client changed what an unload refused this way carries: update the name-clash line');
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 7, seen once on 7.21.4: a module named like one of its own global symbols'));
    assert.ok(line, 'a line on the module name clash');
    for (const id of ['abbRobot.uploadModule', 'abbRobot.pushCurrentFile', 'abbRobot.unloadModule']) {
      assert.ok(line.includes(titleOf(id)), `names ${titleOf(id)}`);
    }
    assert.match(line, /then names the module by that name\./);
    assert.match(line, /\(403, -1073414145: the reason is written in the event log\); the error then shows the newest event-log message, which may be about something else\./);
    assert.match(line, /Neither error has been shown from a controller yet\./);
    // The load's report reaches the dialog: a semantic error keeps a report of steps done (test/loadReport.test.ts).
    const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(source, /return semanticErrorText\(label, raw, refusal \? refusalMessage\(label, raw, refusal, gen, robot\) : undefined\);/);
  });

  it('says on RobotWare 8 that the speed ratio could miss the live updates, and what the vendored client does about it', () => {
    const clientLine = subsection(clientReadme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 8: an 8.2.1 virtual controller left speed ratio out of'));
    assert.ok(clientLine, 'the vendored client has a RobotWare 8 line on the speed ratio left out of its subscription');
    // The second create ran on the 8.2.1 virtual controller (2026-10-22); the full-rate fallback has not.
    assert.match(clientLine, /creates the group once more with that resource in its other spelling and, if it is still left out, polls everything at the full rate\./,
      'the vendored client changed what it does about a speed ratio left out: update the speed ratio line');
    assert.match(clientLine, /In a test run on 2026-10-22 that virtual controller left speed ratio out of every group that asked for `\/rw\/panel\/speedratio;speedratio` \(\d+\), and each group created with `\/rw\/panel\/speedratio` bound it; the full-rate polling, for a resource left out in both spellings, has not run against a controller\./,
      'the vendored client changed what ran of the speed ratio fallback: update the speed ratio line');
    // The count of requests left without it is the client's.
    const leftOut = /speedratio;speedratio` \((\d+)\)/.exec(clientLine)?.[1];
    assert.ok(leftOut, 'the vendored client counts the requests that left speed ratio out');
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 8: an 8.2.1 virtual controller sometimes left the speed ratio out'));
    assert.ok(line, 'a RobotWare 8 line on the speed ratio');
    assert.match(line, /showed only at the next slow poll; the cause is not known\. The client now asks once more, with the resource in its other spelling, and if it is still left out polls everything at the full rate\./);
    assert.ok(line.includes(`In a test run on 2026-10-22 that virtual controller left the speed ratio out of all ${leftOut} subscription requests that named \`/rw/panel/speedratio;speedratio\`, and took it in each one that named \`/rw/panel/speedratio\`;`),
      `names the client's count (${leftOut}) and both spellings`);
    assert.match(line, /; the full-rate polling, for a speed ratio left out in both spellings, has not run against a controller\.$/);
    assert.doesNotMatch(line, /That has not yet run against a controller/);
  });

  it('says on RobotWare 6 that Export Event Log writes every page the vendored client reads, and that the page walk ran on a virtual controller', () => {
    const row = clientReadme.split('\n').find(l => l.startsWith('| `getEventLog(domain?, lang?)` |'));
    assert.ok(row, 'the vendored client documents getEventLog');
    assert.match(row, /every page up to 20 \(about 1000 messages\) on both generations/,
      'the vendored client changed how much of the event log it reads: update the RobotWare 6 export line and the CHANGELOG');
    assert.match(row, /Newest first on RWS 1\.0, which follows the listing's `next` link/);
    assert.match(row, /One call sends one request per page, up to 20/);
    const walk = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'RwsClient.js'), 'utf8');
    assert.match(walk, /A later page that fails ends the\s+\* walk with the messages already read/,
      'the vendored client changed what a failed later page does: update the RobotWare 6 export line');
    // RAPID Live exports through RobotManager.getEventLog, which reads every page.
    assert.match(fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8'), /const log = await entry\.manager\.getEventLog\(domain\);/);
    const line = subsection(readme, /^### Open at this release/).split('\n')
      .find(l => l.startsWith('- RobotWare 6: Export Event Log writes the whole domain'));
    assert.ok(line, 'a RobotWare 6 line on Export Event Log');
    assert.ok(line.includes(titleOf('abbRobot.exportEventLog')), 'names Export Event Log');
    assert.match(line, /up to 20 pages of 50 messages \(about 1000\), where earlier releases wrote the newest 50 only\./);
    assert.match(line, /one export sends one request per page, and a later page that fails ends the export with the messages read so far\./);
    assert.match(line, /On a 6\.16\.03 virtual controller the client's page walk read the whole domain, 312 messages over seven pages\.$/);
  });

  it('names Switch Operation Mode under RWS 1.0, where the client refuses it before sending', () => {
    assert.match(subsection(clientReadme, /^### Unsupported/), /^- `setOperationMode` - RWS 1\.0:/m);
    assert.ok(subsection(readme, heading['RWS 1.0']).includes(titleOf('abbRobot.setOpMode')));
  });

  it('holds back no command any more: Call Service Routine moves the pointer on both generations', () => {
    assert.doesNotMatch(readme, /^### Commands held back/m);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', 'serviceRoutine.ts'), 'utf8'), /HELD_BACK/);
  });

  it('says under Virtual Time that pause and resume are not offered, and where the clock is controlled', () => {
    const list = subsection(readme, /^### Virtual Time/);
    assert.ok(list.includes(titleOf('abbRobot.showVirtualTime')), 'names the command by its title');
    assert.match(list, /pause and resume are not offered/i);
    assert.match(list, /RAPID Live does not set virtual time on RobotWare 6 in this release/);
    assert.match(list, /RobotStudio's Simulation tab/);
    // ABB's RWS 1.0 documents the speed write; RAPID Live does not send it, which is not "read-only".
    assert.doesNotMatch(readme, /read-only on RobotWare 6/i);
    assert.match(subsection(readme, /^### Open at this release/),
      /^- RobotWare 6: RAPID Live does not set virtual time in this release, although ABB's RWS 1\.0 documents the speed write\./m);
    // Consistent with the source: the command offers no pause or resume.
    const source = fs.readFileSync(path.join(root, 'src', 'virtualTime.ts'), 'utf8');
    assert.doesNotMatch(source, /setVirtualTimeRunning/);
  });

  it('does not call Validate RAPID Value experimental: the client logs it answered on both generations', () => {
    for (const gen of ['RWS 1.0', 'RWS 2.0'] as const) {
      assert.doesNotMatch(subsection(clientReadme, heading[gen]), /^- `validateRapidValue`/m, gen);
    }
    assert.doesNotMatch(titleOf('abbRobot.validateRapidValue'), /experimental/i);
  });

  it('names under each generation only operations the vendored client lists as never run there', () => {
    for (const gen of ['RWS 1.0', 'RWS 2.0'] as const) {
      const clientList = subsection(clientReadme, heading[gen]);
      for (const line of subsection(readme, heading[gen]).split('\n').filter(l => l.startsWith('- '))) {
        for (const group of line.matchAll(/\(([^)]*)\)/g)) {
          for (const op of [...group[1].matchAll(/`(\w+)`/g)].map(x => x[1])) {
            assert.match(clientList, new RegExp(`^- \`${op}\``, 'm'), `${op} under ${gen}`);
          }
        }
      }
    }
  });

  it('does not list Lock or Unlock Operation Mode under RWS 2.0: both answered 204 on RobotWare 7.21.4, 8.1.1 and 8.2.1 virtual controllers', () => {
    for (const op of ['lockOperationMode', 'unlockOperationMode']) {
      assert.doesNotMatch(subsection(clientReadme, heading['RWS 2.0']), new RegExp(`^- \`${op}\``, 'm'), `${op} on RWS 2.0`);
      assert.match(subsection(clientReadme, heading['RWS 1.0']), new RegExp(`^- \`${op}\``, 'm'), `${op} on RWS 1.0`);
    }
    const list = subsection(readme, heading['RWS 2.0']);
    assert.ok(!list.includes(titleOf('abbRobot.lockOpMode')), 'Lock Operation Mode is not under RWS 2.0');
    assert.ok(!list.includes(titleOf('abbRobot.unlockOpMode')), 'Unlock Operation Mode is not under RWS 2.0');
  });
});
