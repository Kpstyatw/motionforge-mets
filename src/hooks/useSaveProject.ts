import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { useCycleView } from '@/hooks/useCycleView'
import { flattenTree } from '@/lib/dependencyEngine'
import { saveProjectExcel } from '@/services/saveProject'
import { toast } from '@/components/ui/use-toast'

/**
 * One-click save for the current project. Wraps the derived view + workbook
 * writer so App/commands only need to call save() / saveAs().
 */
export function useSaveProject() {
  const { t } = useTranslation()
  const { project, sourceFile, setSourceFile, setUnsavedChanges } = useProjectStore()
  const { collapsedTaskIds } = useUIStore()
  const { schedule, expansion } = useCycleView()
  const [isSaving, setIsSaving] = useState(false)

  const save = useCallback(async (forceSaveAs = false) => {
    if (!project || isSaving) return
    // A brand-new empty project has nothing worth writing.
    if (!project.modules.length) {
      toast({ variant: 'destructive', title: t('save.empty', { defaultValue: '暂无数据可保存' }) })
      return
    }
    setIsSaving(true)
    try {
      const rows = flattenTree(schedule, new Set(collapsedTaskIds))
      const result = await saveProjectExcel({
        project,
        schedule,
        rows,
        allocations: expansion.allocations,
        cycleConfig: expansion.config,
        sourceFile,
        forceSaveAs
      })
      if (result.canceled) return
      if (!result.saved) {
        toast({ variant: 'destructive', title: t('save.failed', { defaultValue: '保存失败' }), description: result.error })
        return
      }
      if (result.path) {
        const kind = /\.csv$/i.test(result.path) ? 'csv' : 'xlsx'
        setSourceFile({ path: result.path, name: result.target, kind })
      } else if (!sourceFile) {
        // Web download: remember just the name so the UI can show it.
        setSourceFile({ name: result.target, kind: 'xlsx' })
      }
      setUnsavedChanges(false)
      toast({ title: t('save.ok', { defaultValue: '已保存' }), description: result.target })
    } catch (error) {
      toast({ variant: 'destructive', title: t('save.failed', { defaultValue: '保存失败' }), description: String(error) })
    } finally {
      setIsSaving(false)
    }
  }, [project, isSaving, schedule, expansion, collapsedTaskIds, sourceFile, setSourceFile, setUnsavedChanges, t])

  return { save, saveAs: () => save(true), isSaving, sourceFile }
}
