# 按"武将全"偏好统计: 每个账号能组几支 T0+/T0- 队伍的武将骨架(只看武将, 不看战法/宝)
param([string]$DataFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\accounts-final.json'))

$rank = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\队伍强度排行榜.md') -Encoding UTF8
function Normalize-Hero([string]$name) {
    $map = @{ 'XP姜维'='姜维'; '汉孙坚'='孙坚'; 'XP孙权'='孙权'; 'XP周瑜'='周瑜'; '祝融'='祝融夫人';
              '新黄盖'='黄盖'; '汉苟彧'='荀彧'; '泪授'='沮授'; '汉董'='董卓'; '几突骨'='兀突骨';
              '木鹿'='木鹿大王'; '群貂'='貂蝉'; '吕吕'='吕布'; '弓吕'='吕布'; '汉吕'='吕布'; '丹英'='貂蝉' }
    $n = $name.Trim()
    if ($map.ContainsKey($n)) { return $map[$n] }
    return $n
}
$versionReq = @{
    '汉苟彧' = '汉'; '汉孙坚' = '汉'; '汉董' = '汉'; '汉吕' = '汉'
    'XP姜维' = 'XP'; 'XP孙权' = 'XP'; 'XP周瑜' = 'XP'
    '弓吕' = '弓'; '群貂' = '群'; '新黄盖' = '新'
    '曹操' = '魏'; '关羽' = '蜀'; '吕吕' = '群'; '孙权' = '吴'; '董卓' = '群'; '姜维' = '蜀'
}
# 解析榜单
$tier = ''; $cur = $null; $heroes = @(); $teams = @()
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
        if ($raw -and (( -not $summary.ContainsKey($pt)) -or ($summary[$pt] -contains $raw))) { $cur = $raw; $heroes = @() }
        continue
    }
    if ($cur -and $line -match '^\|\s*([^|]+?)\s*\|') {
        $h = $Matches[1].Trim(); if ($h -in @('武将','---')) { continue }
        $heroes += $h
        if ($heroes.Count -eq 3) {
            $teams += [pscustomobject]@{ Tier=$pt; Team=$cur; Heroes=@($heroes) }
            $heroes = @()
        }
    }
}
$t0 = @($teams | Where-Object { $_.Tier -in @('T0+','T0','T0-') -and $_.Heroes -notcontains '弓诸葛' -and $_.Heroes -notcontains '司马懿' })
$data = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
$report = @()
foreach ($acc in $data) {
    if (-not $acc.overview) { continue }
    $listSrv = ''; if ($acc.list -and $acc.list.server) { $listSrv = $acc.list.server } else { $listSrv = $acc.overview.server }
    $heroMarks = @{}
    foreach ($h in $acc.heroes) { if (-not $heroMarks.ContainsKey($h.name)) { $heroMarks[$h.name] = @() }; $heroMarks[$h.name] += $h.marks }
    $t0p = @(); $t0List = @(); $t0m = @()
    foreach ($team in $t0) {
        $ok = $true
        foreach ($h in $team.Heroes) {
            $nh = Normalize-Hero $h
            if (-not $heroMarks.ContainsKey($nh)) { $ok = $false; break }
            $req = $versionReq[$h]
            if ($req) { $s2 = $false; foreach ($mk in $heroMarks[$nh]) { if ($mk -match $req) { $s2 = $true; break } }; if (-not $s2) { $ok = $false; break } }
        }
        if ($ok) {
            if ($team.Tier -eq 'T0+') { $t0p += $team.Team }
            elseif ($team.Tier -eq 'T0') { $t0List += $team.Team }
            else { $t0m += $team.Team }
        }
    }
    $report += [pscustomobject]@{
        Label = "$listSrv ¥$($acc.overview.price)"
        T0p = @($t0p).Count
        T0 = @($t0List).Count
        T0m = @($t0m).Count
        Total = @($t0p).Count + @($t0List).Count + @($t0m).Count
        T0pList = ($t0p -join '、')
        T0List = ($t0List -join '、')
        T0mList = ($t0m -join '、')
    }
}
Write-Host ('{0,-16} {1,5} {2,5} {3,5} {4,5} | T0+武将队伍 | T0武将队伍 | T0-武将队伍' -f '账号', 'T0+', 'T0', 'T0-', '合计')
foreach ($r in ($report | Sort-Object Total, T0p -Descending | Select-Object -First 15)) {
    Write-Host ('{0,-16} {1,5} {2,5} {3,5} {4,5} | {5} | {6} | {7}' -f $r.Label, $r.T0p, $r.T0, $r.T0m, $r.Total, $r.T0pList, $r.T0List, $r.T0mList)
}
