# ============================================================
# report.ps1 — 一键生成找号报告(分析排名 + 逐队落地 + 各号最佳5队)
# 用法: powershell -File report.ps1 [-Customer 客户名]
# 输出: docs/找号报告-{客户}-{日期}.md  (可直接交付)
# ============================================================
param(
    [string]$DataFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\accounts-final.json'),
    [string]$Customer = '客户'
)

$root = Split-Path $PSScriptRoot -Parent
$date = Get-Date -Format 'yyyyMMdd'
$tmpDir = Join-Path $root 'data\tmp'
$outReport = Join-Path $root "docs\找号报告-$Customer-$date.md"

Write-Host '== 1/3 账号排名分析 =='
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\analyze-accounts.ps1" -DataFile $DataFile 2>&1 | Out-File (Join-Path $tmpDir 'analyze.txt') -Encoding utf8
Write-Host '== 2/3 逐队落地检查 =='
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\check-teams.ps1" -DataFile $DataFile 2>&1 | Out-File (Join-Path $tmpDir 'checkteams.txt') -Encoding utf8
Write-Host '== 3/3 各号最佳5队规划 =='
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\plan5-v2.ps1" -DataFile $DataFile -All 2>&1 | Out-File (Join-Path $tmpDir 'plan5.txt') -Encoding utf8

# 汇总生成交付报告
$sb = @()
$sb += "# 藏宝阁找号报告 - $Customer - $date"
$sb += ''
$sb += '> 评估框架: 武将70% + 战法15% + 宝物10% + 红度5%; 版本硬校验(曹操=魏/汉荀彧=汉等); 吃红度队伍降权'
$sb += '> 服务器名以列表页标签为准(藏宝阁详情页server不稳定); 购买请以商品链接为准'
$sb += ''
$sb += '---'
$sb += ''
$sb += '## 一、账号综合排名(按武将分)'
$sb += (Get-Content -LiteralPath (Join-Path $tmpDir 'analyze.txt') -Encoding UTF8 | Select-Object -Skip 5) -join "`n"
$sb += ''
$sb += '---'
$sb += ''
$sb += '## 二、逐队落地状态(完整/只缺宝/缺战法)'
$sb += (Get-Content -LiteralPath (Join-Path $tmpDir 'checkteams.txt') -Encoding UTF8) -join "`n"
$sb += ''
$sb += '---'
$sb += ''
$sb += '## 三、各账号最佳5队规划(武将不重复)'
$sb += (Get-Content -LiteralPath (Join-Path $tmpDir 'plan5.txt') -Encoding UTF8) -join "`n"
$sb += ''
$sb += '---'
$sb += ''
$sb += '## 四、购买建议'
$sb += '- 综合最优(武将分+落地): 见第一部分榜首账号'
$sb += '- 武将全优先: 见第三部分可组5队最全的账号'
$sb += '- 只缺宝(补宝最快成型): 见第二部分"只缺宝"队伍最多的账号'
$sb += '- 具体下单前请以商品链接打开核对'

$sb -join "`n" | Set-Content -LiteralPath $outReport -Encoding UTF8
Write-Host ''
Write-Host "✅ 报告已生成: $outReport"
