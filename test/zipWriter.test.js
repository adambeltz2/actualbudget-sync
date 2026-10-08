const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildZip } = require('../src/zipWriter');

describe('buildZip', () => {
  test('produces a buffer starting and ending with valid zip signatures', () => {
    const zip = buildZip([{ name: 'hello.txt', data: 'hello world' }]);
    assert.ok(Buffer.isBuffer(zip));
    assert.equal(zip.readUInt32LE(0), 0x04034b50); // local file header
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD, no comment
  });

  test('round-trips through the system unzip tool with correct content and CRC', function (t) {
    let hasUnzip = true;
    try { execFileSync('unzip', ['-v']); } catch (e) { hasUnzip = false; }
    if (!hasUnzip) { t.skip('unzip not available in this environment'); return; }

    const files = [
      { name: 'assumptions.json', data: JSON.stringify({ retireAge: 55, allocation: 'moderate' }, null, 2) },
      { name: 'monte-carlo-percentiles.csv', data: 'age,p10,p50,p90\n42,400000,400000,400000\n' }
    ];
    const zip = buildZip(files);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipwriter-test-'));
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, zip);
    try {
      execFileSync('unzip', ['-o', zipPath, '-d', dir]);
      for (const f of files) {
        const extracted = fs.readFileSync(path.join(dir, f.name), 'utf8');
        assert.equal(extracted, f.data);
      }
      // unzip's own CRC check: a corrupt/malformed archive exits non-zero.
      execFileSync('unzip', ['-t', zipPath]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles multiple files and an empty file without corrupting the archive', () => {
    const files = [
      { name: 'a.txt', data: 'first' },
      { name: 'b.txt', data: '' },
      { name: 'c.txt', data: Buffer.from([0, 1, 2, 255, 254]) }
    ];
    const zip = buildZip(files);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipwriter-test2-'));
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, zip);
    try {
      execFileSync('unzip', ['-t', zipPath]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
