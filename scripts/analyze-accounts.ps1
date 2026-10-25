# 率土之滨藏宝阁 - 账号批量评估脚本
# 用法: powershell -File analyze-accounts.ps1
# 输入: accounts-detail.json (cbg-detail-extract.js 产出)
# 输出: 控制台排名表 + accounts-report.md
#
# 评估维度（阈值/权重全部来自 data/strategy-config.json，经 lib-config.ps1 读取）:
#   - 武将匹配分: 档位权重 = l3_scoring.tierWeight（当前 T0+=10 / T0=8 / T1=5 / T2-=2）
#   - 版本硬规则: l3_scoring.versionOverrides（如 司马懿 要求「晋」版本）+ 本文件历史版本表
#   - 跳过武将: l3_scoring.skipHeroes（含该武将的队伍不计入匹配）
#   - 满红: 采用概览满红总数; 核心觉醒 = 觉醒(marks含极)且为核心武将
#   - 战法/宝物: 对照 T0+/T0 队伍需求统计命中数(参考)
#   - 吃红度队伍降权: 三典藏菜刀/大张鲁/沙魏马/胡芳网红/父子队 匹配时减半（队伍名单属业务命名，未入配置）
#   - 推荐排除: l0_data.excludeFromRecommend（sold/delisted 状态不进入推荐榜单）

