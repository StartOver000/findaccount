# Fetch CBG API data and parse account info
param(
    [string]$OutputFile = "cbg_accounts.json"
)

$serverIds = @(
    44548,44549,44550,44551,44558,44559,44560,44561,44562,44563,
    44552,44553,44554,44555,44556,44557,
    44575,44576,44577,44578,44579,44580,44581,44582,44583,
    44600,44601,44602,44603,44604,44605,44606,
    44619,44620,44621,44622,44623,44624,44625,44626,
    44586,44587,44588,44589,44590,44595,44596,44597,
    44508,44509,44510,44511,44512,44513,
    44524,44525,44526,44527,44528,44529,44530,44531,44532,44533,44534,44535,
    44635,44636,44637,44638,44639,44640,44641,44642,44643,44644,44645,44646,44647,
    44612,44613,44614
)

$baseUrl = "https://stzb.cbg.163.com/cgi/mweb/pl?search_type=role&tfid=f_kingkong&baijia_hero_logic=and&dynamic_icon_hero_id_logic=and"
$priceParams = "&price_min=20000&price_max=200000"
$heroParams = "&card__hero_id=100023,100016"
$orderParams = "&order_by=price ASC"
$serverParam = "&game_compete_serverid=" + ($serverIds -join ',')

$url = $baseUrl + $priceParams + $heroParams + $orderParams + $serverParam

Write-Host "Fetching: $url"
Write-Host "URL length: $($url.Length)"

try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
    $content = $r.Content
    Write-Host "Response length: $($content.Length)"
    
    # Save raw HTML
    $content | Out-File (Join-Path (Split-Path $PSScriptRoot -Parent) 'data\tmp\cbg_page.html') -Encoding utf8
    Write-Host "Raw HTML saved to cbg_page.html"
    
    # Parse account data using regex
    $accounts = @()
    
    # Find all account blocks
    $pattern = '征服赛季(X\d+)\s+([^\n]*?)(?:\(赛季已开启.*?\))?'
    
    # Use simpler approach - extract by lines
    $lines = $content -split '`n'
    $i = 0
    while ($i -lt $lines.Count) {
        $line = $lines[$i]
        if ($line -match '¥(\d+)') {
            $price = [int]$matches[1]
            $server = ""
            $stars = 0
            $tactics = 0
            $treasures = 0
            $collectors = 0
            $limited = 0
            
            # Look ahead for server info
            for ($j = $i; $j -le $i + 10 -and $j -lt $lines.Count; $j++) {
                $look = $lines[$j]
                if ($look -match '征服赛季(X\d+)') { $server = $matches[1] }
                if ($look -match '(\d+)张五星武将卡') { $stars = [int]$matches[1] }
                if ($look -match '(\d+)个S级战法') { $tactics = [int]$matches[1] }
                if ($look -match '(\d+)个稀世宝物') { $treasures = [int]$matches[1] }
                if ($look -match '(\d+)人收藏') { $collectors = [int]$matches[1] }
                if ($look -match '(\d+)个限定武将') { $limited = [int]$matches[1] }
            }
            
            if ($server -ne "") {
                $accounts += [PSCustomObject]@{
                    price = $price
                    server = $server
                    stars = $stars
                    tactics = $tactics
                    treasures = $treasures
                    collectors = $collectors
                    limited = $limited
                }
            }
        }
        $i++
    }
    
    Write-Host "Parsed $($accounts.Count) accounts"
    $accounts | Format-Table price, server, stars, tactics, treasures, collectors, limited -AutoSize
    
    # Save as JSON
    $accounts | ConvertTo-Json | Out-File (Join-Path (Split-Path $PSScriptRoot -Parent) "data\$OutputFile") -Encoding utf8
    Write-Host "Saved to $OutputFile"
    
} catch {
    Write-Host "Error: $_"
    Write-Host "Exception details: $($_.Exception.Message)"
}
