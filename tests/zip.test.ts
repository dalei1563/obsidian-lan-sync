import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginZip} from '../server/zip';

test('manual installation archive contains only the three plugin files in the correct directory', () => {
  const files = ['main.js', 'manifest.json', 'styles.css'].map(name => ({name, body: Buffer.from('content-' + name)}));
  const zip = pluginZip(files); let offset = 0;
  for (const file of files) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const length = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    assert.equal(name, 'lan-note-sync/' + file.name);
    assert.deepEqual(zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length), file.body);
    offset += 30 + nameLength + length;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
