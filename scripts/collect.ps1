# ============================================================
# collect.ps1 — 需求参数化采集: 按问卷参数生成筛选URL并采集, 自动合并到 accounts-final.json
# 用法: powershell -File collect.ps1 -PriceMin 150000 -PriceMax 200000 -FiveStar 85 -Equip 12
# 注: 采集时若弹出滑动拼图验证码, 需在浏览器窗口手动通过(脚本会自动等待)
# ============================================================
param(
    [string]$PriceMin = '150000',          # 价格下限(分)
    [string]$PriceMax = '200000',          # 价格上限(分)
    [int]$FiveStar = 85,                   # 五星武将下限
    [int]$Equip = 12,                      # 宝物下限
    [string]$Tag = '1500-2000',            # 本批标记(文件名用)
    [string]$Servers = ''                  # 区服ID(默认试师白名单65服)
)

$root = Split-Path $PSScriptRoot -Parent

# 试师赛季白名单 65 服(默认)
if (-not $Servers) {
    $Servers = '44748,44749,44750,44751,44752,44753,44754,44755,44761,44762,44763,44764,44765,44766,44773,44774,44775,44776,44777,44778,44779,44788,44789,44790,44791,44792,44793,44794,44804,44805,44808,44809,44810,44811,44812,44819,44820,44821,44822,44823,44824,44834,44835,44836,44837,44838,44839,44840,44841,44854,44855,44856,44857,44858,44859,44860,44861,44862,44863,44869,44870,44871,44872,44873,44874'
}

$url = "https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and&game_compete_serverid=$Servers&price_min=$PriceMin&price_max=$PriceMax&five_star_hero_count=$FiveStar&duanzao_gear_cnt=$Equip"

$batchFile = Join-Path $root "data\accounts-detail-$Tag.json"
$finalFile = Join-Path $root 'data\accounts-final.json'

Write-Host "== 采集批次: $Tag | 价格 ${PriceMin}-${PriceMax} | 五星≥$FiveStar | 宝≥$Equip =="
Write-Host "输出: $batchFile"

# 1. 采集
node "$PSScriptRoot\cbg-detail-extract.js" $url $batchFile
if ($LASTEXITCODE -ne 0) { Write-Error '采集脚本异常'; exit 1 }

# 2. 合并到 accounts-final.json(list.server 去重)
$all = @()
foreach ($f in @($finalFile, $batchFile)) { if (Test-Path $f) { $all += Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json } }
$seen = @{}; $out = @()
foreach ($a in $all) {
    if (-not $a.overview) { continue }
    $srv = if ($a.list -and $a.list.server) { $a.list.server } else { $a.overview.server }
    $key = "$srv-$($a.overview.price)-$($a.overview.stars)"
    if (-not $seen[$key]) { $seen[$key] = $true; $out += $a }
}
$out | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $finalFile -Encoding UTF8
Write-Host "== 合并完成: accounts-final.json 共 $($out.Count) 个号 =="
Write-Host "下一步: powershell -File scripts\report.ps1"
