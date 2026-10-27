$items = @(
    @{ id = "298038770877"; name = "Rear QTR Panel ($269.99)" },
    @{ id = "286788710485"; name = "Rear QTR Panel ($148)" },
    @{ id = "296772916455"; name = "Rear QTR Panel ($349.99)" },
    @{ id = "226286589287"; name = "Same color paint Rear QTR Panel ($649.99)" },
    @{ id = "366746177366"; name = "Diff Cooler w/ lines ($249)" },
    @{ id = "198244940137"; name = "Diff Cooler w/o lines ($134.99)" },
    @{ id = "137489461172"; name = "Rear spring ($189.99)" },
    @{ id = "277504534099"; name = "Rear Signal/Marker Lamp ($39.99)" },
    @{ id = "298731857428"; name = "Rear bumper energy absorber ($99.99)" },
    @{ id = "147399905848"; name = "Upper + Lower control arms w/ toe bar ($399.99)" },
    @{ id = "137456508539"; name = "Upper + Lower control arms w/ toe bar ($379.99)" },
    @{ id = "147645964253"; name = "Rear toe bar ($99.99)" },
    @{ id = "267792665968"; name = "Rear toe bar ($70)" },
    @{ id = "800346436058"; name = "Rear toe bar ($59.99)" },
    @{ id = "306598305708"; name = "rear right upper control arm ($71.09)" },
    @{ id = "128084675074"; name = "rear right upper control arm ($89)" },
    @{ id = "128084676525"; name = "rear right lower control arm ($149)" }
)

foreach ($item in $items) {
    $url = "https://www.ebay.com/itm/$($item.id)"
    try {
        $resp = Invoke-WebRequest -Uri $url -Headers @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" } -UseBasicParsing -TimeoutSec 10
        $html = $resp.Content
        $seller = "Unknown"
        if ($html -match '\"seller\":\{\"username\":\"([^\"]+)\"') {
            $seller = $matches[1]
        } elseif ($html -match 'seller-persona[^>]*>.*?<span[^>]*class=\"[^\"]*ux-textspans--BOLD[^\"]*\"[^>]*>([^<]+)</span>') {
            $seller = $matches[1].Trim()
        } elseif ($html -match 'class=\"mbg-nw\">([^<]+)<') {
            $seller = $matches[1].Trim()
        }
        
        $title = "N/A"
        if ($html -match '<title>(.*?)</title>') {
            $title = $matches[1].Replace(" | eBay", "").Trim()
        }
        Write-Host "$($item.id) | SELLER: $seller | $($item.name) | $title"
    } catch {
        Write-Host "$($item.id) | ERROR: $($_.Exception.Message) | $($item.name)"
    }
    Start-Sleep -Milliseconds 400
}
