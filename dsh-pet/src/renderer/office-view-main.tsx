import React from 'react'
import { createRoot } from 'react-dom/client'
import OfficeViewer from './OfficeViewer.js'
import './office-view.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OfficeViewer />
  </React.StrictMode>,
)
