# ============================================================
# find-all.ps1 — 一键找号全流程(API直采主链路, 全量+慢速防限流)
# 流程:
#   1. api-collect.js    API直采列表+详情(全量, 慢速3-4秒/号, 登录失效会停下提醒)
#   2. merge-api.js      合并(quality=5过滤+静态表+hero_id特判; 按 ordersn 去重; 补数据溯源)
#   3. report.js         分析排名+逐队落地+5队规划 → 找号报告(不存在时回退旧 report.ps1 并告警)
#   4. recommend.js      自动生成最终购买建议
#   另外: 合并前自动备份上一版 data/accounts-final.json，合并后跑 snapshot-diff 输出本次变化
#         （新上架/降价/下架/状态变化 → data/tmp/snapshot-diff/），失败只告警不中断。
# 用法:
#   powershell -File scripts/find-all.ps1                     # 全流程(价格档默认读配置)
#   powershell -File scripts/find-all.ps1 -SkipCollect        # 跳过采集(用已有API数据)
#   powershell -File scripts/find-all.ps1 -PriceMin 150000 -PriceMax 200000 -Customer 客户名
#   powershell -File scripts/find-all.ps1 -BrowserFile xxx    # 显式补漏模式(只采浏览器漏的号)
# 注意:
#   - 登录/验证失效时 api-collect 会停下等你在浏览器窗口处理, 完成后按回车继续
#     （等待超时由 STZB_LOGIN_WAIT_MS 控制, 默认 120000ms=120 秒）
#   - 价格档默认读 data/strategy-config.json 的 l1_pool.priceRange（元→分）
#   - 浏览器 detail 文件不再自动混入；需要时显式 -BrowserFile 指定。过期文件会告警但仍按指定合并。
# ============================================================
param(
    [switch]$SkipCollect = $false,          # 跳过API采集(复用 data/accounts-api.json)
    [string]$PriceMin = '',                 # 价格下限(分)，空=读配置
    [string]$PriceMax = '',                 # 价格上限(分)，空=读配置
    [string]$Customer = '自用',              # 客户名(报告文件名)
    [string]$BrowserFile = '',              # 浏览器detail文件(显式指定; 空=不合并浏览器文件)
    [switch]$SkipReport = $false            # 跳过报告生成(仅采集+合并)
)

. "$PSScriptRoot\lib-config.ps1"

$root = Split-Path $PSScriptRoot -Parent
$L1 = Get-StzbL1
$L0 = Get-StzbL0
Write-StzbEffective -Prefix '[find-all]'

if (-not $PriceMin) { $PriceMin = [string]([int]$L1.priceRange[0] * 100) }
if (-not $PriceMax) { $PriceMax = [string]([int]$L1.priceRange[1] * 100) }
Write-Host "== 价格档: ${PriceMin}-${PriceMax}(分) | 客户: $Customer | 浏览器文件: $(if ($BrowserFile) { $BrowserFile } else { '(不合并)' }) =="

# 浏览器 detail 文件: 只接受显式 -BrowserFile，不再自动混入 data/accounts-detail-*.json（旧文件）
$browserPath = ''
if ($BrowserFile) {
    if (-not (Test-Path -LiteralPath $BrowserFile)) {
        Write-Error "指定的浏览器文件不存在: $BrowserFile"
        exit 1
    }
    $browserPath = (Resolve-Path -LiteralPath $BrowserFile).Path
    $mtime = (Get-Item -LiteralPath $browserPath).LastWriteTime
    $ageDays = [math]::Round(((Get-Date) - $mtime).TotalDays, 1)
    $maxStaleDays = [int]$L0.maxStaleDays
    if ($ageDays -gt $maxStaleDays) {
        Write-Warning "浏览器文件已过期: $browserPath（最后修改 $($mtime.ToString('yyyy-MM-dd HH:mm')), ${ageDays} 天前 > maxStaleDays=$maxStaleDays）。按显式指定继续合并，capturedAt 会如实标注旧快照时间。"
    }
    Write-Host "== 浏览器文件: $browserPath（$ageDays 天前）"
}

