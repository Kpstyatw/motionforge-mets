import React from 'react'
import { useTranslation } from 'react-i18next'
import { FaKeyboard } from 'react-icons/fa'

interface ShortcutsHelpProps {
  onOpen: () => void
}

/** Floating shortcut to the single full help dialog. */
export const ShortcutsHelp: React.FC<ShortcutsHelpProps> = ({ onOpen }) => {
  const { t } = useTranslation()

  return (
    <button
      onClick={onOpen}
      className="fixed bottom-20 right-4 p-3 bg-primary text-primary-foreground rounded-full shadow-lg hover:bg-primary/90 transition-colors z-50"
      title={t('help.title')}
      aria-label={t('help.title')}
    >
      <FaKeyboard className="w-5 h-5" />
    </button>
  )
}
