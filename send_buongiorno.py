import urllib.request
import json
import os

token = os.environ["BOT_TOKEN"]
chat_id = int(os.environ["CHAT_ID"])

message = (
    "Buongiorno MarcoMan! ☀️

"
    "Sono Gigio, il tuo supervisore tecnico BitsLegacy.

"
    "Priorita di oggi:
"
    "- Controlla aggiornamenti da Nabil e Hamid
"
    "- Verifica alert tecnici sul progetto
"
    "- Segui i task aperti su BitsLegacy Portal

"
    "Buona giornata e buon lavoro! 💪

"
    "— Gigio"
)

payload = json.dumps({"chat_id": chat_id, "text": message}).encode("utf-8")
req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/sendMessage",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST"
)
with urllib.request.urlopen(req) as resp:
    result = json.loads(resp.read().decode())
    print("Messaggio inviato! ID:", result["result"]["message_id"])
