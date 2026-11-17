# -*- coding: utf-8 -*-
"""Add the `resource` i18n namespace to all locale files (idempotent merge)."""
import json, io, os

BLOCKS = {
'zh-CN': {
  'resource': {
    'title':'资源','managerTitle':'资源管理（机构 / 电机）','managerHint':'资源只定义一次，供所有流程的动作共用。在任务的「资源占用」里引用它们，无需在各流程重复新建机构。',
    'nameLabel':'名称','type':'类型','uses':'处引用','add':'添加','new':'新建','newName':'新资源名称（如 管库抓手）',
    'remove':'删除资源','emptyShort':'暂无资源','laneHeader':'资源泳道','manage':'管理资源',
    'claims':'占用','busy':'忙碌','conflicts':'处冲突','empty':'暂无资源。点击 + 添加机构/电机，再为动作设置占用。',
    'conflictHint':'红色为资源占用冲突（仅提示，不自动改时序）。点击冲突块可跳到对应动作。',
    'allocTitle':'资源占用','allocSection':'资源占用','allocSectionHint':'精确窗口，重叠会提示','editAlloc':'编辑占用',
    'allocHint':'占用窗口相对本动作开始时间。动作被依赖顺延时，占用窗口自动跟随。同一资源窗口重叠会在资源视图标红（仅提示）。',
    'taskDuration':'动作时长','offset':'偏移','duration':'时长','removeClaim':'删除占用','addClaim':'添加占用',
    'selectResource':'资源','newResource':'新建资源','noResource':'（无资源，请先新建）',
    'needResource':'请先添加一个资源','invalidNumber':'偏移与时长必须是数字','zeroDuration':'占用时长必须大于 0（且在动作时长内）'
  }
},
'zh-TW': {
  'resource': {
    'title':'資源','managerTitle':'資源管理（機構 / 馬達）','managerHint':'資源只定義一次，供所有流程的動作共用。在任務的「資源佔用」裡引用它們，無需在各流程重複新建機構。',
    'nameLabel':'名稱','type':'類型','uses':'處引用','add':'新增','new':'新建','newName':'新資源名稱（如 管庫抓手）',
    'remove':'刪除資源','emptyShort':'暫無資源','laneHeader':'資源泳道','manage':'管理資源',
    'claims':'佔用','busy':'忙碌','conflicts':'處衝突','empty':'暫無資源。點擊 + 新增機構/馬達，再為動作設定佔用。',
    'conflictHint':'紅色為資源佔用衝突（僅提示，不自動改時序）。點擊衝突塊可跳到對應動作。',
    'allocTitle':'資源佔用','allocSection':'資源佔用','allocSectionHint':'精確視窗，重疊會提示','editAlloc':'編輯佔用',
    'allocHint':'佔用視窗相對本動作開始時間。動作被依賴順延時，佔用視窗自動跟隨。同一資源視窗重疊會在資源檢視標紅（僅提示）。',
    'taskDuration':'動作時長','offset':'偏移','duration':'時長','removeClaim':'刪除佔用','addClaim':'新增佔用',
    'selectResource':'資源','newResource':'新建資源','noResource':'（無資源，請先新建）',
    'needResource':'請先新增一個資源','invalidNumber':'偏移與時長必須是數字','zeroDuration':'佔用時長必須大於 0（且在動作時長內）'
  }
},
'en': {
  'resource': {
    'title':'Resources','managerTitle':'Resources (mechanisms / motors)','managerHint':'Each resource is defined once and shared by actions across all flows. Reference them in an action’s resource allocations — no need to recreate the mechanism in every flow.',
    'nameLabel':'Name','type':'Type','uses':'uses','add':'Add','new':'New','newName':'New resource name (e.g. tube gripper)',
    'remove':'Remove resource','emptyShort':'No resources yet','laneHeader':'Resource lanes','manage':'Manage resources',
    'claims':'claims','busy':'busy','conflicts':'conflicts','empty':'No resources. Click + to add a mechanism/motor, then set claims on actions.',
    'conflictHint':'Red marks a resource conflict (hint only — timing is not auto-changed). Click a conflict to jump to its action.',
    'allocTitle':'Resource allocation','allocSection':'Resource allocation','allocSectionHint':'Exact windows, overlaps are flagged','editAlloc':'Edit claims',
    'allocHint':'Claim windows are relative to this action’s start. When the action is pushed by dependencies, its claims move with it. Overlapping windows on one resource are flagged red in the resource view (hint only).',
    'taskDuration':'Action duration','offset':'Offset','duration':'Duration','removeClaim':'Remove claim','addClaim':'Add claim',
    'selectResource':'Resource','newResource':'New resource','noResource':'（no resources — create one first）',
    'needResource':'Add a resource first','invalidNumber':'Offset and duration must be numbers','zeroDuration':'Duration must be > 0 (and within the action)'
  }
},
'ja': {
  'resource': {
    'title':'リソース','managerTitle':'リソース管理（機構 / モーター）','managerHint':'リソースは一度だけ定義し、全フローの動作で共有します。動作の「リソース占有」で参照してください。各フローで機構を作り直す必要はありません。',
    'nameLabel':'名前','type':'種別','uses':'件の参照','add':'追加','new':'新規','newName':'新しいリソース名（例: チューブ把持）',
    'remove':'リソースを削除','emptyShort':'リソースがありません','laneHeader':'リソース レーン','manage':'リソース管理',
    'claims':'占有','busy':'稼働','conflicts':'件の衝突','empty':'リソースがありません。+ で機構/モーターを追加し、動作に占有を設定してください。',
    'conflictHint':'赤色はリソース占有の衝突です（警告のみ、タイミングは自動変更しません）。衝突をクリックで該当動作へ移動。',
    'allocTitle':'リソース占有','allocSection':'リソース占有','allocSectionHint':'正確なウィンドウ、重複は警告','editAlloc':'占有を編集',
    'allocHint':'占有ウィンドウはこの動作の開始からの相対値です。依存で動作が繰り下がると占有も追従します。同一リソースの重複はリソース表示で赤く警告します（警告のみ）。',
    'taskDuration':'動作時間','offset':'オフセット','duration':'時間','removeClaim':'占有を削除','addClaim':'占有を追加',
    'selectResource':'リソース','newResource':'新規リソース','noResource':'（リソースなし。先に作成してください）',
    'needResource':'先にリソースを追加してください','invalidNumber':'オフセットと時間は数値で入力','zeroDuration':'占有時間は 0 より大きく（動作時間内）'
  }
},
'ko': {
  'resource': {
    'title':'리소스','managerTitle':'리소스 관리（기구 / 모터）','managerHint':'리소스는 한 번만 정의하여 모든 흐름의 동작이 공유합니다. 작업의 「리소스 점유」에서 참조하세요. 흐름마다 기구를 다시 만들 필요가 없습니다.',
    'nameLabel':'이름','type':'유형','uses':'회 참조','add':'추가','new':'새로 만들기','newName':'새 리소스 이름 (예: 튜브 그리퍼)',
    'remove':'리소스 삭제','emptyShort':'리소스 없음','laneHeader':'리소스 레인','manage':'리소스 관리',
    'claims':'점유','busy':'사용 중','conflicts':'건 충돌','empty':'리소스가 없습니다. + 를 눌러 기구/모터를 추가한 뒤 작업에 점유를 설정하세요.',
    'conflictHint':'빨간색은 리소스 점유 충돌입니다(알림만 표시, 타이밍은 자동 변경 안 함). 충돌을 클릭하면 해당 작업으로 이동합니다.',
    'allocTitle':'리소스 점유','allocSection':'리소스 점유','allocSectionHint':'정확한 구간, 겹치면 알림','editAlloc':'점유 편집',
    'allocHint':'점유 구간은 이 작업 시작 기준 상대값입니다. 의존으로 작업이 밀리면 점유도 함께 이동합니다. 같은 리소스의 구간이 겹치면 리소스 보기에서 빨간색으로 알립니다(알림만).',
    'taskDuration':'작업 시간','offset':'오프셋','duration':'지속 시간','removeClaim':'점유 삭제','addClaim':'점유 추가',
    'selectResource':'리소스','newResource':'새 리소스','noResource':'(리소스 없음. 먼저 만드세요)',
    'needResource':'리소스를 먼저 추가하세요','invalidNumber':'오프셋과 지속 시간은 숫자여야 합니다','zeroDuration':'점유 시간은 0보다 커야 하고 작업 시간 이내여야 합니다'
  }
}
}

def merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            merge(dst[k], v)
        else:
            dst[k] = v

for locale, block in BLOCKS.items():
    path = os.path.join('src', 'locales', locale, 'common.json')
    data = json.load(io.open(path, encoding='utf-8'))
    merge(data, block)
    io.open(path, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(locale, 'ok', len(data.get('resource', {})))
