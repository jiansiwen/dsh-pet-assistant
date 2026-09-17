import React from 'react'
import { createRoot } from 'react-dom/client'
import ApprovalCardPage from './approval-card.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApprovalCardPage />
  </React.StrictMode>,
)
