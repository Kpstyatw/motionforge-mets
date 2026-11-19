import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/components/ui/use-toast'
import { useAnimationStore } from '@/stores/useAnimationStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'

interface NewProjectOptions {
  /** The app's save action; only a completed save may clear the guard. */
  save: () => Promise<boolean>
  isSaving?: boolean
  /** Close task-scoped dialogs owned by App before the project disappears. */
  onResetEditors?: () => void
}

/**
 * "New project" command shared by the toolbar, Ctrl+N and the native menu.
 *
 * Workspace state that points into the old project (selected task, collapsed
 * nodes, playback frame, task-scoped dialogs) is reset together with the
 * project, so the new project starts from a clean editor. The store's
 * createNewProject() already clears the source file and undo history.
 */
export function useNewProject({ save, isSaving = false, onResetEditors }: NewProjectOptions) {
  const { t } = useTranslation()
  const { project, unsavedChanges, createNewProject } = useProjectStore()
  const { setSelectedTask, setCollapsedTasks } = useUIStore()
  const { stop, setCurrentFrame } = useAnimationStore()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const resetWorkspace = () => {
    stop()
    setCurrentFrame(0)
    setSelectedTask(null)
    setCollapsedTasks([])
    onResetEditors?.()
    createNewProject()
    setConfirmOpen(false)
    toast({
      title: t('newProject.created', { defaultValue: '已新建项目' }),
      description: t('newProject.createdDescription', { defaultValue: '现在可以开始编辑新项目了。' })
    })
  }

  const requestNewProject = () => {
    // Nothing worth guarding in an empty project, even if a setting changed.
    if (unsavedChanges && project?.modules.length) {
      setConfirmOpen(true)
      return
    }
    resetWorkspace()
  }

  const saveAndNew = async () => {
    // A canceled save dialog leaves the confirmation open so the user can
    // still choose "discard" or "cancel" instead of losing the current work.
    if (await save()) resetWorkspace()
  }

  return {
    requestNewProject,
    confirmOpen,
    closeConfirm: () => setConfirmOpen(false),
    saveAndNew,
    discardAndNew: resetWorkspace,
    isSaving
  }
}
