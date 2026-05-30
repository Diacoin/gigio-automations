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

# ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
LOG_CHUNK      = 2000   # blocchi per richiesta eth_getLogs (limite nodi pubblici)


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
# eth_getLogs — nessuna API key, usa i nodi RPC pubblici
# ---------------------------------------------------------------------------

def get_block_timestamp(block_hex):
    """Restituisce il timestamp unix di un blocco."""
    result = rpc("eth_getBlockByNumber", [block_hex, False])
    if result and isinstance(result, dict):
        return int(result.get("timestamp", "0x0"), 16)
    return 0

def get_transfers(from_block, to_block):
    """Restituisce le transazioni in entrata USDT0 in [from_block+1, to_block]."""
    # Wallet address paddato a 32 byte per il topic
    wallet_topic = "0x" + "0" * 24 + WALLET[2:].lower()

    results   = []
    block_ts  = {}   # cache timestamp per blocco

    # Suddivide in chunk per rispettare i limiti dei nodi pubblici
    start = from_block + 1
    while start <= to_block:
        end = min(start + LOG_CHUNK - 1, to_block)

        logs = rpc("eth_getLogs", [{
            "address":   USDT0,
            "fromBlock": hex(start),
            "toBlock":   hex(end),
            "topics":    [TRANSFER_TOPIC, None, wallet_topic],
        }])

        if logs and isinstance(logs, list):
            for log in logs:
                try:
                    blk      = int(log["blockNumber"], 16)
                    amount   = int(log["data"], 16)
                    from_raw = log["topics"][1]
                    from_addr = "0x" + from_raw[-40:]
                    tx_hash  = log["transactionHash"]
                except Exception as e:
                    print(f"[logs] errore parsing log: {e}")
                    continue

                # Recupera timestamp del blocco (con cache)
                if blk not in block_ts:
                    block_ts[blk] = get_block_timestamp(hex(blk))

                results.append({
                    "block":  blk,
                    "ts":     block_ts[blk],
                    "hash":   tx_hash,
                    "from":   from_addr,
                    "value":  str(amount),
                    "dec":    "6",
                    "symbol": "USDT0",
                })
        elif logs is None:
            print(f"[logs] nessuna risposta dal nodo per blocchi {start}-{end}")

        start = end + 1

    results.sort(key=lambda x: x["block"])
    print(f"[logs] trovate {len(results)} TX in entrata dal blocco {from_block + 1}")
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
    txs = get_transfers(last_block, blk)
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
