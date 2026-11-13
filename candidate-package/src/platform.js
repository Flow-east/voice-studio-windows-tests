import { release } from 'node:os';

// Host-supported systems. The Intel runtime deliberately uses its own pinned
// dependency set; it must never reuse an Apple Silicon environment or weights.
export function platformProfile({ platform = process.platform, arch = process.arch, osRelease = release() } = {}) {
  const major = Number(String(osRelease).split('.')[0]);
  const id = platform === 'darwin' && arch === 'arm64' ? 'mac-arm64'
    : platform === 'darwin' && arch === 'x64' ? 'mac-x64'
    : platform === 'win32' && arch === 'x64' ? 'windows-x64' : 'unsupported';
  const minOS = id === 'mac-arm64' ? 'macOS 14' : id === 'mac-x64' ? 'macOS 13' : 'Windows 10';
  const supported = id !== 'unsupported' && Number.isFinite(major) && major >= (id === 'mac-arm64' ? 23 : id === 'mac-x64' ? 22 : 10);
  const label = id === 'mac-arm64' ? 'Apple Silicon Mac' : id === 'mac-x64' ? 'Intel Mac' : id === 'windows-x64' ? 'Windows 64 位' : `${platform} / ${arch}`;
  return { id, platform, arch, label, minOS, supported, speechBackend: id === 'mac-arm64' ? 'mlx' : 'torch',
    accelerationLabel: id === 'mac-arm64' ? 'Apple 芯片加速' : id === 'mac-x64' ? 'CPU 运行' : '自动检测 NVIDIA 加速，其他设备使用 CPU',
    ...(id === 'mac-x64' ? { warning: 'Intel Mac 使用 CPU 生成，首次生成和唱歌可能需要较长时间。' } : {}),
    ...(!supported ? { unsupportedReason: id === 'unsupported' ? '支持 M 系列 Mac、Intel Mac 和 Windows 64 位电脑。' : `需要 ${minOS} 或更新版本。` } : {}) };
}

export const UV_DISTRIBUTIONS = Object.freeze({
  'mac-arm64': { archive: 'uv-aarch64-apple-darwin.tar.gz', member: 'uv-aarch64-apple-darwin/uv', binary: 'uv', sha256: '4beaa9550f93ef7f0fc02f7c28c9c48cd61fe30db00f5ac8947e0a425c3fb282' },
  'mac-x64': { archive: 'uv-x86_64-apple-darwin.tar.gz', member: 'uv-x86_64-apple-darwin/uv', binary: 'uv', sha256: 'a9c3653245031304c50dd60ac0301bf6c112e12c38c32302a71d4fa6a63ba2cb' },
  'windows-x64': { archive: 'uv-x86_64-pc-windows-msvc.zip', member: 'uv.exe', binary: 'uv.exe', sha256: '171b7ccda1bbd562da6babeffcf533a1c6cc7862cf998da826e1db534fc43e48' },
});
