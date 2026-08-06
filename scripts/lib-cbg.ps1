# ============================================================
# lib-cbg.ps1 — 率土之滨藏宝阁评估公共库
# 所有分析/统计/规划脚本 dot-source 本文件, 避免逻辑重复
# 用法(在脚本开头): . "$PSScriptRoot\lib-cbg.ps1"
# 统一维护: 榜单解析 / 战法映射 / 版本校验 / 落地判断
# ============================================================

$script:Root = Split-Path $PSScriptRoot -Parent
$script:RankFile = Join-Path (Join-Path $script:Root 'docs') '队伍强度排行榜.md'

# ---- 战法简称 → 全名映射(榜单用简称, 详情页用全名) ----
$script:TacticMap = @{
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

# ---- 版本/阵营要求: 榜单武将名 → 账号武将 marks 必须包含的标记 ----
# 教训: 汉曹操≠魏曹操 / 汉荀彧≠魏荀彧 / XP姜维≠普通姜维, 同名不能顶替
$script:VersionReq = @{
    '汉苟彧' = '汉'; '汉孙坚' = '汉'; '汉董' = '汉'; '汉吕' = '汉'
    'XP姜维' = 'XP'; 'XP孙权' = 'XP'; 'XP周瑜' = 'XP'
    '弓吕' = '弓'; '群貂' = '群'; '新黄盖' = '新'
    '曹操' = '魏'; '吕吕' = '群'; '孙权' = '吴'; '董卓' = '群'; '姜维' = '蜀'
}

# ---- Normalize(榜单异名 → 采集标准名) ----
function Get-NormalizedHero {
    param([string]$name)
    $map = @{ 'XP姜维'='姜维'; '汉孙坚'='孙坚'; 'XP孙权'='孙权'; 'XP周瑜'='周瑜'; '祝融'='祝融夫人';
              '新黄盖'='黄盖'; '汉苟彧'='荀彧'; '泪授'='沮授'; '汉董'='董卓'; '几突骨'='兀突骨';
              '木鹿'='木鹿大王'; '群貂'='貂蝉'; '吕吕'='吕布'; '弓吕'='吕布'; '汉吕'='吕布'; '丹英'='貂蝉' }
    $n = $name.Trim()
    if ($map.ContainsKey($n)) { return $map[$n] }
    return $n
}

# ---- 战法命中检测(简称→全名) ----
function Test-TacticHit {
    param([string]$short, $accTacSet)
    if ($script:TacticMap.ContainsKey($short)) { foreach ($f in $script:TacticMap[$short]) { if ($accTacSet[$f]) { return $true } } }
    elseif ($accTacSet[$short]) { return $true }
    return $false
}

# ---- 解析榜单, 填充 $script:Teams ----
# 队伍对象: Tier / Team / Heroes(原始名) / T1 / T2 / Equip(均含3行武将, '/'分隔)
function Initialize-RankTeams {
    $script:Teams = @()
    $tier = ''; $cur = $null; $heroes = @(); $t1list = @(); $t2list = @(); $eql = @()
    # 速览是权威名单: 详细章节里已移档/过时的旧队伍一律跳过
    $summary = @{}
    foreach ($sl in Get-Content -LiteralPath $script:RankFile -Encoding UTF8) {
        if ($sl -match '^\|\s*(T0\+|T0-|T0|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$') {
            $summary[$Matches[1]] = @($Matches[2] -split '、' | ForEach-Object { $_.Trim() })
        }
    }
    foreach ($line in Get-Content -LiteralPath $script:RankFile -Encoding UTF8) {
        if ($line -match '^##\s+(T0\+|T0-|T0|T1|T2-)\s*$') { $tier = $Matches[1]; continue }
        # 其他二级标题(如"追加队伍"等附录)结束当前档位, 避免误算
        if ($line -match '^##\s+') { $tier = ''; $cur = $null; $heroes = @(); $t1list = @(); $t2list = @(); $eql = @(); continue }
        if ($line -match '^###\s+(.+)$') {
            $raw = $Matches[1].Trim(); $pt = $tier
            if ($raw -match '已降级') { $pt = 'T2-' }
            $raw = ($raw -split '：')[-1].Trim(); $raw = ($raw -replace '^\d+[.、]\s*','').Trim()
            $raw = ($raw -replace '（.+?）','').Trim()
            # 速览缺该档(如T0-)时以正文为准
            if ($raw -and (( -not $summary.ContainsKey($pt)) -or ($summary[$pt] -contains $raw))) { $cur = $raw; $heroes = @(); $t1list = @(); $t2list = @(); $eql = @() }
            continue
        }
        if ($cur -and $line -match '^\|\s*([^|]+?)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|') {
            $h = $Matches[1].Trim(); if ($h -in @('武将','---')) { continue }
            $t1list += $Matches[2].Trim(); $t2list += $Matches[3].Trim(); $eql += $Matches[4].Trim()
            $heroes += $h
            if ($heroes.Count -eq 3) {
                $script:Teams += [pscustomobject]@{ Tier=$pt; Team=$cur; Heroes=@($heroes); T1=($t1list -join '/'); T2=($t2list -join '/'); Equip=($eql -join '/') }
                $heroes = @(); $t1list = @(); $t2list = @(); $eql = @()
            }
        }
    }
}

# ---- 校验账号武将是否满足队伍武将(含版本/阵营校验) ----
# $heroMarks: 名字 -> marks数组(如 曹操 -> @('魏极N'))
function Test-TeamHeroes {
    param($team, $heroMarks)
    foreach ($h in $team.Heroes) {
        $nh = Get-NormalizedHero $h
        if (-not $heroMarks.ContainsKey($nh)) { return $false }
        $req = $script:VersionReq[$h]
        if ($req) {
            $ok = $false
            foreach ($mk in $heroMarks[$nh]) { if ($mk -match $req) { $ok = $true; break } }
            if (-not $ok) { return $false }
        }
    }
    return $true
}

# ---- 构建账号的 heroMarks(从 heroes 数组) ----
function Get-HeroMarksMap {
    param($heroes)
    $m = @{}
    foreach ($h in $heroes) { if (-not $m.ContainsKey($h.name)) { $m[$h.name] = @() }; $m[$h.name] += $h.marks }
    return $m
}

# ---- 队伍落地状态: 返回 TMiss(缺战法)/ EMiss(缺宝) ----
function Get-TeamLandStatus {
    param($team, $heroMarks, $accTac, $accEq)
    if (-not (Test-TeamHeroes $team $heroMarks)) { return $null }
    $needTs = @(); foreach ($t in @($team.T1, $team.T2)) { foreach ($x in ($t -split '/')) { $x = $x.Trim(); if ($x) { $needTs += $x } } }
    $needEs = @(); foreach ($e in ($team.Equip -split '/')) { $e = $e.Trim(); if ($e) { $needEs += $e } }
    $tMiss = @(); foreach ($t in ($needTs | Select-Object -Unique)) { if (-not (Test-TacticHit $t $accTac)) { $tMiss += $t } }
    $eMiss = @(); foreach ($e in ($needEs | Select-Object -Unique)) { if (-not $accEq[$e]) { $eMiss += $e } }
    return [pscustomobject]@{ TMiss = ($tMiss -join '/'); EMiss = ($eMiss -join '/'); TMissCount = $tMiss.Count; EMissCount = $eMiss.Count }
}