param(
    [string]$DataFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\accounts-final.json'),
    [string]$RankFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\队伍强度排行榜.md'),
    [string]$OutReport = (Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\accounts-report.md')
)

# 配置单源：data/strategy-config.json（Node 侧 lib-config.js 读同一份）
. "$PSScriptRoot\lib-config.ps1"
$L0 = Get-StzbL0
$L1 = Get-StzbL1
$L2 = Get-StzbL2
$L3 = Get-StzbL3
$tierWeight = Get-StzbTierWeight
$cfgFp = Get-StzbConfigFingerprint
Write-StzbEffective -Prefix '[analyze]'

if (-not (Test-Path $DataFile)) { Write-Error "缺少 $DataFile"; exit 1 }

# ========== 1. 解析榜单 ==========
$tier = ''
$currentTeam = $null
$heroes = @()
$teams = @()
$tacticSet = @{}   # 所有 T0+/T0/T0- 队伍用到的战法
$equipSet = @{}    # 所有 T0+/T0/T0- 队伍用到的宝物
$t1list = @(); $t2list = @(); $eql = @()

# 速览是权威名单: 详细章节里已移档/过时的旧队伍一律跳过
$summary = @{}
foreach ($sl in Get-Content -LiteralPath $RankFile -Encoding UTF8) {
    if ($sl -match '^\|\s*(T0\+|T0-|T0|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$') {
        $summary[$Matches[1]] = @($Matches[2] -split '、' | ForEach-Object { $_.Trim() })
    }
}

foreach ($line in Get-Content -LiteralPath $RankFile -Encoding UTF8) {
    if ($line -match '^##\s+(T0\+|T0-|T0|T1|T2-)\s*$') {
        $tier = $Matches[1]
        continue
    }
    # 其他二级标题(如"追加队伍"等附录)结束当前档位, 避免误算
    if ($line -match '^##\s+') { $tier = ''; $cur = $null; $heroes = @(); $t1list = @(); $t2list = @(); $eql = @(); continue }
    if ($line -match '^###\s+(.+)$') {
        $raw = $Matches[1].Trim()
        # 仅按队伍标题中的明确降级标注切换到 T2-
        $pendingTier = $tier
        if ($raw -match '已降级\s*(T2-)') { $pendingTier = 'T2-' }
        $raw = ($raw -split '：')[-1].Trim()
        $raw = ($raw -replace '^\d+[.、]\s*', '').Trim()   # 去标题序号 "1. "
        $raw = ($raw -replace '（.+?）', '').Trim()
        # 速览缺该档(如T0-)时以正文为准
        if ($raw -and (( -not $summary.ContainsKey($pendingTier)) -or ($summary[$pendingTier] -contains $raw))) {
            $currentTeam = $raw
            $heroes = @()
        }
        continue
    }
    if ($currentTeam -and $line -match '^\|\s*([^|]+?)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|') {
        $h = $Matches[1].Trim()
        if ($h -in @('武将', '---')) { continue }
        # 累积所有3行武将的战法/宝物(不能只存最后一行)
        $t1list += $Matches[2].Trim(); $t2list += $Matches[3].Trim(); $eql += $Matches[4].Trim()
        $heroes += $h
        if ($heroes.Count -eq 3) {
            $teams += [pscustomobject]@{ Tier = $pendingTier; Team = $currentTeam; Heroes = @($heroes); T1 = ($t1list -join '/'); T2 = ($t2list -join '/'); Equip = ($eql -join '/') }
            # 收集战法/宝物(仅 T0+/T0/T0-)
            if ($pendingTier -in @('T0+', 'T0', 'T0-')) {
                foreach ($tc in @($t1list, $t2list)) {
                    foreach ($t in $tc) { $t = $t.Trim(); if ($t) { $tacticSet[$t] = $true } }
                }
                foreach ($e in $eql) { $e = $e.Trim(); if ($e) { $equipSet[$e] = $true } }
            }
            $heroes = @(); $t1list = @(); $t2list = @(); $eql = @()
        }
    }
}

Write-Host "榜单队伍: $($teams.Count) 支"

# Normalize(与 strict-version-round1 一致)
function Normalize-Hero([string]$name) {
    $map = @{ 'XP姜维'='姜维'; '汉孙坚'='孙坚'; 'XP孙权'='孙权'; 'XP周瑜'='周瑜'; '祝融'='祝融夫人';
              '新黄盖'='黄盖'; '汉苟彧'='荀彧'; '泪授'='沮授'; '汉董'='董卓'; '几突骨'='兀突骨';
              '木鹿'='木鹿大王'; '群貂'='貂蝉'; '吕吕'='吕布'; '弓吕'='吕布'; '汉吕'='吕布'; '丹英'='貂蝉'; 'SP赵云'='赵云' }
    $n = $name.Trim()
    if ($map.ContainsKey($n)) { return $map[$n] }
    return $n
}

# 版本/阵营要求: 榜单武将名 → 账号对应武将 marks 必须包含的标记
# (汉荀彧/XP姜维等带版本含义的武将, 不能被普通同名武将顶替)
$versionReq = @{
    '汉苟彧' = '汉'; '汉孙坚' = '汉'; '汉董' = '汉'; '汉吕' = '汉'
    'XP姜维' = 'XP'; 'XP孙权' = 'XP'; 'XP周瑜' = 'XP'
    '弓吕' = '弓'; '群貂' = '群'; '新黄盖' = '新'
    '曹操' = '魏'   # 排行榜曹操均为五星魏曹操, 汉曹操不能顶替(螃蟹队/三典藏/龙虎骑等)
    '关羽' = '蜀'   # 排行榜关羽均为蜀关羽, 魏关羽不能顶替(豹纹刀/合纵蜀骑/五虎队等)
    '赵云' = 'SP'   # 排行榜赵云均为SP赵云, 普通赵云不能顶替(五虎队/定军赵/赵维机/蜀刀)
    '吕吕' = '群'   # 龙虎骑/鬼无敌的吕吕=群吕布, 汉吕/弓吕不能顶替
    '孙权' = '吴'   # 甘宁流氓/孙张鲁等用普通吴孙权
    '董卓' = '群'   # 普通董卓需群阵营(汉董已单独要求汉)
    '姜维' = '蜀'   # 赵维机等用普通蜀姜维(XP姜维已单独要求XP)
}

# 配置覆盖：l3_scoring.versionOverrides 追加/覆盖版本硬规则（如 司马懿 → 晋）
$cfgVersionOverrides = 0
foreach ($p in $L3.versionOverrides.PSObject.Properties) { $versionReq[$p.Name] = [string]$p.Value; $cfgVersionOverrides++ }
# 配置：l3_scoring.skipHeroes —— 含这些武将的榜单队伍整队跳过（原硬编码 弓诸葛/司马懿）
$skipHeroSet = @{}
foreach ($h in @($L3.skipHeroes)) { if ($h) { $skipHeroSet[[string]$h] = $true } }
# 档位权重/排序全部来自 l3_scoring.tierWeight，缺失档位计 0 并汇总警告（不再静默写死 switch）
$tierW = @{}
$tierOrder = @{}
$tierIdx = 0
foreach ($p in $tierWeight.PSObject.Properties) { $tierW[$p.Name] = [int]$p.Value; $tierOrder[$p.Name] = $tierIdx; $tierIdx++ }
$missingTiers = @{}
Write-Host "版本硬规则: $($versionReq.Count) 项（其中配置覆盖 $cfgVersionOverrides 项）| 跳过武将: $(@($L3.skipHeroes) -join ',') | tier权重: $(($tierWeight.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' ')"

# 核心武将清单(所有队伍核心, Normalize 后去重)
$coreHeroSet = @{}
foreach ($t in $teams) { foreach ($h in $t.Heroes) { $coreHeroSet[(Normalize-Hero $h)] = $true } }

# 吃红度队伍(降权)
$redSensitive = @('三典藏菜刀', '大张鲁', '沙魏马', '胡芳网红', '父子队')

# 战法简称 → 全名映射(榜单用简称, 详情页用全名)
$tacticMap = @{
    '合纵'=@('合纵连横'); '避锐'=@('避锐治气'); '百战'=@('百战无怯','百战精兵'); '愈战'=@('愈战愈勇')
    '垒实'=@('垒实迎击'); '三术'=@('三术奇谋'); '桃园'=@('桃园结义'); '正始'=@('正始之变')
    '一骑'=@('一骑当千'); '令无'=@('令无空悬'); '一夫'=@('一夫当关'); '浑水'=@('浑水摸鱼')
    '神兵'=@('神兵天降'); '大赏'=@('大赏三军'); '众谋'=@('众谋不懈'); '先驱'=@('先驱突击')
    '击势'=@('击势'); '乘胜'=@('乘胜追击'); '疾击'=@('疾击其后'); '飒沓'=@('飒沓如星')
    '单骑'=@('单骑救主'); '长兵'=@('长兵方阵'); '文伐'=@('文伐'); '战必'=@('战必断金')
    '反计'=@('反计之策','反计'); '火烧'=@('火烧连营'); '河内'=@('河内世泽'); '久战'=@('久战熟谋')
    '当阳'=@('当阳桥'); '攻其'=@('攻其不备','攻其要害'); '三军'=@('三军齐出','大赏三军','三军之众')
    '兵无'=@('兵无常势'); '步步'=@('步步为营'); '除恶'=@('除恶务尽'); '道行'=@('道行险阻')
    '风声'=@('风声鹤唳'); '及锋'=@('及锋而试'); '计险'=@('计险远近'); '兼弱'=@('兼弱攻昧')
    '健卒'=@('健卒不殆'); '绝水'=@('绝水遏敌'); '利兵'=@('利兵谋胜'); '谋定'=@('谋定后动')
    '磐阵'=@('磐阵善守'); '奇正'=@('奇正之势'); '全军'=@('全军突击'); '深谋'=@('深谋远虑')
    '胜兵'=@('胜兵求战'); '势无'=@('势无虚动'); '望风'=@('望风而降'); '威震'=@('威震逍遥')
    '无心'=@('无心恋战'); '形兵'=@('形兵之极'); '悬权'=@('悬权而动'); '以诱'=@('以诱待来')
    '诱敌'=@('诱敌深入','诱敌'); '知己'=@('知己知彼'); '甚陷'=@('甚陷不惧')
    '风仪亭'=@('凤仪亭'); '追击'=@('乘胜追击')
    '反击之策'=@('反击之策'); '反间'=@('反间'); '合众'=@('合众'); '疾战'=@('疾战')
    '衡轭'=@('衡轭'); '始计'=@('始计'); '空城'=@('空城'); '妖术'=@('妖术')
    '枭雄'=@('枭雄'); '闪击'=@('闪击'); '不攻'=@('不攻')
}

# ========== 2. 读取账号数据 ==========
$accounts = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "账号数: $($accounts.Count)"

# 数据快照时间 / 来源分布 / 状态分布 / 推荐排除集（全部配置驱动）
$captured = @()
foreach ($a in $accounts) {
    if ($a.capturedAt) { try { $captured += [datetime]::Parse([string]$a.capturedAt) } catch { } }
}
if ($captured.Count -gt 0) {
    $minCap = ($captured | Measure-Object -Minimum).Minimum
    $maxCap = ($captured | Measure-Object -Maximum).Maximum
    $snapText = "$($minCap.ToString('yyyy-MM-dd HH:mm')) ~ $($maxCap.ToString('yyyy-MM-dd HH:mm'))（$($captured.Count)/$($accounts.Count) 条有 capturedAt）"
} else {
    $snapText = "无 capturedAt 字段（旧数据），文件时间 $((Get-Item -LiteralPath $DataFile).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
}
$sourceStats = @{}
$statusStats = @{}
foreach ($a in $accounts) {
    $src = if ($a.source) { [string]$a.source } else { 'unknown' }
    $stk = if ($a.statusKind) { [string]$a.statusKind } else { Get-StzbStatusKind -Text $a.overview.status }
    $sourceStats[$src] = 1 + [int]$sourceStats[$src]
    $statusStats[$stk] = 1 + [int]$statusStats[$stk]
}
function Format-StatMap([hashtable]$map) {
    return (($map.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ' / ')
}
$excludedKinds = @($L0.excludeFromRecommend)
Write-Host "数据快照: $snapText"
Write-Host "来源分布: $(Format-StatMap $sourceStats) | 状态分布: $(Format-StatMap $statusStats) | 推荐排除: $($excludedKinds -join ',') | config: $cfgFp"

$report = @()
foreach ($acc in $accounts) {
    if (-not $acc.overview) { continue }
    $ov = $acc.overview
    # 账号识别名优先用列表页标签(用户看到的), 详情页server不稳定
    $listSrv = ''
    if ($acc.list -and $acc.list.server) { $listSrv = $acc.list.server } else { $listSrv = $ov.server }
    $label = "$listSrv ¥$($ov.price)"
    # 商品链接(去掉追踪参数)
    $cleanUrl = if ($ov.url) { ($ov.url -split '\?')[0] } else { '' }
    # 数据溯源/状态（新数据由采集/合并写入；旧数据现场归一化）
    $statusKind = if ($acc.statusKind) { [string]$acc.statusKind } else { Get-StzbStatusKind -Text $ov.status }
    $source = if ($acc.source) { [string]$acc.source } else { 'unknown' }

    # 武将名字 → marks 列表(用于版本/阵营校验)
    $heroMarks = @{}
    foreach ($h in $acc.heroes) {
        if (-not $heroMarks.ContainsKey($h.name)) { $heroMarks[$h.name] = @() }
        $heroMarks[$h.name] += $h.marks
    }

    # 武将匹配(含版本/阵营校验: 汉荀彧/XP姜维等不能由普通同名顶替)
    $matched = @()
    foreach ($teamDef in $teams) {
        $skipTeam = $false
        foreach ($th in $teamDef.Heroes) { if ($skipHeroSet.ContainsKey([string]$th)) { $skipTeam = $true; break } }
        if ($skipTeam) { continue }
        $ok = $true
        foreach ($h in $teamDef.Heroes) {
            $nh = Normalize-Hero $h
            if (-not $heroMarks.ContainsKey($nh)) { $ok = $false; break }
            $req = $versionReq[$h]
            if ($req) {
                $satisfied = $false
                foreach ($mk in $heroMarks[$nh]) { if ($mk -match $req) { $satisfied = $true; break } }
                if (-not $satisfied) { $ok = $false; break }
            }
        }
        if ($ok) { $matched += $teamDef }
    }

    $score = 0
    foreach ($m in $matched) {
        $w = if ($tierW.ContainsKey([string]$m.Tier)) { $tierW[[string]$m.Tier] } else { $missingTiers[[string]$m.Tier] = $true; 0 }
        if ($m.Team -in $redSensitive) { $w = [math]::Ceiling($w / 2) }  # 吃红度降权
        $score += $w
    }
    $t0p = @($matched | Where-Object Tier -eq 'T0+').Count
    $t0 = @($matched | Where-Object Tier -eq 'T0').Count
    $t0m = @($matched | Where-Object Tier -eq 'T0-').Count
    $topTeams = (($matched | Sort-Object @{ Expression = { if ($tierOrder.ContainsKey([string]$_.Tier)) { $tierOrder[[string]$_.Tier] } else { 999 } } } | Select-Object -First 6 | ForEach-Object { "$($_.Team)($($_.Tier))" }) -join '、')

    # 满红 = 概览满红总数(详情页无武将级红度; marks 的「极」是觉醒非满红)
    $fullRedAll = 0
    if ($ov.fullRed -and $ov.fullRed -match '^\d+$') { $fullRedAll = [int]$ov.fullRed }
    # 核心觉醒 = marks 含「极」且为核心武将(培养度参考)
    $awakeCore = @($acc.heroes | Where-Object { $_.marks -match '极' -and $coreHeroSet[$_.name] } | ForEach-Object { $_.name } | Sort-Object -Unique)
    $fullRedCore = $awakeCore.Count

    # 战法命中(T0+/T0- 队伍所需战法, 简称→全名映射)
    $accTacticSet = @{}
    foreach ($t in $acc.tactics) { $accTacticSet[$t] = $true }
    $tacticHit = 0
    foreach ($t in $tacticSet.Keys) {
        $hit = $false
        if ($tacticMap.ContainsKey($t)) {
            foreach ($full in $tacticMap[$t]) { if ($accTacticSet[$full]) { $hit = $true; break } }
        } elseif ($accTacticSet[$t]) { $hit = $true }
        if ($hit) { $tacticHit++ }
    }
    $tacticTotal = $tacticSet.Count

    # 宝物命中
    $accEquipSet = @{}
    foreach ($e in $acc.equips) { $accEquipSet[$e] = $true }
    $equipHit = 0
    foreach ($e in $equipSet.Keys) { if ($accEquipSet[$e]) { $equipHit++ } }
    $equipTotal = $equipSet.Count

    $report += [pscustomobject]@{
        Label = $label
        Url = $cleanUrl
        Price = $ov.price
        Score = $score
        T0p = $t0p
        T0 = $t0
        T0m = $t0m
        FullRedAll = $fullRedAll
        FullRedCore = $fullRedCore
        TacticHit = $tacticHit
        TacticTotal = $tacticTotal
        EquipHit = $equipHit
        EquipTotal = $equipTotal
        TopTeams = $topTeams
        FullRedCoreList = ($awakeCore -join ',')
        StatusKind = $statusKind
        Source = $source
    }
}

# ========== 3. 输出排名 ==========
$dateStr = Get-Date -Format 'yyyyMMdd'
if ($missingTiers.Count -gt 0) {
    Write-Warning "以下档位不在 l3_scoring.tierWeight 中，计 0 分: $(@($missingTiers.Keys) -join ',')（建议在 data/strategy-config.json 补齐）"
}
$ordered = @($report | Sort-Object @{ Expression = 'Score'; Descending = $true }, Price)
$recommendable = @($ordered | Where-Object { $excludedKinds -notcontains $_.StatusKind })
$excludedRows = @($ordered | Where-Object { $excludedKinds -contains $_.StatusKind })
Write-Host ''
Write-Host "===== 账号评估排名(按武将分降序; 已排除 $(($excludedKinds -join '/')) 状态 $($excludedRows.Count) 个) ====="
Write-Host ("{0,-18} {1,6} {2,4} {3,4} {4,4} {5,4} {6,4} {7,4} | {8}" -f '账号', '价格', '分', 'T0+', 'T0', '满红', '核觉醒', '战法/宝', '队伍')
foreach ($r in $recommendable) {
    Write-Host ("{0,-18} {1,6} {2,4} {3,4} {4,4} {5,4} {6,4} {7,3}/{8,3} | {9}" -f $r.Label, $r.Price, $r.Score, $r.T0p, $r.T0, $r.FullRedAll, $r.FullRedCore, $r.TacticHit, $r.EquipHit, $r.TopTeams)
}
foreach ($r in $excludedRows) {
    Write-Host ("{0,-18} {1,6} {2,4} [已排除:$($r.StatusKind)]" -f $r.Label, $r.Price, $r.Score)
}

# 生成报告文件
$sb = @()
$sb += "# 账号评估报告 - $dateStr"
$sb += ''
$sb += "> 数据快照: $snapText"
$sb += "> 来源分布: $(Format-StatMap $sourceStats) | 状态分布: $(Format-StatMap $statusStats)"
$sb += "> 推荐排除状态: $($excludedKinds -join ',')（已排除 $($excludedRows.Count) 个；数据源 $DataFile）"
$sb += "> 配置: data/strategy-config.json（sha1 前8位 $cfgFp; tier权重 $(($tierWeight.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '); 跳过武将 $(@($L3.skipHeroes) -join ','); 版本覆盖 $(($L3.versionOverrides.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','))"
$sb += ''
$sb += '> 武将70% + 战法15% + 宝物10% + 红度5% 框架; 满红=概览满红数, 核心觉醒=觉醒核心武将; 吃红度队伍(三典藏/大张鲁/沙魏马/胡芳网红/父子队)降权'
$sb += ''
$sb += '| 账号 | 价格 | 武将分 | T0+ | T0 | 满红 | 核心觉醒 | 战法命中 | 宝物命中 | 代表队伍 | 链接 |'
$sb += '|---|---|---|---|---|---|---|---|---|---|---|'
foreach ($r in $recommendable) {
    $sb += "| $($r.Label) | $($r.Price) | $($r.Score) | $($r.T0p) | $($r.T0) | $($r.FullRedAll) | $($r.FullRedCore) | $($r.TacticHit)/$($r.TacticTotal) | $($r.EquipHit)/$($r.EquipTotal) | $($r.TopTeams) | [$($r.Label)]($($r.Url)) |"
}
if ($excludedRows.Count -gt 0) {
    $sb += ''
    $sb += "## 已排除账号（$($excludedKinds -join '/')，不进入推荐）"
    foreach ($r in $excludedRows) {
        $sb += "- $($r.Label) [$($r.StatusKind)] 武将分 $($r.Score)"
    }
}
$sb += ''
$sb += '## 核心觉醒武将明细'
foreach ($r in $report) {
    if ($r.FullRedCoreList) { $sb += "- $($r.Label): $($r.FullRedCoreList)" }
}
$sb -join "`n" | Set-Content -LiteralPath $OutReport -Encoding UTF8
Write-Host ''
Write-Host "报告已保存: $OutReport"