$apiOut = Join-Path $root 'data\accounts-api.json'
$finalOut = Join-Path $root 'data\accounts-final.json'
$backupDir = Join-Path $root 'data\backups'

Write-Host '===== 1/4 API直采 ====='
if ($SkipCollect) {
    Write-Host '  (跳过采集, 复用已有 data/accounts-api.json)'
} else {
    # 先刷新试师白名单（data/shishi-open.json 随赛季滚动），保证采到当前开放的试师服
    node "$PSScriptRoot\update-shishi.js" --quiet
    if ($LASTEXITCODE -ne 0) { Write-Warning '试师白名单刷新失败，将使用现有 data/shishi-open.json 继续（可先手动 npm run shishi）' }
    $collectArgs = @("$PSScriptRoot\api-collect.js", $apiOut, $PriceMin, $PriceMax)
    if ($browserPath) { $collectArgs += $browserPath }
    node @collectArgs
    if ($LASTEXITCODE -ne 0) { Write-Error 'API采集失败'; exit 1 }
}

Write-Host '===== 2/4 数据合并 ====='
# 合并前备份上一版最终数据：本次跑完后用 snapshot-diff 输出「新上架/降价/下架/状态变化」，
# 便于月度复查时快速发现价格变化（data/backups 已在 .gitignore）
$prevBackup = ''
if (Test-Path -LiteralPath $finalOut) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $prevBackup = Join-Path $backupDir ("accounts-final-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $finalOut -Destination $prevBackup
    Write-Host "  上一版快照已备份: $prevBackup"
}
$mergeArgs = @("$PSScriptRoot\merge-api.js", '--api', $apiOut, '--out', $finalOut)
if ($browserPath) { $mergeArgs += @('--browser', $browserPath) }
node @mergeArgs
if ($LASTEXITCODE -ne 0) { Write-Error '合并失败'; exit 1 }

if ($prevBackup) {
    $diffDir = Join-Path $root 'data\tmp\snapshot-diff'
    New-Item -ItemType Directory -Force -Path $diffDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    node "$PSScriptRoot\snapshot-diff.js" --prev $prevBackup --cur $finalOut --json (Join-Path $diffDir "diff-$stamp.json") --md (Join-Path $diffDir "diff-$stamp.md")
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "快照差异生成失败（不影响主流程）；可手动运行: node scripts/snapshot-diff.js --prev `"$prevBackup`" --cur `"$finalOut`""
    }
}

if ($SkipReport) { Write-Host '跳过报告生成'; exit 0 }

Write-Host '===== 3/4 分析+报告 ====='
$reportJs = Join-Path $PSScriptRoot 'report.js'
if (Test-Path -LiteralPath $reportJs) {
    node $reportJs --customer $Customer
    if ($LASTEXITCODE -ne 0) { Write-Error "报告生成失败 (node scripts/report.js exit $LASTEXITCODE)"; exit 1 }
} else {
    Write-Warning '未找到 scripts/report.js（新报表引擎尚未落地），回退旧版 report.ps1；输出格式与字段可能为旧口径。'
    powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\report.ps1" -Customer $Customer -DataFile $finalOut
    if ($LASTEXITCODE -ne 0) { Write-Error "报告生成失败 (report.ps1 exit $LASTEXITCODE)"; exit 1 }
}

Write-Host '===== 4/4 自动生成最终购买建议 ====='
node "$PSScriptRoot\recommend.js" $finalOut
if ($LASTEXITCODE -ne 0) { Write-Error "购买建议生成失败 (recommend.js exit $LASTEXITCODE)"; exit 1 }

Write-Host ''
Write-Host "完成: docs\找号报告-$Customer-$(Get-Date -Format 'yyyyMMdd').md + 最终购买建议-$(Get-Date -Format 'yyyyMMdd')-自动.md"
