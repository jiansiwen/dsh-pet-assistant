/**
 * pet-asset 协议：把 userData 自定义素材与随包素材以固定 scheme serve 给渲染层。
 * 渲染层相对路径探不到 userData，自定义皮肤必须走这里；路径穿越在解析层拒绝。
 * 用命名空间导入 + 可选访问：装配测试的 electron 替身没有 protocol/net 时跳过注册，
 * 真实主进程在 app ready 前导入本模块即完成特权声明。
 */
import * as electron from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { customAssetsRoot, resolveAssetPath } from './custom-skins.ts'

const ALLOWED_EXT = new Set(['.png', '.webm', '.jpg', '.jpeg'])

// 必须在 app ready 前声明：video/img 要能流式加载自定义 scheme。
electron.protocol?.registerSchemesAsPrivileged?.([
  { scheme: 'pet-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

export function registerPetAssetProtocol(userDataDir: string, bundledAssetsDir: string): void {
  const protocol = electron.protocol
  const net = electron.net
  if (!protocol?.handle || !net?.fetch) return
  protocol.handle('pet-asset', (request) => {
    const url = new URL(request.url)
    const root = url.hostname === 'custom'
      ? customAssetsRoot(userDataDir)
      : url.hostname === 'bundled' ? bundledAssetsDir : null
    if (!root) return new Response('not found', { status: 404 })
    const target = resolveAssetPath(root, url.pathname.replace(/^\//, ''))
    if (!target || !ALLOWED_EXT.has(path.extname(target).toLowerCase())) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}