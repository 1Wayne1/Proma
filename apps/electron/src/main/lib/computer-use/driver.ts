import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export const DRIVER_VERSION = '0.53.0'

/** 只接受固定发行版的系统安装位置，不搜索 PATH、项目目录或模型给出的路径。 */
export function driverLocation(platform: string, arch: string, local = process.env.LOCALAPPDATA) {
  if (platform === 'darwin' && arch === 'arm64') return {
    file: posix.join('/Applications/CuaDriver.app', 'Contents/MacOS/cua-driver'),
    sha256: '4ea9354ad51ffe21ff037f48b81f56ddc4861326be01d813a36b7b08e234ec6a',
  }
  if (platform === 'win32' && arch === 'x64' && local && win32.isAbsolute(local)) return {
    file: win32.join(local, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'),
    helper: { file: win32.join(local, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver-uia.exe'), sha256: '4e1475f720b27e0b53c26b8a91be8587d846cba2c5b2b8e5edeb31c2722b7b7e' },
    sha256: '6af3b8bb340caf3578af23cb34e6ec6a9cd29e0144a66801a85da7ac033f516b',
  }
  return undefined
}

interface DriverFile { file: string; sha256: string }

export async function verifyDriver(candidate: DriverFile & { helper?: DriverFile }, signal: AbortSignal): Promise<string> {
  if (candidate.helper) await verifyDriver(candidate.helper, signal)
  signal.throwIfAborted()
  const info = await stat(candidate.file).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`未安装 Cua Driver ${DRIVER_VERSION}：${candidate.file}`)
  if (info.size > 100 * 1024 * 1024) throw new Error('Cua Driver 大小异常')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(candidate.file, { signal })) hash.update(chunk)
  if (hash.digest('hex') !== candidate.sha256) throw new Error(`驱动校验失败，请使用官方 Cua Driver ${DRIVER_VERSION}`)
  return candidate.file
}
