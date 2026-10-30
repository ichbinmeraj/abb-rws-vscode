import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { afterLoad, declaresMain, ppToMainRequest, PP_TO_MAIN_BUTTON, type AfterLoadUi } from '../src/ppAfterLoad';
import type { ConfirmRequest } from '../src/confirm';

const withMain = 'MODULE Rob2Main\n  PROC main()\n    TPWrite "hi";\n  ENDPROC\nENDMODULE\n';
const noMain = 'MODULE Rob2Lib\n  PROC helper()\n  ENDPROC\nENDMODULE\n';

/** A UI that answers the offer and the confirmation as told, and counts the moves. */
function fakeUi(offerYes: boolean, confirmYes: boolean) {
  const log = { info: [] as string[], offers: [] as string[], confirms: [] as ConfirmRequest[], resets: 0 };
  const ui: AfterLoadUi = {
    info: m => { log.info.push(m); },
    offer: async (m, button) => { log.offers.push(`${m} [${button}]`); return offerYes; },
    // The extension's hook asks and then sends: one call, counted as the ask and, when confirmed, the move.
    moveToMain: async r => { log.confirms.push(r); if (confirmYes) { log.resets++; } return confirmYes; },
  };
  return { ui, log };
}

describe('PP to Main after Push and Load', () => {
  it('a file without PROC main gets the success message and no offer', async () => {
    const { ui, log } = fakeUi(true, true);
    assert.equal(await afterLoad(ui, noMain, '✓ Pushed Rob2Lib.mod to T_ROB2 on Cell 2.', ['T_ROB1', 'T_ROB2']), 'no-main');
    assert.deepEqual(log.info, ['✓ Pushed Rob2Lib.mod to T_ROB2 on Cell 2.']);
    assert.equal(log.offers.length, 0);
    assert.equal(log.resets, 0);
  });

  it('a file with PROC main is offered the move and says the pointer was not moved', async () => {
    const { ui, log } = fakeUi(false, true);
    assert.equal(await afterLoad(ui, withMain, '✓ Pushed Rob2Main.mod to T_ROB2 on Cell 2.', ['T_ROB1', 'T_ROB2']), 'kept');
    assert.deepEqual(log.offers, [`✓ Pushed Rob2Main.mod to T_ROB2 on Cell 2. The program pointer was not moved. [${PP_TO_MAIN_BUTTON}]`]);
    assert.equal(log.confirms.length, 0);
    assert.equal(log.resets, 0);
  });

  it('choosing the offer still asks, and a cancelled ask moves nothing', async () => {
    const { ui, log } = fakeUi(true, false);
    assert.equal(await afterLoad(ui, withMain, '✓ loaded.', ['T_ROB1', 'T_ROB2']), 'kept');
    assert.equal(log.confirms.length, 1);
    assert.equal(log.resets, 0);
  });

  it('only the offer and then the confirmation move the pointer, once', async () => {
    const { ui, log } = fakeUi(true, true);
    assert.equal(await afterLoad(ui, withMain, '✓ loaded.', ['T_ROB1', 'T_ROB2']), 'moved');
    assert.equal(log.resets, 1);
  });

  it('the ask names every task the move takes on a multi-task system', () => {
    assert.deepEqual(ppToMainRequest(['T_ROB1', 'T_ROB2']), {
      label: 'PP to Main', tier: 'disruptive', taskApplies: true, tasks: ['T_ROB1', 'T_ROB2'],
      sideEffects: ['Moves the program pointer to main for the whole execution, in every task it runs: T_ROB1, T_ROB2.'],
    });
    assert.deepEqual(ppToMainRequest(['T_ROB1']).sideEffects, ['Moves the program pointer of T_ROB1 to main.']);
  });

  it('detects PROC main as the client does', () => {
    assert.equal(declaresMain(withMain), true);
    assert.equal(declaresMain('  proc Main ( )'), true);
    assert.equal(declaresMain(noMain), false);
    assert.equal(declaresMain('PROC mainloop()'), false);
  });
});
