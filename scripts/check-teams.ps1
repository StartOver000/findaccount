# 逐队落地状态检查: 武将齐 + 战法命中 + 宝物命中 → 分类落地程度
# 用法: powershell -File check-teams.ps1 [-DataFile xxx.json]
param([string]$DataFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\accounts-final.json'))

$rank = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\队伍强度排行榜.md') -Encoding UTF8
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

function Test-TacticHit([string]$short, $accSet) {
    if ($tacticMap.ContainsKey($short)) { foreach ($f in $tacticMap[$short]) { if ($accSet[$f]) { return $true } } }
    elseif ($accSet[$short]) { return $true }
    return $false
}

function Normalize-Hero([string]$name) {
    $map = @{ 'XP姜维'='姜维'; '汉孙坚'='孙坚'; 'XP孙权'='孙权'; 'XP周瑜'='周瑜'; '祝融'='祝融夫人';
              '新黄盖'='黄盖'; '汉苟彧'='荀彧'; '泪授'='沮授'; '汉董'='董卓'; '几突骨'='兀突骨';
              '木鹿'='木鹿大王'; '群貂'='貂蝉'; '吕吕'='吕布'; '弓吕'='吕布'; '汉吕'='吕布'; '丹英'='貂蝉'; 'SP赵云'='赵云' }
    $n = $name.Trim()
    if ($map.ContainsKey($n)) { return $map[$n] }
    return $n
}
$versionReq = @{
    '汉苟彧' = '汉'; '汉孙坚' = '汉'; '汉董' = '汉'; '汉吕' = '汉'
    'XP姜维' = 'XP'; 'XP孙权' = 'XP'; 'XP周瑜' = 'XP'
    '弓吕' = '弓'; '群貂' = '群'; '新黄盖' = '新'
    '曹操' = '魏'; '关羽' = '蜀'; '赵云' = 'SP'
    '吕吕' = '群'; '孙权' = '吴'; '董卓' = '群'; '姜维' = '蜀'
}

# 解析榜单队伍
$tier = ''; $cur = $null; $heroes = @(); $teams = @(); $t1list = @(); $t2list = @(); $eql = @()
# 速览是权威名单: 详细章节里已移档/过时的旧队伍一律跳过
$summary = @{}
foreach ($sl in $rank) {
    if ($sl -match '^\|\s*(T0\+|T0-|T0|T1|T2-)\s*\|\s*(.+?)\s*\|\s*$') {
        $summary[$Matches[1]] = @($Matches[2] -split '、' | ForEach-Object { $_.Trim() })
    }
}
foreach ($line in $rank) {
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
            $teams += [pscustomobject]@{ Tier=$pt; Team=$cur; Heroes=@($heroes); T1=($t1list -join '/'); T2=($t2list -join '/'); Equip=($eql -join '/') }
            $heroes = @(); $t1list = @(); $t2list = @(); $eql = @()
        }
    }
}
$skipTeams = @($teams | Where-Object { $_.Heroes -contains '弓诸葛' -or $_.Heroes -contains '司马懿' } | ForEach-Object { $_.Team })

$data = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($acc in $data) {
    if (-not $acc.overview) { continue }
    $ov = $acc.overview
    $heroMarks = @{}
    foreach ($h in $acc.heroes) { if (-not $heroMarks.ContainsKey($h.name)) { $heroMarks[$h.name] = @() }; $heroMarks[$h.name] += $h.marks }
    $accTac = @{}; foreach ($t in $acc.tactics) { $accTac[$t] = $true }
    $accEq = @{}; foreach ($e in $acc.equips) { $accEq[$e] = $true }

    $rows = @()
    foreach ($team in $teams) {
        if ($team.Team -in $skipTeams) { continue }
        $allHeroes = $true
        foreach ($h in $team.Heroes) {
            $nh = Normalize-Hero $h
            if (-not $heroMarks.ContainsKey($nh)) { $allHeroes = $false; break }
            $req = $versionReq[$h]
            if ($req) {
                $ok2 = $false
                foreach ($mk in $heroMarks[$nh]) { if ($mk -match $req) { $ok2 = $true; break } }
                if (-not $ok2) { $allHeroes = $false; break }
            }
        }
        if (-not $allHeroes) { continue }
        # 战法命中
        $needT = @()
        foreach ($t in @($team.T1, $team.T2)) { foreach ($x in ($t -split '/')) { $x = $x.Trim(); if ($x) { $needT += $x } } }
        $tHit = 0; $tMiss = @()
        foreach ($t in ($needT | Select-Object -Unique)) { if (Test-TacticHit $t $accTac) { $tHit++ } else { $tMiss += $t } }
        # 宝物命中
        $needE = @(); foreach ($e in ($team.Equip -split '/')) { $e = $e.Trim(); if ($e) { $needE += $e } }
        $eHit = 0; $eMiss = @()
        foreach ($e in ($needE | Select-Object -Unique)) { if ($accEq[$e]) { $eHit++ } else { $eMiss += $e } }
        $needTCount = @($needT | Select-Object -Unique).Count
        $needECount = @($needE | Select-Object -Unique).Count
        if ($tHit -eq $needTCount -and $eHit -eq $needECount) { $st = '完整' }
        elseif ($tHit -eq $needTCount) { $st = '只缺宝' }
        elseif ($eHit -eq $needECount) { $st = '缺战法' }
        elseif ($tHit -ge [math]::Ceiling($needTCount/2)) { $st = '缺战法+宝' }
        else { $st = '缺战法+宝' }
        $rows += [pscustomobject]@{ 队伍=$team.Team; 档=$team.Tier; 状态=$st; 战法="$tHit/$needTCount"; 缺战法=($tMiss -join '/'); 宝="$eHit/$needECount"; 缺宝=($eMiss -join '/') }
    }
    $rows = @($rows | Sort-Object @{Expression={ if($_.档 -eq 'T0+'){0}elseif($_.档 -eq 'T0'){1}elseif($_.档 -eq 'T1'){2}else{3} } })
    $listSrv = ''
    if ($acc.list -and $acc.list.server) { $listSrv = $acc.list.server } else { $listSrv = $ov.server }
    "`n===== $listSrv ¥$($ov.price) 队伍落地 ====="
    foreach ($r in $rows) { "{0,-6} {1,-10} {2,-6} 战法{3,-5} {4,-20} 宝{5,-5} {6}" -f $r.档, $r.队伍, $r.状态, $r.战法, $r.缺战法, $r.宝, $r.缺宝 }
    if ($rows.Count -eq 0) { "  (无匹配队伍)" }
}
