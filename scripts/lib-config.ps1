# ============================================================
# lib-config.ps1 — 策略配置单源（PowerShell 侧）
#
# 与 scripts/lib-config.js 读同一份 data/strategy-config.json。
# 用法： . "$PSScriptRoot\lib-config.ps1"; $l2 = Get-StzbL2
# 注意：本文件必须带 UTF-8 BOM（Windows PowerShell 5.1 中文兼容）。
# ============================================================
$script:StzbRoot = Split-Path -Parent $PSScriptRoot
$script:StzbConfigCache = $null
$script:StzbConfigCachePath = $null

function Get-StzbConfigPath {
    param([string]$Path)
    if ($Path) { return (Resolve-Path -LiteralPath $Path).Path }
    if ($env:STZB_CONFIG) { return $env:STZB_CONFIG }
    return (Join-Path $script:StzbRoot 'data\strategy-config.json')
}

function Get-StzbConfig {
    param([string]$Path, [switch]$NoCache)
    $file = Get-StzbConfigPath -Path $Path
    if (-not (Test-Path -LiteralPath $file)) {
        throw "[config] 找不到策略配置：$file（期望 data/strategy-config.json）"
    }
    if ((-not $NoCache) -and $script:StzbConfigCache -and $script:StzbConfigCachePath -eq $file) {
        return $script:StzbConfigCache
    }
    $cfg = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $cfg.l2_list_filter) { throw '[config] 缺少 l2_list_filter 段' }
    if (-not $cfg.l3_scoring -or -not $cfg.l3_scoring.tierWeight) { throw '[config] 缺少 l3_scoring.tierWeight' }
    $script:StzbConfigCache = $cfg
    $script:StzbConfigCachePath = $file
    return $cfg
}

function Get-StzbL0 { param([string]$Path) return (Get-StzbConfig -Path $Path).l0_data }
function Get-StzbL1 { param([string]$Path) return (Get-StzbConfig -Path $Path).l1_pool }
function Get-StzbL2 { param([string]$Path) return (Get-StzbConfig -Path $Path).l2_list_filter }
function Get-StzbL3 { param([string]$Path) return (Get-StzbConfig -Path $Path).l3_scoring }
function Get-StzbL4 { param([string]$Path) return (Get-StzbConfig -Path $Path).l4_manual_check }

function Get-StzbTierWeight {
    param([string]$Path)
    $tw = (Get-StzbL3 -Path $Path).tierWeight
    if (-not $tw) { throw '[config] l3_scoring.tierWeight 为空' }
    return $tw
}

function Get-StzbPrefilterWeights {
    param([string]$Path, [switch]$NoForged)
    $pf = (Get-StzbL2 -Path $Path).prefilter
    if (-not $pf) { throw '[config] l2_list_filter.prefilter 缺失' }
    if ($NoForged) { $w = $pf.weightsNoForged } else { $w = $pf.weights }
    if (-not $w) { throw '[config] l2_list_filter.prefilter 权重缺失' }
    return $w
}

function Get-StzbConfigFingerprint {
    param([string]$Path)
    $file = Get-StzbConfigPath -Path $Path
    if (-not (Test-Path -LiteralPath $file)) { throw "[config] 找不到策略配置：$file" }
    $hash = Get-FileHash -LiteralPath $file -Algorithm SHA1
    return $hash.Hash.Substring(0, 8).ToLowerInvariant()
}

function Format-StzbEffective {
    param([string]$Path)
    $l2 = Get-StzbL2 -Path $Path
    $tw = Get-StzbTierWeight -Path $Path
    $twText = ($tw.PSObject.Properties | ForEach-Object { "$($_.Name)$($_.Value)" }) -join '/'
    return ("五星>={0} | S战法>={1} | 锻造>={2} | 稀世>={3} | 详情预算{4} | tier权重 {5} | config {6}" -f $l2.fiveStarMin, $l2.sTacticMin, $l2.forgedGearMin, $l2.rareEquipMin, $l2.detailBudget, $twText, (Get-StzbConfigFingerprint -Path $Path))
}

function Write-StzbEffective {
    param([string]$Path, [string]$Prefix = '[config]')
    Write-Host "$Prefix 生效参数：$(Format-StzbEffective -Path $Path)"
}

# 状态文本归一化：onSale / publicity / sold / delisted / other / unknown
function Get-StzbStatusKind {
    param([string]$Text, [string]$Path)
    $labels = (Get-StzbL0 -Path $Path).statusLabels
    if ([string]::IsNullOrWhiteSpace($Text)) { return 'unknown' }
    foreach ($prop in $labels.PSObject.Properties) {
        foreach ($label in $prop.Value) {
            if ($Text.Contains([string]$label)) { return $prop.Name }
        }
    }
    return 'other'
}
