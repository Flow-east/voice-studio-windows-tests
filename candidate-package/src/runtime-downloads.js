// All locations deliver a fixed upstream artifact. Mirrors never supply an
// executable until its upstream SHA256 has been verified by ManagedEngine.
const UV_WHEEL_PATH = 'packages/f6/a3/c88fa454a7c07785ce63e96b6c1c7b24b5abcb3a6afbc6ad8b29b9bc1a1d/uv-0.11.2-py3-none-win_amd64.whl';
export const WINDOWS_UV_WHEEL = Object.freeze({
  sha256: 'd4dbcecf6daca8605f46fba232f49e9b49d06ebe3b9cba5e59e608c5be03890e',
  size: 24989876,
  member: 'uv-0.11.2.data/scripts/uv.exe',
});
export const WINDOWS_PYTHON_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone';

export function runtimeToolSources(profile, spec) {
  const github = { url: 'https://github.com/astral-sh/uv/releases/download/0.11.2/' + spec.archive, sha256: spec.sha256, member: spec.member, maxBytes: 40 * 1024 * 1024 };
  if (profile !== 'windows-x64') return [github];
  const wheel = { sha256: WINDOWS_UV_WHEEL.sha256, member: WINDOWS_UV_WHEEL.member, maxBytes: WINDOWS_UV_WHEEL.size };
  return [
    { ...wheel, url: 'https://pypi.tuna.tsinghua.edu.cn/' + UV_WHEEL_PATH },
    { ...wheel, url: 'https://files.pythonhosted.org/' + UV_WHEEL_PATH },
    github,
  ];
}
