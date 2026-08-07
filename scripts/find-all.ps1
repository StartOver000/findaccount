# ============================================================
# find-all.ps1 — 一键找号全流程(API直采主链路, 几分钟)
# 流程:
#   1. api-collect.js    API直采列表+详情(desc初筛, 断点续采, 浏览器补漏)
#   2. merge-api.js      合并(quality=5过滤+静态表+hero_id特判)
#   3. report.ps1        分析排名+逐队落地+5队规划(node高速版) → 找号报告
# 用法:
#   powershell -File scripts/find-all.ps1                     # 全流程(默认1500-2500)
#   powershell -File scripts/find-all.ps1 -SkipCollect        # 跳过采集(用已有API数据)
#   powershell -File scripts/find-all.ps1 -PriceMin 150000 -PriceMax 200000 -Customer 自用
#   powershell -File scripts/find-all.ps1 -SkipCollect        # 复用已有数据仅重分析
# ============================================================
param(
    [switch]$SkipCollect = $false,          # 跳过API采集(复用 data/accounts-api.json)
    [string]$PriceMin = '150000',           # 价格下限(分)
    [string]$PriceMax = '250000',           # 价格上限(分)
    [string]$Customer = '自用',              # 客户名(报告文件名)
    [string]$BrowserFile = ''               # 浏览器detail文件(存在则只补浏览器漏的号)
)
$root = Split-Path $PSScriptRoot -Parent
$browserArg = ''
if ($BrowserFile) { $browserArg = " `"$BrowserFile`"" }
elseif (Test-Path (Join-Path $root 'data\accounts-detail-1500-2500.json')) { $browserArg = " `"$(Join-Path $root 'data\accounts-detail-1500-2500.json')`"" }

Write-Host '===== 1/3 API直采 ====='
if ($SkipCollect) {
    Write-Host '  (跳过采集, 复用已有 data/accounts-api.json)'
} else {
    node "$PSScriptRoot\api-collect.js" (Join-Path $root 'data\accounts-api.json') $PriceMin $PriceMax $browserArg
    if ($LASTEXITCODE -ne 0) { Write-Error 'API采集失败'; exit 1 }
}

Write-Host '===== 2/3 数据合并 ====='
node "$PSScriptRoot\merge-api.js"
if ($LASTEXITCODE -ne 0) { Write-Error '合并失败'; exit 1 }

Write-Host '===== 3/3 分析+报告 ====='
powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\report.ps1" -Customer $Customer -DataFile (Join-Path $root 'data\accounts-final.json')

Write-Host ''
Write-Host "完成: docs\找号报告-$Customer-$(Get-Date -Format 'yyyyMMdd').md"
