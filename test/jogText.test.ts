import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  JOG_AXIS_VALUE_SETTING, JOG_AXIS_VALUE_TOOLTIP, JOG_MODE_SETTING, JOG_SPEED_SETTING, jogConfirmEffects, jogStatusText,
} from '../src/jogText';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { description?: string }> } };
};
const props = manifest.contributes.configuration.properties;

describe('the jog axis value is not degrees or millimetres', () => {
  it('the setting says what the client documents: no unit, the sign is the direction, one click is one step', () => {
    const t = JOG_AXIS_VALUE_SETTING;
    assert.match(t, /axis value/i);
    assert.match(t, /no unit|without a unit/i);
    assert.match(t, /not degrees or millimetres/);
    assert.match(t, /sign/);
    assert.match(t, /one jog step/);
    assert.match(t, /about 0\.01 degree/);
  });

  it('speed and mode are said not to be sent', () => {
    assert.match(JOG_SPEED_SETTING, /Not sent/);
    assert.match(JOG_SPEED_SETTING, /no speed field/);
    assert.match(JOG_MODE_SETTING, /Not sent/);
    assert.match(JOG_MODE_SETTING, /jog mode of the unit selected for jogging/);
  });

  it('package.json carries exactly those descriptions', () => {
    assert.equal(props['abbRobot.jog.increment'].description, JOG_AXIS_VALUE_SETTING);
    assert.equal(props['abbRobot.jog.speed'].description, JOG_SPEED_SETTING);
    assert.equal(props['abbRobot.jog.mode'].description, JOG_MODE_SETTING);
  });

  it('the confirmation lists the axis value without a unit and without a speed', () => {
    const lines = jogConfirmEffects(5);
    const text = lines.join(' ');
    assert.match(text, /axis value 5/);
    assert.match(text, /no unit/);
    assert.match(text, /one jog step/);
    assert.doesNotMatch(text, /degrees|\bmm\b|speed/i);
  });

  it('the status line and tooltip do not name a unit either', () => {
    assert.equal(jogStatusText('Joint', 1), 'Joint labels · axis value 1 · one step per click');
    assert.doesNotMatch(jogStatusText('Cartesian', 10), /°|degrees|\bmm\b/);
    assert.doesNotMatch(JOG_AXIS_VALUE_TOOLTIP, /degrees|\bmm\b/);
  });

  it('no jog text in the extension calls the value degrees or millimetres', () => {
    const files = ['src/extension.ts', 'src/MotionTreeProvider.ts'].map(f => fs.readFileSync(path.join(root, f), 'utf8'));
    for (const src of files) {
      // The lines that mention a jog increment, speed or mode setting or send a jog.
      const jogLines = src.split('\n').filter(l => /jog\.increment|setJogIncrement|Jog Increment|per-click|jog increment|Jog Mode|Jog Speed|Set increment/i.test(l));
      for (const l of jogLines) {
        assert.doesNotMatch(l, /degrees|'°'|' mm'|by degrees|mm\/°/, l.trim());
      }
    }
    const ext = files[0];
    assert.doesNotMatch(ext, /Jog individual joints by degrees/);
    assert.doesNotMatch(ext, /Increment in \$\{unit/);
    assert.ok(ext.includes('jogConfirmEffects('));
  });

  it('the Motion view offers the arrows in every mode and with the motors off: the controller decides', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'MotionTreeProvider.ts'), 'utf8');
    assert.doesNotMatch(src, /const jogReady = opmode !== 'AUTO'/);
    assert.ok(src.includes('const jogReady = true'));
  });
});
