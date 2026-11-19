import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * In-app replacement for window.confirm().
 *
 * Electron's native confirm() steals keyboard focus from the renderer on
 * Windows: after it closes, the window looks active but typing does nothing
 * until the user switches apps and back. Keeping the confirmation inside the
 * DOM avoids the native dialog entirely, so focus never leaves the page.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open, title, message, onConfirm, onCancel
}) => {
  const { t } = useTranslation()
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // Focus the safe (cancel) action so Enter/Space never deletes by accident,
    // and Escape closes the prompt.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    document.addEventListener('keydown', onKey)
    const id = window.setTimeout(() => confirmRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(id)
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="bg-background text-foreground rounded-lg shadow-xl w-[420px] max-w-[95vw] border p-5">
        <h2 className="text-base font-semibold mb-2">
          {title ?? t('dialog.confirm', { defaultValue: '确认' })}
        </h2>
        <p className="text-sm text-muted-foreground mb-5 break-words">{message}</p>
        <div className="flex justify-end gap-2">
          <button ref={confirmRef} onClick={onCancel}
            className="px-4 py-1.5 text-sm border rounded hover:bg-accent">
            {t('dialog.cancel', { defaultValue: '取消' })}
          </button>
          <button onClick={onConfirm}
            className="px-4 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:opacity-90">
            {t('dialog.confirm', { defaultValue: '确认' })}
          </button>
        </div>
      </div>
    </div>
  )
}
