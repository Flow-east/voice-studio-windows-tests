import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import definition, { VoiceStudioWorld } from '../src/index.js';
import { ManagedEngine } from '../src/managed-engine.js';

const windows = { platform: 'win32', arch: 'x64', osRelease: '10.0.19045' };
const host = { pushEvent: async () => {} };
const disconnected = async () => ({ status: 'disconnected', connected: false });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('Windows startup never starts model setup for fresh or interrupted persisted installs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-windows-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const prior of ['fresh', 'missing', 'preparing']) {
    const dataDir = join(root, prior), studio = join(dataDir, 'voice-studio');
    mkdirSync(join(studio, 'engine-v1'), { recursive: true });
    if (prior !== 'fresh') {
      writeFileSync(join(studio, 'voice-setup.json'), JSON.stringify({ paused: false }));
      writeFileSync(join(studio, 'engine-v1/setup-state.json'), JSON.stringify({ transcription: { state: prior }, speech: { state: 'missing' } }));
    }
    let preparationCount = 0, launches = 0;
    const engine = new ManagedEngine({ root: studio, ...windows, spawnProcess() { launches++; throw Error('Unexpected startup process'); }, networkResolver: async () => ({ proxyEnv: {} }) });
    const prepare = engine.prepare.bind(engine);
    engine.prepare = (...args) => { preparationCount++; return prepare(...args); };
    const world = new VoiceStudioWorld({ cfg: { ...definition.defaults(), enabled: true, singingEnabled: true }, dataDir, dependencies: { ...windows, engine, detectQQ: disconnected } });
    await world.start(host); await nextTurn();
    assert.equal(preparationCount, 0, prior); assert.equal(launches, 0, prior); assert.equal(world.setupTasks.size, 0);
    assert.equal(world.engineStatus().transcription.state, 'missing');
    await world.stop();
  }
});

test('Windows manual setup persists paused policy before preparation, including singing', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-windows-manual-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const states = Object.fromEntries(['speech', 'transcription', 'singing', 'reference'].map(kind => [kind, { state: 'missing' }]));
  const kinds = [];
  const engine = { status: () => states, async prepare(kind) {
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'voice-studio/voice-setup.json'), 'utf8')), { paused: true });
    kinds.push(kind); states[kind] = { state: 'ready' };
  }, async cancelPrepare() {} };
  const world = new VoiceStudioWorld({ cfg: { ...definition.defaults(), enabled: true, singingEnabled: true }, dataDir, dependencies: { ...windows, engine, detectQQ: disconnected } });
  await world.start(host);
  world.initialize('speech'); await world.setupTasks.get('speech');
  world.initialize('singing'); await world.setupTasks.get('singing');
  assert.deepEqual(kinds, ['transcription', 'speech', 'singing']);
  await world.stop();
});

test('Mac first activation retains automatic basic preparation', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-mac-auto-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const states = Object.fromEntries(['speech', 'transcription', 'singing', 'reference'].map(kind => [kind, { state: 'missing' }]));
  const kinds = [];
  const engine = { status: () => states, async prepare(kind) { kinds.push(kind); states[kind] = { state: 'ready' }; }, async cancelPrepare() {} };
  const world = new VoiceStudioWorld({ cfg: { ...definition.defaults(), enabled: true }, dataDir, dependencies: { platform: 'darwin', arch: 'arm64', osRelease: '23.0.0', engine, detectQQ: disconnected } });
  await world.start(host); await world.setupTasks.get('speech');
  assert.deepEqual(kinds, ['transcription', 'speech']);
  assert.deepEqual(JSON.parse(readFileSync(join(world.root, 'voice-setup.json'), 'utf8')), { paused: false });
  await world.stop();
});

test('a killed setup host can cold-start again without resuming the interrupted task or deleting cache', { timeout: 10000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-windows-cold-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const engineRoot = join(dataDir, 'voice-studio/engine-v1');
  mkdirSync(engineRoot, { recursive: true });
  const cache = join(engineRoot, 'verified-download-cache.bin');
  writeFileSync(cache, 'retained model bytes');
  const source = `
    import { writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import definition, { VoiceStudioWorld } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    import { ManagedEngine } from ${JSON.stringify(new URL('../src/managed-engine.js', import.meta.url).href)};
    const [dataDir, phase] = process.argv.slice(1);
    const device = { platform: 'win32', arch: 'x64', osRelease: '10.0.19045' };
    const root = join(dataDir, 'voice-studio');
    const engine = new ManagedEngine({ root, ...device });
    let preparations = 0;
    engine.prepare = async kind => {
      preparations++;
      if (phase !== 'crash') throw Error('Unexpected resumed preparation');
      writeFileSync(join(engine.root, 'setup-state.json'), JSON.stringify({ [kind]: { state: 'preparing' } }));
      const policy = JSON.parse(readFileSync(join(root, 'voice-setup.json')));
      if (policy.paused !== true) throw Error('Restart policy missing before preparation');
      setInterval(() => {}, 1000);
      process.stdout.write('PREPARATION_STARTED\\n');
      await new Promise(() => {});
    };
    const world = new VoiceStudioWorld({ cfg: { ...definition.defaults(), enabled: true }, dataDir,
      dependencies: { ...device, engine, detectQQ: async () => ({ connected: false }) } });
    await world.start({ pushEvent: async () => {} });
    if (phase === 'crash') world.initialize('speech');
    else {
      await new Promise(resolve => setImmediate(resolve));
      process.stdout.write(JSON.stringify({ preparations, state: world.engineStatus().transcription.state,
        policy: JSON.parse(readFileSync(join(root, 'voice-setup.json'))) }));
      await world.stop();
    }
  `;
  const launch = phase => spawn(process.execPath, ['--input-type=module', '-e', source, dataDir, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  const first = launch('crash'); t.after(() => { if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL'); });
  let output = '', firstError = ''; first.stderr.on('data', chunk => { firstError += chunk; });
  await new Promise((resolve, reject) => {
    first.on('error', reject);
    first.on('exit', code => reject(Error('Fixture exited before forced termination: ' + code + ' ' + firstError)));
    first.stdout.on('data', chunk => { output += chunk; if (output.includes('PREPARATION_STARTED')) resolve(); });
  });
  const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
  const second = launch('restart'); t.after(() => { if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL'); });
  let result = '', error = ''; second.stdout.on('data', chunk => { result += chunk; }); second.stderr.on('data', chunk => { error += chunk; });
  const [code] = await once(second, 'close'); assert.equal(code, 0, error);
  assert.deepEqual(JSON.parse(result), { preparations: 0, state: 'missing', policy: { paused: true } });
  assert.equal(readFileSync(cache, 'utf8'), 'retained model bytes');
});
