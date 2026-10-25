import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RWS1Adapter, RwsError, type RwsClient } from 'abb-rws-client';
import { CFG_LOAD_LABEL, cfgFallbackMessage, cfgLoadNextStep, loadActionDetail } from '../src/cfgLoad';
import { refusalButtons, refusalMessage, remedyNote, withNote } from '../src/refusalUi';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const NAME_EXIST = -1073437689;
const DATA_INCORRECT = -1073437688;
const CFG_VERSION = -1073437686;

/**
 * A load refused by the vendored client's RWS 1.0 adapter. The body is RobotWare 6's
 * `?json=1` error shape with the message a 6.16.03 virtual controller gave for a saved
 * domain loaded back with "add" (2026-10-12), as the client's own test holds it. A fake
 * transport answers it; no controller is involved.
 */
async function refusedLoad(code: number): Promise<RwsError> {
  const msg = `C:\\BUILD\\rws_component_cfg.cpp[512]: org_code: 3500 new_code: 0xc0048410;  code:${code} icode:-1`;
  const body = `{"_links":{"base": { "href": "http://127.0.0.1:80/" }},"_embedded" :{ "status" : {"code":${code}, "msg": ${JSON.stringify(msg)}}, "_state":[  ] }}`;
  const fake = {
    requestMastership: async () => {},
    releaseMastership: async () => {},
    request: async (method: string, url: string) =>
      method === 'POST' && url.startsWith('/rw/cfg?action=load') ? { status: 400, body } : { status: 204, body: '' },
  };
  const e = await new RWS1Adapter(fake as unknown as RwsClient).loadCfgFile('$TEMP/EIO.cfg', 'add').then(
    () => { throw new Error('expected the load to be refused'); }, (err: unknown) => err);
  assert.ok(e instanceof RwsError);
  return e;
}

/** The text showError builds for Load CFG file, without the robot's name in front. */
function shown(e: RwsError): string {
  return withNote(refusalMessage('Load CFG file', e.message, e.refusal!, 'rw6'), cfgLoadNextStep(e));
}

describe('Load .cfg File: a load the controller refused, explained by the client', () => {
  it('"name already exists" (-1073437689): the client\'s sentence, then its next step', async () => {
    const e = await refusedLoad(NAME_EXIST);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(e.controllerCode, NAME_EXIST);
    assert.equal(e.refusal?.kind, 'invalid-argument');
    assert.match(e.message, /^The controller refused to load the configuration file: a named instance in the file already exists on the controller/);
    const step = cfgLoadNextStep(e);
    assert.equal(step, e.refusal?.remedy?.detail);
    assert.match(step ?? '', /^Load a file that holds only instances the controller does not have yet, or remove the existing instance first/);
    const text = shown(e);
    assert.ok(text.startsWith(`Load CFG file: ${e.message}`), 'the client\'s message is kept whole');
    assert.ok(text.endsWith(` ${step}`), 'its next step follows it');
    assert.equal(text.split(step!).length, 2, 'the step is shown once');
    assert.doesNotMatch(text, /mastership|write access|RMMP/i);
  });

  it('"file contains errors" (-1073437688): the client\'s sentence, then its next step', async () => {
    const e = await refusedLoad(DATA_INCORRECT);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(e.refusal?.kind, 'invalid-argument');
    assert.match(e.message, /^The controller refused to load the configuration file: it says the file contains errors/);
    const step = cfgLoadNextStep(e);
    assert.match(step ?? '', /^Check the file\./);
    assert.ok(shown(e).endsWith(` ${step}`));
  });

  it('a malformed version header (-1073437686): the client\'s sentence, then its next step', async () => {
    const e = await refusedLoad(CFG_VERSION);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(e.controllerCode, CFG_VERSION);
    assert.equal(e.refusal?.kind, 'invalid-argument');
    assert.match(e.message, /^The controller refused to load the configuration file: the file's version header is malformed/);
    const step = cfgLoadNextStep(e);
    assert.match(step ?? '', /^Check the file's first line, its version header/);
    assert.match(step ?? '', /Then load it again\.$/);
    const text = shown(e);
    assert.ok(text.startsWith(`Load CFG file: ${e.message}`));
    assert.ok(text.endsWith(` ${step}`));
    assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, e), undefined, 'the client explained it');
  });

  it('gives no button and no other note for any of the three: the next step is a fix to the file', async () => {
    for (const code of [NAME_EXIST, DATA_INCORRECT, CFG_VERSION]) {
      const e = await refusedLoad(code);
      assert.deepEqual(refusalButtons(e.refusal!, 'rw6', 'Cell 3'), []);
      assert.equal(remedyNote(e.refusal, 'rw6'), undefined, 'refusalMessage does not add the step itself');
    }
  });

  it('adds nothing for an error that is not a refusal of the input', () => {
    assert.equal(cfgLoadNextStep(new Error('HTTP 404 from POST /rw/cfg')), undefined);
    assert.equal(cfgLoadNextStep(undefined), undefined);
    assert.equal(cfgLoadNextStep(new RwsError('x', 'UNKNOWN', 400, undefined, NAME_EXIST)), undefined);
    const withCall = { refusal: { remedy: { kind: 'request-rmmp', detail: 'Ask for remote control.', call: { method: 'requestRmmp', level: 'modify' } } } };
    assert.equal(cfgLoadNextStep(withCall), undefined);
    assert.equal(cfgLoadNextStep({ refusal: { remedy: { kind: 'fix-input', detail: '' } } }), undefined);
  });
});

