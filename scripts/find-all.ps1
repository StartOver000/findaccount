# ============================================================
# find-all.ps1 — 一键找号全流程(API直采主链路, 全量+慢速防限流)
# 流程:
#   1. api-collect.js    API直采列表+详情(全量, 慢速3-4秒/号, 登录失效会停下提醒)
#   2. merge-api.js      合并(quality=5过滤+静态表+hero_id特判)
#   3. report.ps1        分析排名+逐队落地+5队规划(node高速版) → 找号报告
#   4. (可选) browser-verify.js 对最终推荐号浏览器复核
# 用法:
#   powershell -File scripts/find-all.ps1                     # 全流程(默认1500-2500全量)
#   powershell -File scripts/find-all.ps1 -SkipCollect        # 跳过采集(用已有API数据)
#   powershell -File scripts/find-all.ps1 -PriceMin 150000 -PriceMax 200000 -Customer 客户名
#   powershell -File scripts/find-all.ps1 -BrowserFile xxx    # 补漏模式(只采浏览器漏的)
# 注意:
#   - 登录/验证失效时 api-collect 会停下等你在浏览器窗口处理, 完成后按回车继续
#   - 全量采集约 10-15 分钟(140号×3-4秒), 慢速防限流, 不要中途并发其他请求
# ============================================================
param(
    [switch]$SkipCollect = $false,          # 跳过API采集(复用 data/accounts-api.json)
    [string]$PriceMin = '150000',           # 价格下限(分)
    [string]$PriceMax = '250000',           # 价格上限(分)
    [string]$Customer = '自用',              # 客户名(报告文件名)
    [string]$BrowserFile = '',              # 浏览器detail文件(存在则只补浏览器漏的号)
    [switch]$SkipReport = $false            # 跳过报告生成(仅采集+合并)
)
$root = Split-Path $PSScriptRoot -Parent
$browserArg = ''
if ($BrowserFile) { $browserArg = " `"$BrowserFile`"" }
elseif (Test-Path (Join-Path $root 'data\accounts-detail-1500-2500.json')) { $browserArg = " `"$(Join-Path $root 'data\accounts-detail-1500-2500.json')`"" }

Write-Host '===== 1/4 API直采 ====='
if ($SkipCollect) {
    Write-Host '  (跳过采集, 复用已有 data/accounts-api.json)'
} else {
    node "$PSScriptRoot\api-collect.js" (Join-Path $root 'data\accounts-api.json') $PriceMin $PriceMax $browserArg
    if ($LASTEXITCODE -ne 0) { Write-Error 'API采集失败'; exit 1 }
}

Write-Host '===== 2/4 数据合并 ====='
node "$PSScriptRoot\merge-api.js"
if ($LASTEXITCODE -ne 0) { Write-Error '合并失败'; exit 1 }

if ($SkipReport) { Write-Host '跳过报告生成'; exit 0 }

Write-Host '===== 3/4 分析+报告 ====='
powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\report.ps1" -Customer $Customer -DataFile (Join-Path $root 'data\accounts-final.json')

Write-Host '===== 4/4 自动生成最终购买建议 ====='
node "$PSScriptRoot\recommend.js" (Join-Path $root 'data\accounts-final.json')

Write-Host ''
Write-Host "完成: docs\找号报告-$Customer-$(Get-Date -Format 'yyyyMMdd').md + 最终购买建议-$(Get-Date -Format 'yyyyMMdd')-自动.md"
