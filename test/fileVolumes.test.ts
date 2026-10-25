import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { volumesToShow, fileVolumesText, RWS1_VOLUMES } from '../src/fileVolumes';

describe('List File Volumes', () => {
  it('RWS 1.0: the PC drives a virtual controller lists become the controller volumes', () => {
    const r = volumesToShow('rw6', ['C:', 'D:']);
    assert.deepEqual(r.volumes, ['$HOME', '$TEMP', '$BACKUP']);
    assert.deepEqual(RWS1_VOLUMES, ['$HOME', '$TEMP', '$BACKUP']);
    assert.match(r.note ?? '', /PC/);
  });

  it('RWS 1.0: names that are not drive letters are shown as the controller gave them', () => {
    assert.deepEqual(volumesToShow('rw6', ['$HOME', '$TEMP']).volumes, ['$HOME', '$TEMP']);
    assert.equal(volumesToShow('rw6', ['$HOME']).note, undefined);
  });

  it('RWS 1.0: an empty answer shows the controller volumes', () => {
    assert.deepEqual(volumesToShow('rw6', []).volumes, ['$HOME', '$TEMP', '$BACKUP']);
  });

  it('RWS 2.0: the list is shown unchanged', () => {
    const v = ['TEMP', 'RAMDISK', 'PRODUCTS', 'HOME', 'DATA', 'ADDINDATA', 'BACKUP'];
    assert.deepEqual(volumesToShow('rw7', v).volumes, v);
    assert.deepEqual(volumesToShow('rw8', v).volumes, v);
    assert.deepEqual(volumesToShow(null, ['C:']).volumes, ['C:']);
  });

  it('formats the document with the heading the harness looks for', () => {
    const t = fileVolumesText({ volumes: ['$HOME', '$TEMP'], note: 'n' });
    assert.equal(t, '# File volumes\n\n- $HOME\n- $TEMP\n\nn');
    assert.equal(fileVolumesText({ volumes: ['HOME'] }), '# File volumes\n\n- HOME');
  });
});
