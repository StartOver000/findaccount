# ============================================================
# plan5-v2.ps1 — 自动规划账号最佳5队(武将不重复) — 枚举算法
# 引用公共库 lib-cbg.ps1(榜单/映射/校验统一维护)
# 用法: powershell -File plan5-v2.ps1 [-Account X5836] [-Price 1,600] [-All]
# ============================================================
param(
    [string]$Account = '',
    [switch]$All = $false,
    [string]$Price = '',
    [string]$DataFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\accounts-final.json')
)

. "$PSScriptRoot\lib-cbg.ps1"          # 公共库: 榜单解析/战法映射/版本校验
Initialize-RankTeams                   # 解析榜单到 $script:Teams

$data = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
$targets = @()
if ($All) { $targets = @($data) }
elseif ($Account) { $targets = @($data | Where-Object { $_.list.server -eq $Account -and ($Price -eq '' -or $_.overview.price -eq $Price) }) }
if ($targets.Count -eq 0) { Write-Error '未找到目标账号'; exit 1 }

$seenAcc = @{}
foreach ($acc in $targets) {
    if (-not $acc.overview) { continue }
    $k = "$($acc.list.server)-$($acc.overview.price)"
    if ($seenAcc[$k]) { continue }
    $seenAcc[$k] = $true
    $listSrv = $acc.list.server; $price = $acc.overview.price
    $heroMarks = Get-HeroMarksMap $acc.heroes
    $accTac = @{}; foreach ($t in $acc.tactics) { $accTac[$t] = $true }
    $accEq = @{}; foreach ($e in $acc.equips) { $accEq[$e] = $true }
    # 可组榜单队伍
    $cand = @()
    foreach ($team in $script:Teams) {
        if ($team.Heroes -contains '弓诸葛' -or $team.Heroes -contains '司马懿') { continue }
        $st = Get-TeamLandStatus $team $heroMarks $accTac $accEq
        if (-not $st) { continue }
        $tierScore = switch ($team.Tier) { 'T0+' { 8 } 'T0' { 7 } 'T0-' { 5 } 'T1' { 3 } 'T2-' { 1 } default { 0 } }
        if ($st.TMissCount -eq 0 -and $st.EMissCount -eq 0) { $land = 3 }
        elseif ($st.TMissCount -eq 0) { $land = 2 }
        elseif ($st.EMissCount -eq 0) { $land = 1 }
        else { $land = 0 }
        $cand += [pscustomobject]@{ Team=$team.Team; Tier=$team.Tier; Heroes=@($team.Heroes); Score=$tierScore+$land; TMiss=$st.TMiss; EMiss=$st.EMiss }
    }
    # ---- 枚举所有组合, 找最高分(自动从5支退化到能组的最大数量) ----
    $best = $null; $bestScore = -1; $combos = 0
    $n = $cand.Count
    if ($n -ge 1) {
        for ($k2 = [Math]::Min(5, $n); $k2 -ge 1; $k2--) {
            $script:kNow = $k2
            $chosen = New-Object System.Collections.ArrayList
            function Try-Combinations($start, $depth) {
                if ($depth -eq $script:kNow) {
                    $script:combos++
                    $used = @{}; $conflict = $false; $sc = 0
                    foreach ($ci in $chosen) {
                        $c2 = $cand[$ci]
                        foreach ($h in $c2.Heroes) { if ($used[$h]) { $conflict = $true; break } }
                        if ($conflict) { break }
                        foreach ($h in $c2.Heroes) { $used[$h] = $true }
                        $sc += $c2.Score
                    }
                    if (-not $conflict -and $sc -gt $script:bestScore) {
                        $script:bestScore = $sc
                        $script:best = @($chosen | ForEach-Object { $cand[$_] })
                    }
                    return
                }
                for ($i = $start; $i -lt $n; $i++) {
                    [void]$chosen.Add($i)
                    Try-Combinations ($i+1) ($depth+1)
                    $chosen.RemoveAt($chosen.Count-1)
                }
            }
            Try-Combinations 0 0
            if ($script:bestScore -ge 0) { break }
        }
        $best = $script:best; $bestScore = $script:bestScore; $combos = $script:combos
    }
    "`n########## $listSrv ¥$price ##########"
    "URL: $($acc.overview.url -replace '\?.*$','')"
    "可组榜单队伍: $n 支 | 枚举组合: $combos 个 | 最优评分: $bestScore"
    if ($best) {
        $i = 0
        foreach ($b in $best) {
            $i++
            $st = if ($b.TMiss -eq '' -and $b.EMiss -eq '') { '[完整]' }
                  elseif ($b.TMiss -eq '') { "[只缺宝:$($b.EMiss)]" }
                  elseif ($b.EMiss -eq '') { "[缺战法:$($b.TMiss) 宝齐]" }
                  else { "[缺战法:$($b.TMiss) 宝:$($b.EMiss)]" }
            "{0}. {1}({2}) {3} — 武将: {4}" -f $i, $b.Team, $b.Tier, $st, ($b.Heroes -join '、')
        }
    } else { "  (无可组队伍)" }
    $script:best = $null; $script:bestScore = -1; $script:combos = 0
}
