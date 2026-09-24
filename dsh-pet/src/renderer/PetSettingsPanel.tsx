import { useLayoutEffect, useRef } from 'react'
import type { SettingsPage } from './types.js'
import { registerCharacterHitbox, unregisterCharacterHitbox } from './stage-layout.js'

interface Props {
  page: SettingsPage
  onPage(page: SettingsPage): void
  onClose(): void
  children: React.ReactNode
}

export default function PetSettingsPanel({ page, onPage, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      registerCharacterHitbox('__settings__', { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); unregisterCharacterHitbox('__settings__') }
  }, [])

  return <section className="pet-management" ref={panel} data-interactive aria-label="宠物设置与管理">
    <header className="management-header"><h2>宠物设置</h2><button onClick={onClose} aria-label="关闭设置">×</button></header>
    <nav className="management-tabs" aria-label="设置分类">
      {([['general', '通用'], ['team', '团队'], ['doc', '文档'], ['meeting', '会议']] as const).map(([id, title]) =>
        <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => onPage(id)}>{title}</button>)}
    </nav>
    <div className="management-content">{children}</div>
  </section>
}
