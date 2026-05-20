"""
Polygon USDT0 Monitor — GitHub Actions, single-run.

Controlla nuove transazioni in entrata sul wallet e invia
notifiche Telegram per ogni importo >= MIN_AMOUNT USDT0.

Stato persistito in: variabile di repository GitHub POLYGON_LAST_BLOCK
(aggiornata via API a ogni esecuzione riuscita).
"""

import os
import sys
import requests
import urllib3
from datetime import datetime, timezone

urllib3.disable_warnings()

# ---------------------------------------------------------------------------
# Configurazione
# ---------------------------------------------------------------------------

WALLET        = os.environ["WALLET"].lower()
USDT0         = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"
TG_TOKEN      = os.environ["TELEGRAM_TOKEN"]
TG_CHAT_IDS   = [c.strip() for c in os.environ.get("TELEGRAM_CHAT_IDS", "").split(",") if c.strip()]
GH_TOKEN      = os.environ["GH_TOKEN"]
GH_REPO       = os.environ.get("GITHUB_REPOSITORY", "Diacoin/gigio-automations")
MIN_AMOUNT    = 1.0

RPC_NODES = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.meowrpc.com",
    "https://gateway.tenderly.co/public/polygon",
    "https://rpc.tornadoeth.cash/polygon",
]
BLOCKSCOUT = "https://polygon.blockscout.com/api/v2"


# ---------------------------------------------------------------------------
# RPC helpers
# ---------------------------------------------------------------------------

def rpc(method, params):
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    for node in RPC_NODES:
        try:
            r = requests.post(node, json=payload, timeout=10, verify=False)
            data = r.json()
            if "result" in data:
                return data["result"]
        except Exception:
            continue
    return None

def current_block():
    res = rpc("eth_blockNumber", [])
    return int(res, 16) if res else 0

def usdt0_balance():
    data = "0x70a08231" + "000000000000000000000000" + WALLET[2:].lower()
    res  = rpc("eth_call", [{"to": USDT0, "data": data}, "latest"])
    if res and res not in ("0x", "0x0"):
        return f"{int(res, 16) / 1_000_000:,.2f}"
    return "N/A"


# ---------------------------------------------------------------------------
# BlockScout
# ---------------------------------------------------------------------------

def get_transfers(from_block):
    """Restituisce le transazioni in entrata USDT0 successive a from_block."""
    results = []
    params  = {"token": USDT0, "filter": "to", "type": "ERC-20"}

    while True:
        try:
            r    = requests.get(
                f"{BLOCKSCOUT}/addresses/{WALLET}/token-transfers",
                params=params, timeout=15,
            )
            data = r.json()
        except Exception as e:
            print(f"[blockscout] errore: {e}")
            break

        stop = False
        for item in data.get("items", []):
            blk = int(item.get("block_number", 0))
            if blk <= from_block:
                # Raggiunto un blocco già visto — ferma la paginazione
                stop = True
                break
            try:
                ts = int(datetime.fromisoformat(
                    item.get("timestamp", "").replace("Z", "+00:00")).timestamp())
            except Exception:
                ts = 0
            total = item.get("total", {})
            results.append({
                "block":  blk,
                "ts":     ts,
                "hash":   item.get("transaction_hash", ""),
                "from":   item.get("from", {}).get("hash", ""),
                "value":  total.get("value", "0"),
                "dec":    total.get("decimals", "6"),
                "symbol": item.get("token", {}).get("symbol", "USDT0"),
            })

        if stop or not data.get("next_page_params"):
            break
        params = {**params, **data["next_page_params"]}

    # Ordina per blocco crescente (dal più vecchio al più recente)
    results.sort(key=lambda x: x["block"])
    return results

def fmt(value, dec):
    try:
        return f"{int(value) / (10 ** int(dec)):,.2f}"
    except Exception:
        return str(value)


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------

def notify(msg):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    for cid in TG_CHAT_IDS:
        try:
            r = requests.post(url, json={"chat_id": cid, "text": msg}, timeout=10)
            print(f"[telegram] chat {cid}: HTTP {r.status_code}")
        except Exception as e:
            print(f"[telegram] errore {cid}: {e}")


# ---------------------------------------------------------------------------
# GitHub Variables API — persistenza LAST_BLOCK
# ---------------------------------------------------------------------------

