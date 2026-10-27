import ssl
import socket
import re

items = [
    ("298038770877", "Rear QTR Panel ($269.99)"),
    ("286788710485", "Rear QTR Panel ($148)"),
    ("296772916455", "Rear QTR Panel ($349.99)"),
    ("226286589287", "Same color paint Rear QTR Panel ($649.99)"),
    ("366746177366", "Diff Cooler w/ lines ($249)"),
    ("198244940137", "Diff Cooler w/o lines ($134.99)"),
    ("137489461172", "Rear spring ($189.99)"),
    ("277504534099", "Rear Signal/Marker Lamp ($39.99)"),
    ("298731857428", "Rear bumper energy absorber ($99.99)"),
    ("147399905848", "Upper + Lower control arms w/ toe bar ($399.99)"),
    ("137456508539", "Upper + Lower control arms w/ toe bar ($379.99)"),
    ("147645964253", "Rear toe bar ($99.99)"),
    ("267792665968", "Rear toe bar ($70)"),
    ("800346436058", "Rear toe bar ($59.99)"),
    ("306598305708", "rear right upper control arm ($71.09)"),
    ("128084675074", "rear right upper control arm ($89)"),
    ("128084676525", "rear right lower control arm ($149)")
]

def fetch_ebay(item_id):
    ctx = ssl.create_default_context()
    s = ctx.wrap_socket(socket.socket(), server_hostname='www.ebay.com')
    s.connect(('www.ebay.com', 443))
    
    headers = [
        f"GET /itm/{item_id} HTTP/1.1",
        "Host: www.ebay.com",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language: en-US,en;q=0.9",
        "Sec-Ch-Ua: \"Google Chrome\";v=\"129\", \"Not=A?Brand\";v=\"8\", \"Chromium\";v=\"129\"",
        "Sec-Ch-Ua-Mobile: ?0",
        "Sec-Ch-Ua-Platform: \"Windows\"",
        "Sec-Fetch-Dest: document",
        "Sec-Fetch-Mode: navigate",
        "Sec-Fetch-Site: none",
        "Sec-Fetch-User: ?1",
        "Upgrade-Insecure-Requests: 1",
        "Connection: close",
        "",
        ""
    ]
    raw_req = "\r\n".join(headers).encode('utf-8')
    s.sendall(raw_req)
    
    resp = b""
    while True:
        chunk = s.recv(8192)
        if not chunk:
            break
        resp += chunk
    s.close()
    
    _, _, body = resp.partition(b"\r\n\r\n")
    return body.decode('utf-8', errors='ignore')

for item_id, name in items[:3]:
    html = fetch_ebay(item_id)
    title_m = re.search(r'<title>(.*?)</title>', html, re.I)
    title = title_m.group(1).replace(" | eBay", "").strip() if title_m else "N/A"
    seller_m = re.search(r'"seller":\{"username":"([^"]+)"', html)
    if not seller_m:
        seller_m = re.search(r'seller-persona.*?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)</span>', html, re.DOTALL)
    seller = seller_m.group(1).strip() if seller_m else "Unknown"
    print(f"{item_id} | {seller} | {title[:50]} | {name}")