describe('Load .cfg File: the pick list and the command', () => {
  it('describes "add" by what was seen, not as a merge that leaves existing instances alone', () => {
    assert.match(loadActionDetail('add'), /named instance .* already exists/i);
    assert.doesNotMatch(loadActionDetail('add'), /existing ones unchanged/);
    assert.ok(loadActionDetail('replace').length > 0);
    assert.ok(loadActionDetail('add-with-reset').length > 0);
  });

  it('the command uses the pick list and the client\'s next step; RAPID Live\'s own sentence comes only after the client\'s', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.loadCfgFile'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.includes('loadActionDetail('));
    assert.ok(body.includes('showError(CFG_LOAD_LABEL, e, entry, cfgLoadNextStep(e))'));
    // The two codes are in cfgLoad.ts only; extension.ts asks for RAPID Live's sentence after the refusal branch.
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /-1073437689|-1073437688|CFG_NAME_EXIST|CFG_DATA_INCORRECT/);
    const fn = src.slice(src.indexOf('function friendlyErrorMessage('));
    const clientFirst = fn.indexOf('return refusalMessage(label, raw, refusal, gen, robot);');
    const own = fn.indexOf('cfgFallbackMessage(label, e)');
    assert.ok(clientFirst > 0 && own > clientFirst, 'the client\'s refusal decides before RAPID Live\'s own sentence');
  });
});

describe('Load .cfg File: RAPID Live\'s own sentence, only when the client explained nothing', () => {
  it('is not used for a load the client refused: the client\'s sentence is shown', async () => {
    for (const code of [NAME_EXIST, DATA_INCORRECT]) {
      const e = await refusedLoad(code);
      assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, e), undefined, String(code));
    }
  });

  it('names the file\'s refusal for either code when the error carries no refusal', () => {
    const exists = cfgFallbackMessage(CFG_LOAD_LABEL, new RwsError('HTTP 400', 'UNKNOWN', 400, undefined, NAME_EXIST));
    assert.match(exists ?? '', /^Load CFG file: the controller refused to load the file: a named instance in the file already exists on the controller \("Name already exists in database", SYS_CTRL_E_CFG_NAME_EXIST\)\./);
    assert.match(exists ?? '', /Load a file that holds only instances the controller does not have yet, or remove the existing instance first\.$/);
    // RobotWare 6 writes the code inside a wrapper with other codes.
    const wrapped = new Error('C:\\BUILD\\rws_component_cfg.cpp[512]: org_code: 3500 new_code: 0xc0048410;  code:-1073437688 icode:-1');
    const errors = cfgFallbackMessage(CFG_LOAD_LABEL, wrapped);
    assert.match(errors ?? '', /^Load CFG file: the controller refused to load the file: it says the file contains errors \("Cfg file contains errors", SYS_CTRL_E_CFG_DATA_INCORRECT\), and does not say which line\. Check the file\./);
    assert.doesNotMatch(errors ?? '', /held|mastership/i);
  });

  it('names the instance, not a file, for another operation', () => {
    const create = cfgFallbackMessage('Create CFG instance', new RwsError('HTTP 400', 'UNKNOWN', 400, undefined, NAME_EXIST));
    assert.match(create ?? '', /^Create CFG instance: the controller refused it: an instance of that name already exists/);
    assert.doesNotMatch(create ?? '', /file/);
    assert.match(cfgFallbackMessage('Create CFG instance', new Error('code:-1073437688')) ?? '', /configuration data contains errors/);
  });

  it('adds nothing for any other error', () => {
    assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, new Error('HTTP 404 from POST /rw/cfg')), undefined);
    assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, new Error('code:-10734376890')), undefined);
    assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, undefined), undefined);
    assert.equal(cfgFallbackMessage(CFG_LOAD_LABEL, new RwsError('x', 'UNKNOWN', 400, undefined, -1073445872)), undefined);
  });
});
