"""Download 1-minute klines for a gold token from Binance's public data mirror into a parquet-free CSV."""
import csv, json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://data-api.binance.vision/api/v3/klines"

def chunk(symbol, start_ms):
    url = f"{BASE}?symbol={symbol}&interval=1m&startTime={start_ms}&limit=1000"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError(url)

def main(symbol, start, end, out):
    t0 = int(time.mktime(time.strptime(start, "%Y-%m-%d"))) * 1000
    t1 = int(time.mktime(time.strptime(end, "%Y-%m-%d"))) * 1000
    starts = list(range(t0, t1, 1000 * 60_000))
    rows = {}
    with ThreadPoolExecutor(8) as ex:
        for res in ex.map(lambda s: chunk(symbol, s), starts):
            for k in res:
                if k[0] < t1:
                    rows[k[0]] = k[1:6]
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "o", "h", "l", "c", "v"])
        for t in sorted(rows):
            w.writerow([t] + rows[t])
    print(symbol, len(rows), "bars")

if __name__ == "__main__":
    main(*sys.argv[1:5])
