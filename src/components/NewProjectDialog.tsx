import { useTranslation } from 'react-i18next'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface NewProjectDialogProps {
  open: boolean
  onClose: () => void
  onSaveAndNew: () => void
  onDiscardAndNew: () => void
  isSaving?: boolean
}

/**
 * Guard for "New project": replacing the workspace is destructive when the
 * current project has unsaved edits, so offer save / discard / cancel instead
 * of silently dropping them. The cancel action includes the dialog's X and Esc.
 */
export function NewProjectDialog({
  open, onClose, onSaveAndNew, onDiscardAndNew, isSaving = false
}: NewProjectDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newProject.unsavedTitle', { defaultValue: '当前项目尚未保存' })}</DialogTitle>
          <DialogDescription>
            {t('newProject.unsavedDescription', {
              defaultValue: '新建项目会清空当前编辑内容。是否先保存当前项目？'
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('dialog.cancel', { defaultValue: '取消' })}
          </Button>
          <Button variant="destructive" onClick={onDiscardAndNew} disabled={isSaving}>
            {t('newProject.discardAndNew', { defaultValue: '不保存并新建' })}
          </Button>
          <Button onClick={onSaveAndNew} disabled={isSaving}>
            {t('newProject.saveAndNew', { defaultValue: '保存并新建' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
