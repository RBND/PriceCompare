import urllib.request
import re
import time

items = [
    ("298038770877", "Rear QTR Panel ($269.99 + $120)"),
    ("286788710485", "Rear QTR Panel ($148 + $150)"),
    ("296772916455", "Rear QTR Panel ($349.99 + $0)"),
    ("226286589287", "Same color paint Rear QTR Panel ($649.99)"),
    ("366746177366", "Diff Cooler w/ lines ($249)"),
    ("198244940137", "Diff Cooler w/o lines ($134.99)"),
    ("137489461172", "Rear spring ($189.99)"),
    ("277504534099", "Rear Signal/Marker Lamp ($39.99)"),
    ("298731857428", "Rear bumper energy absorber ($99.99 + $19.99)"),
    ("147399905848", "Upper + Lower control arms w/ toe bar ($399.99)"),
    ("137456508539", "Upper + Lower control arms w/ toe bar ($379.99)"),
    ("147645964253", "Rear toe bar ($99.99)"),
    ("267792665968", "Rear toe bar ($70 + $10)"),
    ("800346436058", "Rear toe bar ($59.99)"),
    ("306598305708", "rear right upper control arm ($71.09)"),
    ("128084675074", "rear right upper control arm ($89)"),
    ("128084676525", "rear right lower control arm ($149)")
]

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

for item_id, label in items:
    url = f"https://www.ebay.com/itm/{item_id}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            html = response.read().decode('utf-8', errors='ignore')
            
            # Find seller username
            seller = None
            m = re.search(r'"seller":\{"username":"([^"]+)"', html)
            if m:
                seller = m.group(1)
            else:
                m2 = re.search(r'seller-persona[^>]*>.*?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)</span>', html, re.DOTALL)
                if m2:
                    seller = m2.group(1).strip()
                else:
                    m3 = re.search(r'class="mbg-nw">([^<]+)<', html)
                    if m3:
                        seller = m3.group(1).strip()
            
            # Find title
            title_m = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
            title = title_m.group(1).replace(" | eBay", "").strip() if title_m else "N/A"
            
            print(f"{item_id} | SELLER: {seller} | {label} | {title}")
    except Exception as e:
        print(f"{item_id} | ERROR: {e} | {label}")
    time.sleep(0.5)
