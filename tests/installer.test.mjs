import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../extension/core.mjs';

const bat = readFileSync(new URL('../extension/install-pero.bat', import.meta.url), 'utf8');
const psBytes = readFileSync(new URL('../extension/install-pero.ps1', import.meta.url));
const ps = psBytes.toString('utf8').replace(/^\uFEFF/, '');
const rootBat = readFileSync(new URL('../install-pero.bat', import.meta.url), 'utf8');

test('double-clickable batch launcher calls only bundled local PowerShell script', () => {
  assert.match(bat, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-pero\.ps1"/);
  assert.match(bat, /if not exist "%~dp0install-pero\.ps1"/);
  assert.match(rootBat, /call "%~dp0extension\\install-pero\.bat"/);
  assert.doesNotMatch(bat, /iex|Invoke-Expression|curl/i);
});

test('Windows PowerShell script uses UTF-8 BOM and the exact existing local model', () => {
  assert.deepEqual([...psBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(ps.includes(`$Model = '${DEFAULT_MODEL}'`));
  assert.match(ps, /& \$ollamaExe pull \$Model/);
  assert.doesNotMatch(ps, /:cloud|OLLAMA_HOST\s*=/);
});

test('installer verifies downloaded Ollama before running and preserves extension origins', () => {
  assert.match(ps, /https:\/\/ollama\.com\/download\/OllamaSetup\.exe/);
  assert.match(ps, /--id Ollama\.Ollama --exact --source winget/);
  const signature = ps.indexOf("$signature.Status -ne 'Valid'");
  const execution = ps.indexOf('Start-Process -FilePath $installer');
  assert.ok(signature > -1 && execution > signature, 'installer must be authenticated before execution');
  assert.match(ps, /O=Ollama Inc\\\./);
  assert.match(ps, /\$current -split ','/);
  assert.match(ps, /\(@\(\$items\) \+ \$origin\) -join ','/);
  assert.match(ps, /\^\[a-p\]\{32\}\$/);
  assert.doesNotMatch(ps, /chrome-extension:\/\/\*' \+/);
});
