# -*- coding: utf-8 -*-
"""One-off helper: add the Gantt-edition translation keys to all five locales.

Kept in the repo so the additions can be re-applied after pulling upstream.
Keys missing from a locale fall back to the Chinese defaultValue in the UI.
"""
import json
import os

LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']

# dotted key -> [zh-CN, zh-TW, en, ja, ko]
T = {
    'gantt.title': ['动作时序甘特图', '動作時序甘特圖', 'Action Timing Gantt', '動作タイミング ガント図', '동작 타이밍 간트 차트'],
    'gantt.total': ['总节拍', '總節拍', 'Cycle time', '総サイクル', '총 사이클'],
    'gantt.scale': ['刻度', '刻度', 'Scale', '目盛', '눈금'],
    'gantt.precision': ['精度', '精度', 'Precision', '精度', '정밀도'],
    'gantt.timeSettings': ['时间刻度', '時間刻度', 'Time scale', '時間目盛', '시간 눈금'],
    'gantt.excel': ['Excel 转换', 'Excel 轉換', 'Excel conversion', 'Excel 変換', 'Excel 변환'],
    'gantt.expandAll': ['全部展开', '全部展開', 'Expand all', 'すべて展開', '모두 펼치기'],
    'gantt.collapseAll': ['全部折叠', '全部摺疊', 'Collapse all', 'すべて折りたたむ', '모두 접기'],
    'gantt.hideSubActions': ['隐藏所有子动作', '隱藏所有子動作', 'Hide all sub-actions', 'すべての子動作を隠す', '모든 하위 동작 숨기기'],
    'gantt.hidden': ['行已隐藏', '列已隱藏', 'rows hidden', '行を非表示', '행 숨김'],
    'gantt.addChild': ['新增下级', '新增下級', 'Add child', '子を追加', '하위 추가'],
    'gantt.addModule': ['新增模块', '新增模組', 'Add module', 'モジュール追加', '모듈 추가'],
    'gantt.addNode': ['新增层级节点', '新增層級節點', 'Add hierarchy node', '階層ノード追加', '계층 노드 추가'],
    'gantt.hierarchy': ['模块 / 机构 / 动作 / 子动作', '模組 / 機構 / 動作 / 子動作', 'Module / Mechanism / Action / Sub-action', 'モジュール / 機構 / 動作 / 子動作', '모듈 / 기구 / 동작 / 하위 동작'],
    'gantt.hierarchyPanel': ['层级与操作', '層級與操作', 'Hierarchy & actions', '階層と操作', '계층 및 작업'],
    'gantt.startEnd': ['起止 (ms)', '起迄 (ms)', 'Start–End (ms)', '開始–終了 (ms)', '시작–종료 (ms)'],
    'gantt.zoomIn': ['放大', '放大', 'Zoom in', '拡大', '확대'],
    'gantt.zoomOut': ['缩小', '縮小', 'Zoom out', '縮小', '축소'],
    'gantt.fit': ['适应窗口', '適應視窗', 'Fit to window', 'ウィンドウに合わせる', '창에 맞춤'],
    'gantt.visibleCount': ['可见行', '可見列', 'Visible rows', '表示行', '표시 행'],
    'gantt.taskCount': ['节点数', '節點數', 'Nodes', 'ノード数', '노드 수'],
    'gantt.sideHint': ['单击选中，双击编辑；箭头显示依赖链路。', '單擊選取，雙擊編輯；箭頭顯示依賴鏈路。', 'Click to select, double-click to edit; arrows show the dependency chain.', 'クリックで選択、ダブルクリックで編集。矢印は依存チェーンです。', '클릭하여 선택, 더블 클릭하여 편집. 화살표는 의존 체인입니다.'],
    'gantt.editSelected': ['编辑选中', '編輯選取', 'Edit selected', '選択を編集', '선택 항목 편집'],
    'gantt.kind.module': ['模块', '模組', 'Module', 'モジュール', '모듈'],
    'gantt.kind.mechanism': ['机构', '機構', 'Mechanism', '機構', '기구'],
    'gantt.kind.action': ['动作', '動作', 'Action', '動作', '동작'],
    'gantt.kind.subaction': ['子动作', '子動作', 'Sub-action', '子動作', '하위 동작'],
    'gantt.newKind.module': ['新模块', '新模組', 'New module', '新モジュール', '새 모듈'],
    'gantt.newKind.mechanism': ['新机构', '新機構', 'New mechanism', '新機構', '새 기구'],
    'gantt.newKind.action': ['新动作', '新動作', 'New action', '新動作', '새 동작'],
    'gantt.newKind.subaction': ['新子动作', '新子動作', 'New sub-action', '新子動作', '새 하위 동작'],
    'gantt.taskEditor': ['任务编辑', '任務編輯', 'Task editor', 'タスク編集', '작업 편집'],
    'gantt.name': ['名称', '名稱', 'Name', '名前', '이름'],
    'gantt.stage': ['阶段', '階段', 'Stage', '段階', '단계'],
    'gantt.mechanism': ['所属机构 / 模块', '所屬機構 / 模組', 'Mechanism / module', '所属機構 / モジュール', '소속 기구 / 모듈'],
    'gantt.timing': ['时序（整数毫秒）', '時序（整數毫秒）', 'Timing (integer ms)', 'タイミング（整数 ms）', '타이밍 (정수 ms)'],
    'gantt.start': ['开始 (ms)', '開始 (ms)', 'Start (ms)', '開始 (ms)', '시작 (ms)'],
    'gantt.duration': ['持续时长 (ms)', '持續時長 (ms)', 'Duration (ms)', '所要時間 (ms)', '지속 시간 (ms)'],
    'gantt.end': ['结束 (ms)', '結束 (ms)', 'End (ms)', '終了 (ms)', '종료 (ms)'],
    'gantt.timeHint': ['支持 1234、1234ms、1.234s、01:23.456；修改任一前置任务后，所有后置动作起始时间自动级联重算。', '支援 1234、1234ms、1.234s、01:23.456；修改任一前置任務後，所有後置動作起始時間自動級聯重算。', 'Accepts 1234, 1234ms, 1.234s, 01:23.456. Changing any predecessor cascades to every successor start.', '1234 / 1234ms / 1.234s / 01:23.456 に対応。先行タスクを変更すると全ての後続タスクの開始が連鎖再計算されます。', '1234, 1234ms, 1.234s, 01:23.456 지원. 선행 작업 변경 시 모든 후속 작업 시작이 연쇄 재계산됩니다.'],
    'gantt.summaryHint': ['汇总行：起止时间由所有后代任务自动卷算，不可直接编辑。', '彙總列：起迄時間由所有後代任務自動捲算，不可直接編輯。', 'Summary row: bounds roll up from all descendants and cannot be edited directly.', '集計行：開始・終了は全子孫から自動集計され、直接編集できません。', '요약 행: 시작/종료는 모든 하위 항목에서 자동 집계되며 직접 편집할 수 없습니다.'],
    'gantt.startMode': ['起始方式', '起始方式', 'Start mode', '開始モード', '시작 방식'],
    'gantt.auto': ['跟随依赖（自动）', '跟隨依賴（自動）', 'Follow dependencies (auto)', '依存に従う（自動）', '의존 따름 (자동)'],
    'gantt.manual': ['锁定起始（不早于依赖）', '鎖定起始（不早於依賴）', 'Pin start (never before dependencies)', '開始を固定（依存より早くならない）', '시작 고정 (의존보다 빠르지 않게)'],
    'gantt.constraint': ['依赖最早允许', '依賴最早允許', 'Earliest allowed by deps', '依存による最も早い開始', '의존이 허용하는 최초 시각'],
    'gantt.clamped': ['已按依赖顺延', '已按依賴順延', 'Pushed by dependencies', '依存により繰り下げ', '의존에 의해 연기됨'],
    'gantt.invalidTime': ['时间格式无效', '時間格式無效', 'Invalid time format', '時刻形式が不正', '시간 형식이 잘못됨'],
    'gantt.predecessors': ['前置任务', '前置任務', 'Predecessors', '先行タスク', '선행 작업'],
    'gantt.selectPred': ['选择前置任务', '選擇前置任務', 'Select predecessor', '先行タスクを選択', '선행 작업 선택'],
    'gantt.add': ['新增', '新增', 'Add', '追加', '추가'],
    'gantt.remove': ['删除', '刪除', 'Remove', '削除', '삭제'],
    'gantt.noPreds': ['暂无前置任务，起始时间由自身设置决定。', '尚無前置任務，起始時間由自身設定決定。', 'No predecessors yet; start is set by this task itself.', '先行タスクはありません。開始はこのタスク自身で決まります。', '선행 작업이 없습니다. 시작은 이 작업 자체로 결정됩니다.'],
    'gantt.summaryNoDeps': ['模块 / 机构汇总行不支持前置任务；请在动作或子动作上设置。', '模組 / 機構彙總列不支援前置任務；請在動作或子動作上設定。', 'Summary rows cannot have predecessors; set them on actions or sub-actions.', '集計行には先行タスクを設定できません。動作または子動作に設定してください。', '요약 행에는 선행 작업을 설정할 수 없습니다. 동작 또는 하위 동작에 설정하세요.'],
    'gantt.successors': ['后置任务', '後置任務', 'Successors', '後続タスク', '후속 작업'],
    'gantt.noCandidate': ['没有可添加的前置任务', '沒有可新增的前置任務', 'No available predecessor', '追加できる先行タスクがありません', '추가 가능한 선행 작업 없음'],
    'gantt.cycleBlocked': ['会形成循环依赖', '會形成循環依賴', 'Would create a dependency cycle', '依存の循環になります', '의존 순환이 발생합니다'],
    'gantt.level': ['第', '第', 'Level', '第', '레벨'],
    'gantt.levelUnit': ['层', '層', '', '階層', ''],
    'gantt.children': ['个直接子级', '個直接子級', 'direct children', '直接の子', '직계 하위'],
    'gantt.path': ['可继续添加子动作的子动作', '可繼續新增子動作的子動作', 'Sub-actions can be nested to any depth', '子動作の下にさらに子動作を追加できます', '하위 동작 아래에 또 다른 하위 동작을 추가할 수 있습니다'],
    'gantt.deleteTask': ['删除任务（含子动作）', '刪除任務（含子動作）', 'Delete task (incl. sub-actions)', 'タスクを削除（子動作を含む）', '작업 삭제 (하위 동작 포함)'],
    'gantt.confirmDelete': ['删除该任务及其所有子动作、相关依赖？', '刪除該任務及其所有子動作、相關依賴？', 'Delete this task, all its sub-actions and related dependencies?', 'このタスクと全ての子動作・関連依存を削除しますか？', '이 작업과 모든 하위 동작, 관련 의존을 삭제하시겠습니까?'],
    'gantt.nodeKind': ['节点类型', '節點類型', 'Node type', 'ノード種別', '노드 유형'],
    'gantt.nestHint': ['子动作可作为另一个子动作的上级，层数不限。', '子動作可作為另一個子動作的上級，層數不限。', 'A sub-action can be the parent of another sub-action, with no depth limit.', '子動作は別の子動作の親にでき、階層の深さに制限はありません。', '하위 동작은 다른 하위 동작의 부모가 될 수 있으며 깊이 제한이 없습니다.'],
    'gantt.parent': ['上级', '上級', 'Parent', '親', '상위'],
    'gantt.rootHint': ['将创建顶层模块', '將建立頂層模組', 'Will create a top-level module', '最上位モジュールを作成します', '최상위 모듈을 만듭니다'],

    'timeScale.title': ['时间刻度与精度', '時間刻度與精度', 'Time scale & precision', '時間目盛と精度', '시간 눈금 및 정밀도'],
    'timeScale.scale': ['时间刻度 (ms/格)', '時間刻度 (ms/格)', 'Scale (ms / division)', '時間目盛 (ms/目盛)', '시간 눈금 (ms/칸)'],
    'timeScale.precision': ['时间精度 (ms)', '時間精度 (ms)', 'Precision (ms)', '時間精度 (ms)', '시간 정밀도 (ms)'],
    'timeScale.scaleHint': ['刻度可设为 1 ms；所有计算按整数毫秒进行。', '刻度可設為 1 ms；所有計算按整數毫秒進行。', 'Scale can be 1 ms; all computation uses integer milliseconds.', '目盛は 1 ms まで設定可能。計算はすべて整数ミリ秒で行います。', '눈금은 1 ms까지 설정 가능하며 모든 계산은 정수 밀리초로 수행됩니다.'],
    'timeScale.precisionHint': ['最小 1 ms；所有时刻吸附到该精度的整数倍。', '最小 1 ms；所有時刻吸附到該精度的整數倍。', 'Minimum 1 ms; every instant snaps to a multiple of this value.', '最小 1 ms。すべての時刻はこの精度の整数倍に丸められます。', '최소 1 ms. 모든 시각은 이 정밀도의 정수배로 맞춰집니다.'],
    'timeScale.unit': ['刻度显示单位', '刻度顯示單位', 'Ruler unit', '目盛の表示単位', '눈금 표시 단위'],
    'timeScale.gantt': ['甘特视图', '甘特檢視', 'Gantt view', 'ガントビュー', '간트 보기'],
    'timeScale.rowHeight': ['行高 (px)', '列高 (px)', 'Row height (px)', '行の高さ (px)', '행 높이 (px)'],
    'timeScale.showDeps': ['显示依赖连线', '顯示依賴連線', 'Show dependency arrows', '依存線を表示', '의존 화살표 표시'],
    'timeScale.showSummaries': ['显示父级汇总括号', '顯示父級彙總括號', 'Show parent summary brackets', '親の集計ブラケットを表示', '상위 요약 괄호 표시'],
    'timeScale.note': ['修改刻度/精度后，依赖引擎会重新量化并级联重算所有后置动作；甘特图、节拍网格、PDF、MP4 与 Excel 同步取新值。', '修改刻度/精度後，依賴引擎會重新量化並級聯重算所有後置動作；甘特圖、節拍網格、PDF、MP4 與 Excel 同步取新值。', 'Changing scale/precision re-quantises and cascades every successor start; Gantt, beat grid, PDF, MP4 and Excel all read the new values.', '目盛・精度を変更すると依存エンジンが再量子化し全後続タスクを連鎖再計算します。ガント図・拍グリッド・PDF・MP4・Excel は同じ新値を参照します。', '눈금/정밀도를 바꾸면 의존 엔진이 재양자화하고 모든 후속 작업을 연쇄 재계산합니다. 간트, 격자, PDF, MP4, Excel 이 모두 새 값을 사용합니다.'],

    'excel.title': ['甘特图 ⇄ Excel 转换', '甘特圖 ⇄ Excel 轉換', 'Gantt ⇄ Excel conversion', 'ガント図 ⇄ Excel 変換', '간트 ⇄ Excel 변환'],
    'excel.intro': ['第 1 页为精确毫秒表；第 2 页把图表按时间列展开为甘特矩阵；第 3 页保存设置、层级与依赖，可再导回。', '第 1 頁為精確毫秒表；第 2 頁把圖表按時間欄展開為甘特矩陣；第 3 頁保存設定、層級與依賴，可再導回。', 'Sheet 1 is the exact millisecond table; sheet 2 expands the chart into time columns; sheet 3 stores settings, hierarchy and dependencies for round-trip import.', 'シート1 は正確な ms 表、シート2 は時間列に展開したガント行列、シート3 は設定・階層・依存を保存し再インポートできます。', '시트1은 정확한 ms 표, 시트2는 시간 열로 펼친 간트 행렬, 시트3은 설정·계층·의존을 저장해 다시 가져올 수 있습니다.'],
    'excel.matrixStep': ['矩阵列跨度', '矩陣欄跨度', 'Matrix column span', '行列の列幅', '행렬 열 간격'],
    'excel.cellSize': ['单元格尺寸（可自定义）', '儲存格尺寸（可自訂）', 'Cell dimensions (customisable)', 'セルサイズ（カスタマイズ可）', '셀 크기 (사용자 지정)'],
    'excel.rowHeight': ['行高 (pt)', '列高 (pt)', 'Row height (pt)', '行の高さ (pt)', '행 높이 (pt)'],
    'excel.headerHeight': ['表头高 (pt)', '表頭高 (pt)', 'Header height (pt)', 'ヘッダー高さ (pt)', '헤더 높이 (pt)'],
    'excel.fontSize': ['字号 (pt)', '字級 (pt)', 'Font size (pt)', 'フォントサイズ (pt)', '글자 크기 (pt)'],
    'excel.matrixCellWidth': ['矩阵列宽 (字符)', '矩陣欄寬 (字元)', 'Matrix column width (chars)', '行列の列幅 (文字)', '행렬 열 너비 (문자)'],
    'excel.matrixRowHeight': ['矩阵行高 (pt)', '矩陣列高 (pt)', 'Matrix row height (pt)', '行列の行高さ (pt)', '행렬 행 높이 (pt)'],
    'excel.columnWidths': ['各列宽度（字符）', '各欄寬度（字元）', 'Column widths (chars)', '各列の幅 (文字)', '열 너비 (문자)'],
    'excel.includeHidden': ['导出被隐藏（已折叠）的子动作行', '匯出被隱藏（已摺疊）的子動作列', 'Export rows hidden by collapse', '折りたたんで非表示の子動作も出力', '접혀 숨겨진 하위 동작도 내보내기'],
    'excel.export': ['导出 Excel', '匯出 Excel', 'Export Excel', 'Excel を書き出す', 'Excel 내보내기'],
    'excel.import': ['导入 Excel（回写甘特图）', '匯入 Excel（回寫甘特圖）', 'Import Excel (write back to Gantt)', 'Excel を読み込む（ガントへ反映）', 'Excel 가져오기 (간트에 반영)'],
    'excel.verify': ['校验一致性', '校驗一致性', 'Verify consistency', '整合性を検証', '일치성 검증'],
    'excel.verified': ['已校验 {{count}} 行；图表与表格数据一致，无冲突。', '已校驗 {{count}} 列；圖表與表格資料一致，無衝突。', 'Verified {{count}} rows; chart and table data are consistent, no conflicts.', '{{count}} 行を検証しました。図表と表のデータは一致し、矛盾はありません。', '{{count}}행 검증 완료. 차트와 표 데이터가 일치하며 충돌이 없습니다.'],
    'excel.issues': ['处不一致', '處不一致', 'inconsistencies', '件の不一致', '건 불일치'],
    'excel.exportFailed': ['Excel 导出失败', 'Excel 匯出失敗', 'Excel export failed', 'Excel 書き出し失敗', 'Excel 내보내기 실패'],
    'excel.importFailed': ['Excel 导入失败', 'Excel 匯入失敗', 'Excel import failed', 'Excel 読み込み失敗', 'Excel 가져오기 실패'],
    'excel.imported': ['已导入 {{count}} 行并按依赖重新排程；甘特图与表格已同步。', '已匯入 {{count}} 列並按依賴重新排程；甘特圖與表格已同步。', 'Imported {{count}} rows and re-scheduled from dependencies; chart and table are in sync.', '{{count}} 行を読み込み依存から再スケジュール済み。ガント図と表は同期しています。', '{{count}}행을 가져와 의존관계로 재배치했으며 차트와 표가 동기화되었습니다.'],
    'excel.importOk': ['Excel 已导入', 'Excel 已匯入', 'Excel imported', 'Excel を読み込みました', 'Excel 가져오기 완료'],

    'dialog.add': ['添加', '新增', 'Add', '追加', '추가'],
    'dialog.apply': ['应用', '套用', 'Apply', '適用', '적용'],
    'dialog.close': ['关闭', '關閉', 'Close', '閉じる', '닫기'],
    'export.excel.description': ['动作时序表 + 甘特矩阵 + 设置/依赖，单元格尺寸可自定义，支持导回。', '動作時序表 + 甘特矩陣 + 設定/依賴，儲存格尺寸可自訂，支援導回。', 'Timing table + Gantt matrix + settings/dependencies, custom cell sizes, round-trip import.', 'タイミング表 + ガント行列 + 設定/依存。セルサイズをカスタマイズでき、再インポートも可能。', '타이밍 표 + 간트 행렬 + 설정/의존. 셀 크기를 지정할 수 있고 다시 가져올 수 있습니다.'],
    'menu.file.export.excel': ['Excel 甘特表', 'Excel 甘特表', 'Excel Gantt workbook', 'Excel ガント表', 'Excel 간트 통합 문서'],
    'menu.file.export.grid': ['节拍网格（原有视图）', '節拍網格（原有檢視）', 'Beat grid (original view)', '拍グリッド（従来ビュー）', '박자 격자 (기존 보기)'],
}

def set_path(obj, dotted, value):
    parts = dotted.split('.')
    node = obj
    for p in parts[:-1]:
        if p not in node or not isinstance(node[p], dict):
            node[p] = {}
        node = node[p]
    node[parts[-1]] = value

def main():
    for i, locale in enumerate(LOCALES):
        path = os.path.join('src', 'locales', locale, 'common.json')
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        for key, values in T.items():
            set_path(data, key, values[i])
        with open(path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        print(locale, '->', len(T), 'keys')

if __name__ == '__main__':
    main()
