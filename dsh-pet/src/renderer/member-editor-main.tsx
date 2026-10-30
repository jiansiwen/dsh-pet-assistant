import React from 'react'
import { createRoot } from 'react-dom/client'
import MemberEditorApp from './MemberEditor.js'
import './member-editor.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemberEditorApp />
  </React.StrictMode>,
)
