# 找号脚本 v4 — 列表页资产指数初筛（2026-08-07）
# 用法:
#   .\find-accounts-20260807.ps1 -SnapshotFile <列表页快照.txt>
# 输出:
#   - 白名单过滤后的候选,按价格档位分组、按资产指数降序
#   - 错配候选(高资产低价格 = 惊喜号候选)
#   - find-accounts-20260807.json
#
# 依赖:列表页卡片含 ¥价格 / 征服赛季X服 / N张五星武将卡 / N个S级战法 / N个稀世宝物 / N个限定武将

param(
    [Parameter(Mandatory = $true)]
    [string]$SnapshotFile,
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data')
)

$content = Get-Content -LiteralPath $SnapshotFile -Raw -Encoding UTF8

# 试师赛季白名单（2026-08-07 最新）
$ranges = @(
    @(5773, 5791), @(5798, 5804), @(5813, 5819), @(5829, 5830), @(5833, 5837),
    @(5844, 5849), @(5859, 5866), @(5879, 5888), @(5894, 5899)
)

function Is-Whitelisted([int]$n) {
    foreach ($r in $ranges) {
        if ($n -ge $r[0] -and $n -le $r[1]) { return $true }
    }
    return $false
}

# 按价格切分卡片块（每个 ¥ 开头 = 一张卡片）
$blocks = [regex]::Split($content, '(?=¥\d)')

$accounts = @()
foreach ($block in $blocks) {
    if ($block -notmatch '¥([0-9,]+)') { continue }
    $price = [int]($Matches[1] -replace ',', '')
    if ($price -le 0) { continue }

    # 服务器:征服赛季 X 服;备战区直接跳过
    if ($block -match '征服赛季X(\d+)') {
        $server = [int]$Matches[1]
    }
    else {
        continue
    }

    $stars   = if ($block -match '(\d+)张五星武将卡') { [int]$Matches[1] } else { 0 }
    $tactics = if ($block -match '(\d+)个S级战法') { [int]$Matches[1] } else { 0 }
    $equips  = if ($block -match '(\d+)个稀世宝物') { [int]$Matches[1] } else { 0 }
    $limited = if ($block -match '(\d+)个限定武将') { [int]$Matches[1] } else { 0 }

    # 资产指数 = 五星×1 + S战法×2 + 稀世宝物×3 + 限定×2
    $index = $stars * 1 + $tactics * 2 + $equips * 3 + $limited * 2

    # 价格档位
    if ($price -le 800) { $tier = 'A≤800' }
    elseif ($price -le 1200) { $tier = 'B800-1200' }
    elseif ($price -le 1600) { $tier = 'C1200-1600' }
    elseif ($price -le 2000) { $tier = 'D1600-2000' }
    elseif ($price -le 2500) { $tier = 'E2000-2500(观察)' }
    else { $tier = 'F>2500' }

    $accounts += [pscustomobject]@{
        Price = $price; Server = $server
        Stars = $stars; Tactics = $tactics; Equips = $equips; Limited = $limited
        Index = $index; Tier = $tier
    }
}

$valid = $accounts | Where-Object { Is-Whitelisted $_.Server }

Write-Host '=== 列表页候选解析 ==='
Write-Host "白名单内: $($valid.Count) 个 / 全部: $($accounts.Count) 个"
Write-Host ''

foreach ($t in @('A≤800', 'B800-1200', 'C1200-1600', 'D1600-2000', 'E2000-2500(观察)')) {
    $list = $valid | Where-Object Tier -eq $t | Sort-Object Index -Descending
    if ($list.Count -eq 0) { continue }
    Write-Host "--- $t ($($list.Count) 个) 按资产指数降序 ---"
    $list | Select-Object -First 15 | ForEach-Object {
        "¥$($_.Price) | X$($_.Server) | $($_.Stars)★ $($_.Tactics)S $($_.Equips)宝 $($_.Limited)限 | 指数$($_.Index)"
    }
    Write-Host ''
}

Write-Host '=== 错配候选（高资产低价格 = 惊喜号候选）==='
$valid |
    Where-Object { $_.Tier -in @('A≤800', 'B800-1200', 'C1200-1600') } |
    Sort-Object { $_.Index / $_.Price } -Descending |
    Select-Object -First 15 |
    ForEach-Object {
        "¥$($_.Price) | X$($_.Server) | 指数$($_.Index) | 指数/价 $([math]::Round($_.Index * 1000 / $_.Price, 1))"
    }

$valid | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir 'find-accounts-20260807.json') -Encoding UTF8
Write-Host ''
Write-Host '已保存 find-accounts-20260807.json'
