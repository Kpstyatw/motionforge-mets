import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'
import { usePreferencesStore } from '@/stores/usePreferencesStore'
import { useCycleView } from '@/hooks/useCycleView'
import { flattenTree, visibleTreeRows } from '@/lib/dependencyEngine'
import { findNameIssues, translateNameIssue } from '@/lib/nameValidation'
import { saveProjectFile } from '@/services/saveProject'
import { toast } from '@/components/ui/use-toast'

/**
 * One-click save for the current project. Wraps the derived view + workbook
 * writer so App/commands only need to call save() / saveAs().
 */
export function useSaveProject() {
  const { t } = useTranslation()
  const { project, sourceFile, setSourceFile, setUnsavedChanges } = useProjectStore()
  const { collapsedTaskIds, hiddenTaskIds } = useUIStore()
  const defaultFormat = usePreferencesStore(s => s.file.defaultFormat)
  const { schedule, templateSchedule, expansion } = useCycleView()
  const [isSaving, setIsSaving] = useState(false)

  /** Returns true only when the project was actually written to disk. */
  const save = useCallback(async (forceSaveAs = false): Promise<boolean> => {
    if (!project || isSaving) return false
    // A brand-new empty project has nothing worth writing.
    if (!project.modules.length) {
      toast({ variant: 'destructive', title: t('save.empty', { defaultValue: '暂无数据可保存' }) })
      return false
    }
    // One gate for JSON / CSV / Excel and Ctrl+S / Save As: an ambiguous name
    // makes resources and Excel rows unidentifiable, so never write it out.
    const nameIssues = findNameIssues(project)
    if (nameIssues.length) {
      const details = nameIssues.slice(0, 3).map(issue => translateNameIssue(issue, t)).join('；')
      toast({
        variant: 'destructive',
        title: t('nameIssue.title', { defaultValue: '名称重复，无法保存' }),
        description: details + (nameIssues.length > 3
          ? `；+${nameIssues.length - 3}` : '')
      })
      return false
    }
    setIsSaving(true)
    try {
      // A saved workbook must not lose collapsed/hidden rows: keep every row
      // and let the writer flag the hidden ones the same way the export does.
      const visibleIds = new Set(
        visibleTreeRows(templateSchedule, new Set(collapsedTaskIds), new Set(hiddenTaskIds))
          .map(r => r.task.id)
      )
      const hiddenRowIds = new Set(
        templateSchedule.tasks.map(t => t.id).filter(id => !visibleIds.has(id))
      )
      const rows = flattenTree(schedule)
      // An existing file keeps its own format on Ctrl+S; new projects and
      // Save As follow the preference. This prevents silently changing a
      // shared .xlsx into .json just because the default was changed.
      const format = sourceFile && !forceSaveAs ? sourceFile.kind : defaultFormat
      const result = await saveProjectFile({
        project,
        schedule,
        rows,
        hiddenRowIds,
        allocations: expansion.allocations,
        cycleConfig: expansion.config,
        sourceFile,
        forceSaveAs,
        format
      })
      if (result.canceled) return false
      if (!result.saved) {
        toast({ variant: 'destructive', title: t('save.failed', { defaultValue: '保存失败' }), description: result.error })
        return false
      }
      if (result.path) {
        setSourceFile({ path: result.path, name: result.target, kind: result.format })
      } else if (!sourceFile) {
        // Web download: remember just the name so the UI can show it.
        setSourceFile({ name: result.target, kind: result.format })
      }
      setUnsavedChanges(false)
      toast({
        title: t('save.ok', { defaultValue: '已保存' }),
        description: result.warning ? `${result.target} · ${result.warning}` : result.target
      })
      return true
    } catch (error) {
      toast({ variant: 'destructive', title: t('save.failed', { defaultValue: '保存失败' }), description: String(error) })
      return false
    } finally {
      setIsSaving(false)
    }
  }, [project, isSaving, schedule, expansion, collapsedTaskIds, sourceFile, defaultFormat, setSourceFile, setUnsavedChanges, t])

  return { save, saveAs: () => save(true), isSaving, sourceFile }
}