GH_HEADERS = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

def get_last_block():
    """Legge POLYGON_LAST_BLOCK dalla variabile del repository GitHub."""
    url = f"https://api.github.com/repos/{GH_REPO}/actions/variables/POLYGON_LAST_BLOCK"
    try:
        r = requests.get(url, headers=GH_HEADERS, timeout=10)
        if r.status_code == 200:
            val = r.json().get("value", "0")
            return int(val)
        if r.status_code == 404:
            print("[gh] variabile POLYGON_LAST_BLOCK non trovata — prima esecuzione")
            return 0
        print(f"[gh] errore lettura variabile: HTTP {r.status_code} {r.text}")
    except Exception as e:
        print(f"[gh] errore lettura variabile: {e}")
    return 0

def set_last_block(block):
    """Crea o aggiorna POLYGON_LAST_BLOCK come variabile del repository GitHub."""
    payload = {"name": "POLYGON_LAST_BLOCK", "value": str(block)}

    # Prova PATCH (aggiorna variabile esistente)
    patch_url = f"https://api.github.com/repos/{GH_REPO}/actions/variables/POLYGON_LAST_BLOCK"
    try:
        r = requests.patch(patch_url, headers=GH_HEADERS, json=payload, timeout=10)
        if r.status_code in (200, 204):
            print(f"[gh] POLYGON_LAST_BLOCK aggiornata → {block}")
            return
        if r.status_code == 404:
            # Variabile non esiste ancora — creala con POST
            create_url = f"https://api.github.com/repos/{GH_REPO}/actions/variables"
            r2 = requests.post(create_url, headers=GH_HEADERS, json=payload, timeout=10)
            if r2.status_code in (200, 201):
                print(f"[gh] POLYGON_LAST_BLOCK creata → {block}")
                return
            print(f"[gh] errore creazione variabile: HTTP {r2.status_code} {r2.text}")
        else:
            print(f"[gh] errore aggiornamento variabile: HTTP {r.status_code} {r.text}")
    except Exception as e:
        print(f"[gh] errore aggiornamento variabile: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"[avvio] wallet {WALLET}")

    last_block = get_last_block()
    blk        = current_block()

    if blk == 0:
        print("[errore] impossibile leggere il blocco corrente dalla chain")
        sys.exit(1)

    print(f"[info] last_block={last_block}  current_block={blk}")

    # Prima esecuzione: imposta il punto di partenza senza inviare notifiche
    if last_block == 0:
        print(f"[avvio] prima esecuzione — blocco iniziale impostato a {blk}")
        set_last_block(blk)
        return

    if blk <= last_block:
        print(f"[info] nessun nuovo blocco (last={last_block}, current={blk})")
        set_last_block(blk)   # aggiorna comunque per tenere allineato il cursore
        return

    print(f"[check] blocchi {last_block + 1} → {blk}")
    txs = get_transfers(last_block)
    print(f"[info] trovate {len(txs)} transazioni da processare")

    notified = 0
    for tx in txs:
        amount      = fmt(tx["value"], tx["dec"])
        amount_float = float(amount.replace(",", ""))

        if amount_float < MIN_AMOUNT:
            print(f"[skip] dust {amount} {tx['symbol']}")
            continue

        dt        = datetime.fromtimestamp(tx["ts"], tz=timezone.utc).strftime("%d/%m/%Y %H:%M UTC")
        bal       = usdt0_balance()
        from_addr = tx["from"]
        from_short = f"{from_addr[:10]}...{from_addr[-6:]}" if len(from_addr) > 16 else from_addr

        msg = (
            f"Nuova transazione in entrata!\n\n"
            f"Importo: {amount} {tx['symbol']}\n"
            f"Saldo attuale: {bal} {tx['symbol']}\n"
            f"Data: {dt}\n"
            f"Da: {from_short}\n"
            f"TX: https://polygonscan.com/tx/{tx['hash']}\n"
            f"Blocco: {tx['block']}"
        )
        notify(msg)
        notified += 1
        print(f"[notifica] {amount} {tx['symbol']} — blocco {tx['block']}")

    # Aggiorna il cursore al blocco corrente
    set_last_block(blk)
    print(f"[done] notifiche inviate: {notified} — new last_block: {blk}")


if __name__ == "__main__":
    main()
