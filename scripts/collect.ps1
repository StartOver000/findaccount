# ============================================================
# collect.ps1 — 需求参数化采集: 按问卷参数生成筛选URL并采集, 自动合并到 accounts-final.json
# 用法: powershell -File collect.ps1 [-PriceMin 150000] [-PriceMax 200000] [-FiveStar 85] [-Equip 12] [-Tag 1500-2000]
# 注: 采集时若弹出滑动拼图验证码, 需在浏览器窗口手动通过(脚本会自动等待)
# 阈值默认值全部来自 data/strategy-config.json（经 lib-config.ps1），不在此文件写死:
#   价格档  = l1_pool.priceRange（元 → 分）
#   五星下限 = l2_list_filter.fiveStarMin
#   宝物下限 = l1_pool.bargainLine.forgedGearMin
# 合并去重主键: ordersn（list.ordersn 或 overview.url 末段）；仅旧数据缺 ordersn 时回退 server-price-stars
# ============================================================
param(
    [string]$PriceMin = '',                # 价格下限(分)，空=读配置
    [string]$PriceMax = '',                # 价格上限(分)，空=读配置
    [int]$FiveStar = 0,                    # 五星武将下限，0=读配置
    [int]$Equip = 0,                       # 宝物(锻造)下限，0=读配置
    [string]$Tag = '',                     # 本批标记(文件名用)，空=按价格档生成
    [string]$Servers = ''                  # 区服ID(默认试师白名单)
)

. "$PSScriptRoot\lib-config.ps1"
$root = Split-Path $PSScriptRoot -Parent

$L1 = Get-StzbL1
$L2 = Get-StzbL2
Write-StzbEffective -Prefix '[collect]'

if (-not $PriceMin) { $PriceMin = [string]([int]$L1.priceRange[0] * 100) }
if (-not $PriceMax) { $PriceMax = [string]([int]$L1.priceRange[1] * 100) }
if ($FiveStar -le 0) { $FiveStar = [int]$L2.fiveStarMin }
if ($Equip -le 0) { $Equip = [int]$L1.bargainLine.forgedGearMin }
if (-not $Tag) { $Tag = "$([int]$L1.priceRange[0])-$([int]$L1.priceRange[1])" }

# 试师赛季白名单: 优先读 data/shishi-open.json（scripts/update-shishi.js 生成，随赛季滚动），否则回退旧 65 服
# 说明: 旧 65 服硬编码仅作为离线/文件缺失时的兜底，正常链路必须由 update-shishi.js 维护的 shishi-open.json 说话
if (-not $Servers) {
    $openFile = Join-Path $root 'data\shishi-open.json'
    if (Test-Path $openFile) {
        try {
            $open = Get-Content -LiteralPath $openFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($open.openServerids -and $open.openServerids.Count -gt 0) {
                $Servers = ($open.openServerids -join ',')
                Write-Host "== 试师白名单: data/shishi-open.json ($($open.openServerids.Count) 服, 更新于 $($open.updatedAt)) =="
            }
        } catch { Write-Warning "读取 data/shishi-open.json 失败: $_" }
    }
    if (-not $Servers) {
        $Servers = '44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874'
        Write-Warning '未找到 data/shishi-open.json，使用旧硬编码 65 服（可能已过期，建议先跑 node scripts/update-shishi.js）'
    }
}

$url = "https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=$Servers&price_min=$PriceMin&price_max=$PriceMax&five_star_hero_count=$FiveStar&duanzao_gear_cnt=$Equip"

$batchFile = Join-Path $root "data\accounts-detail-$Tag.json"
$finalFile = Join-Path $root 'data\accounts-final.json'

Write-Host "== 采集批次: $Tag | 价格 ${PriceMin}-${PriceMax} | 五星>=$FiveStar | 宝>=$Equip | config $(Get-StzbConfigFingerprint) =="
Write-Host "输出: $batchFile"

# 1. 采集
node "$PSScriptRoot\cbg-detail-extract.js" $url $batchFile
if ($LASTEXITCODE -ne 0) { Write-Error '采集脚本异常'; exit 1 }

# 2. 合并到 accounts-final.json（ordersn 去重；旧数据缺 ordersn 才回退 server-price-stars）
$all = @()
foreach ($f in @($finalFile, $batchFile)) {
    if (Test-Path $f) {
        try { $all += Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { Write-Warning "读取 $f 失败: $_" }
    }
}
$nowIso = (Get-Date).ToUniversalTime().ToString('o')
$seen = @{}
$out = New-Object System.Collections.ArrayList
$sourceCount = @{}
$statusCount = @{}
foreach ($a in $all) {
    if (-not $a.overview) { continue }
    $srv = if ($a.list -and $a.list.server) { $a.list.server } else { $a.overview.server }
    $ordersn = ''
    if ($a.list -and $a.list.ordersn) { $ordersn = [string]$a.list.ordersn }
    if (-not $ordersn -and $a.overview.url) {
        $tail = ([string]$a.overview.url).Split('?')[0].TrimEnd('/').Split('/')[-1]
        if ($tail -match '^\d{8,}-') { $ordersn = $tail }
    }
    $key = if ($ordersn) { "sn:$ordersn" } else { "sp:$srv-$($a.overview.price)-$($a.overview.stars)" }
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    # 旧数据补数据溯源字段（不覆盖已有值）
    if (-not ($a.PSObject.Properties.Name -contains 'source')) { $a | Add-Member -NotePropertyName source -NotePropertyValue 'browser' }
    if (-not ($a.PSObject.Properties.Name -contains 'capturedAt')) { $a | Add-Member -NotePropertyName capturedAt -NotePropertyValue $nowIso }
    if (-not ($a.PSObject.Properties.Name -contains 'statusKind')) { $a | Add-Member -NotePropertyName statusKind -NotePropertyValue (Get-StzbStatusKind -Text $a.overview.status) }
    # 有 ordersn 但 list 里没有该字段时补上，供下游按 ordersn 去重
    if ($ordersn -and $a.list -and -not ($a.list.PSObject.Properties.Name -contains 'ordersn')) {
        $a.list | Add-Member -NotePropertyName ordersn -NotePropertyValue $ordersn
    }
    $sourceCount[[string]$a.source] = 1 + [int]$sourceCount[[string]$a.source]
    $statusCount[[string]$a.statusKind] = 1 + [int]$statusCount[[string]$a.statusKind]
    [void]$out.Add($a)
}
$out | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $finalFile -Encoding UTF8
$srcText = ($sourceCount.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ' / '
$statusText = ($statusCount.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ' / '
Write-Host "== 合并完成: accounts-final.json 共 $($out.Count) 个号 | 来源分布: $srcText | 状态分布: $statusText =="
Write-Host "下一步: node scripts\report.js（或回退 powershell -File scripts\report.ps1）"
