# -*- coding: utf-8 -*-
import json
import io
import glob

V = {
    'zh-CN': dict(
        title='固定周期设置', enable='启用多周期展开',
        hint='底层只保存一份动作模板；展开后每个周期是只读实例，编辑任一实例都会同步回模板。',
        length='周期时长 (ms)', repeats='展开周期数',
        singleTotal='单周期实际节拍', projectedTotal='展开后总时间轴',
        overrun='个动作超出周期边界，跨周期资源冲突会在资源视图标红',
        within='所有动作均在周期内完成',
        single='单周期', singleTip='只显示一份动作模板，可直接编辑',
        multi='多周期', multiTip='按固定周期展开多个只读实例',
        settings='周期时长与数量'),
    'zh-TW': dict(
        title='固定週期設定', enable='啟用多週期展開',
        hint='底層只保存一份動作範本；展開後每個週期是唯讀實例，編輯任一實例都會同步回範本。',
        length='週期時長 (ms)', repeats='展開週期數',
        singleTotal='單週期實際節拍', projectedTotal='展開後總時間軸',
        overrun='個動作超出週期邊界，跨週期資源衝突會在資源檢視標紅',
        within='所有動作均在週期內完成',
        single='單週期', singleTip='只顯示一份動作範本，可直接編輯',
        multi='多週期', multiTip='按固定週期展開多個唯讀實例',
        settings='週期時長與數量'),
    'en': dict(
        title='Fixed cycle settings', enable='Enable multi-cycle projection',
        hint='Only one action template is stored. Projected cycles are read-only; editing any instance writes back to the template.',
        length='Cycle length (ms)', repeats='Cycle count',
        singleTotal='Single-cycle makespan', projectedTotal='Projected timeline',
        overrun='actions cross the cycle boundary; cross-cycle resource conflicts are marked in the resource view',
        within='All actions finish inside one cycle',
        single='Single', singleTip='Show one editable template',
        multi='Multi', multiTip='Project several read-only cycles',
        settings='Cycle length and count'),
    'ja': dict(
        title='固定サイクル設定', enable='複数サイクル展開を有効にする',
        hint='保存される動作テンプレートは1つだけです。展開された各サイクルは読み取り専用で、どのインスタンスを編集してもテンプレートに反映されます。',
        length='サイクル長 (ms)', repeats='展開サイクル数',
        singleTotal='1サイクルの実測時間', projectedTotal='展開後のタイムライン',
        overrun='個の動作がサイクル境界を超過；サイクル間のリソース競合はリソースビューで赤表示されます',
        within='すべての動作がサイクル内で完了',
        single='単一', singleTip='編集可能なテンプレートを1つだけ表示',
        multi='複数', multiTip='固定周期で複数の読み取り専用インスタンスを展開',
        settings='サイクル長と回数'),
    'ko': dict(
        title='고정 사이클 설정', enable='다중 사이클 전개 활성화',
        hint='동작 템플릿은 하나만 저장됩니다. 전개된 사이클은 읽기 전용이며 어느 인스턴스를 편집해도 템플릿에 반영됩니다.',
        length='사이클 길이 (ms)', repeats='전개 사이클 수',
        singleTotal='단일 사이클 실제 시간', projectedTotal='전개 후 전체 타임라인',
        overrun='개의 동작이 사이클 경계를 초과했습니다. 사이클 간 리소스 충돌은 리소스 보기에서 빨간색으로 표시됩니다.',
        within='모든 동작이 사이클 안에서 완료됩니다',
        single='단일', singleTip='편집 가능한 템플릿 하나만 표시',
        multi='다중', multiTip='고정 주기로 여러 읽기 전용 인스턴스 전개',
        settings='사이클 길이와 횟수')
}

for path in glob.glob('src/locales/*/common.json'):
    locale = path.replace('\\', '/').split('/')[-2]
    data = json.load(io.open(path, encoding='utf-8'))
    data.setdefault('cycle', {}).update(V[locale])
    io.open(path, 'w', encoding='utf-8').write(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(locale, 'cycle keys', len(data['cycle']))
