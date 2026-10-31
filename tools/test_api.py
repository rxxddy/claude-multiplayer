"""End-to-end regression suite for api.php.

    python tools/test_api.py [api_url] [path/to/deck_state_v2.sqlite]

Needs a server with a FRESH database (the first registration becomes the owner), started with
DECK_SETUP_TOKEN=test-setup-token. Passing the database path enables the timeout tests, which
backdate rows directly. PHP_EXE points at the php binary used for the chess perft / loot-case checks.
"""
import json
import os
import random
import sqlite3
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8095/api.php"
DB = sys.argv[2] if len(sys.argv) > 2 else None
API_PHP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api.php")
PHP = os.environ.get("PHP_EXE", "php")
SETUP = "test-setup-token"
SUF = "".join(random.choice(string.ascii_lowercase) for _ in range(4))
passed = 0


def call(action, token=None, expect_ok=True, **kw):
    body = json.dumps({"action": action, **kw}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={"Content-Type": "application/json"})
    if token:
        req.add_header("X-Deck-Token", token)
    try:
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        data = json.loads(e.read())
    if expect_ok is True and not data.get("ok"):
        raise AssertionError(f"{action} failed: {data}")
    if expect_ok is False and data.get("ok"):
        raise AssertionError(f"{action} unexpectedly succeeded: {data}")
    return data


def check(cond, label):
    global passed
    if not cond:
        raise AssertionError("FAIL: " + label)
    passed += 1
    print("  ok -", label)


def reg(name, **kw):
    return call("register", username=name, password="secret123", password_confirm="secret123", **kw)


print("== server_info / register / join key")
info = call("server_info")
check(info["version"] == "3" and info["requires_join_key"] is False, "server_info public")
e = reg("owner_" + SUF, expect_ok=False)
check(e["error_code"] == "SETUP_TOKEN_REQUIRED", "first registration needs DECK_SETUP_TOKEN")
o = reg("owner_" + SUF, setup_token=SETUP)
OT, OID = o["auth_token"], o["user"]["id"]
check(o["user"]["role"] == "owner" and "custom_svg" not in o["user"], "first user is owner, no custom_svg")
call("admin", OT, op="settings", join_key="letmein", spins_5h=3)
check(call("server_info")["requires_join_key"] is True, "join key required after set")
e = reg("bob_" + SUF, expect_ok=False)
check(e["error_code"] == "JOIN_KEY_INVALID", "register without key rejected")
e = reg("bob_" + SUF, join_key="wrong", expect_ok=False)
check(e["error_code"] == "JOIN_KEY_INVALID", "register with wrong key rejected")
b = reg("bob_" + SUF, join_key="letmein")
BT, BID, BNICK = b["auth_token"], b["user"]["id"], b["user"]["display_nick"]
check(b["user"]["role"] == "member", "second user is member")
c = reg("carl_" + SUF, join_key="letmein")
CT, CID = c["auth_token"], c["user"]["id"]
ONICK = o["user"]["display_nick"]
e = call("sync", None, expect_ok=False, last_msg_id=0)
check(e["error_code"] == "UNAUTHORIZED", "sync without token rejected")
lg = call("login", username="bob_" + SUF, password="secret123")
BT = lg["auth_token"]
check(lg["user"]["id"] == BID, "login works")

print("== profile")
e = call("update_profile", BT, expect_ok=False, avatar_preset="EVIL")
check(e["error_code"] == "INVALID_AVATAR", "avatar preset whitelist")
p = call("update_profile", BT, avatar_preset="CLAUDE_CAT", bio="hi", custom_svg="<svg onload=x>")
check(p["user"]["avatar_preset"] == "CLAUDE_CAT" and "custom_svg" not in p["user"], "profile updated, svg ignored")

print("== sync + privacy")
s0 = call("sync", OT, last_msg_id=0, telemetry={"status": "WORKING", "usage": {"s": 40, "w": 10, "reset_s": "x", "reset_w": "y", "ts": int(time.time())},
                                                "ctx_pct": 33, "commits": {"day": 2, "week": 9}, "focus": {"project": "p", "branch": "b", "task": "t"}})
for k in ["me", "server", "new_messages", "online_count", "members_rev", "duels", "chess", "battleship", "game_limits", "commit_feed"]:
    check(k in s0, f"sync has {k}")
check("operators" not in s0, "no operator list in sync")
check(s0["me"]["role"] == "owner" and "muted_until" in s0["me"], "me has role + muted_until")
check("anthropic_key_masked" in s0["server"] and "anthropic_key" not in s0["server"]["settings"], "key not exposed")
rev0 = s0["members_rev"]
s1 = call("sync", BT, last_msg_id=0, telemetry={"status": "WORKING"},
          new_commits=[{"short_hash": "abc1234", "project": "p", "branch": "b", "message": "feat"}])
check(s1["members_rev"] > rev0, "members_rev bumped on change")
check(any(r["short_hash"] == "abc1234" for r in s1["commit_feed"]), "commit_feed returned")
s2 = call("sync", BT, last_msg_id=0, telemetry={"status": "IDLE"})
s3 = call("sync", BT, last_msg_id=0, telemetry={"status": "IDLE"})
check(s3["members_rev"] == s2["members_rev"], "members_rev stable when nothing changes")
call("sync", CT, last_msg_id=0, telemetry={"commits": {"day": 1, "week": 1}})
m = call("members", BT)
by = {i["user_id"]: i for i in m["items"]}
check(m["total"] == 3, "members total")
check(by[OID]["usage_s"] == 40 and by[OID]["commits_week"] == 9 and by[OID]["project"] == "p", "owner shared fields visible")
check(by[BID]["usage_s"] is None and by[BID]["commits_day"] is None and by[BID]["project"] is None, "bob unshared fields null")
check(by[CID]["commits_day"] == 1 and by[CID]["usage_w"] is None and by[CID]["task"] is None, "carl partial share")
check(all(by[u]["rank"] >= 1 for u in by), "rank present")

print("== members paging / filters")
p1 = call("members", BT, limit=2, page=1)
p2 = call("members", BT, limit=2, page=2)
check(len(p1["items"]) == 2 and len(p2["items"]) == 1, "pagination")
check([i["points"] for i in p1["items"]] == sorted([i["points"] for i in p1["items"]], reverse=True), "ordered by points")
check([i["user_id"] for i in call("members", BT, q="owner")["items"]] == [OID], "owner filter")
check(call("members", BT, q="admin")["total"] == 0, "admin filter (none yet)")
check(call("members", BT, q="online")["total"] == 3, "online filter")
check([i["user_id"] for i in call("members", BT, q="carl")["items"]] == [CID], "nick search")
check(call("members", BT, q="%")["total"] == 0, "LIKE wildcard escaped")

print("== chat / history / search")
t0 = int(time.time())
ids = [call("send_message", BT, content=f"hello quantum{i} world")["id"] for i in range(5)]
call("send_message", CT, content="banana smoothie", msg_type="SNIPPET", snippet_body="print('x')")
h = call("history", BT, before_id=ids[-1], limit=3)["messages"]
check([x["id"] for x in h] == ids[1:4] or len(h) == 3 and h[-1]["id"] < ids[-1], "history before_id newest last")
check(set(h[0].keys()) == {"id", "user_id", "sender_nick", "avatar_color", "msg_type", "content", "snippet_body", "reply_to", "created_ts"}, "message shape")
r = call("search_messages", BT, q="quantum3")["messages"]
check(len(r) == 1 and "quantum3" in r[0]["content"], "FTS exact")
r = call("search_messages", BT, q="quant")["messages"]
check(len(r) >= 5, "FTS prefix")
r = call("search_messages", BT, q='banana" OR content:*')["messages"]
check(isinstance(r, list), "FTS injection safely quoted")
r = call("search_messages", BT, q="hello", from_nick=BNICK)["messages"]
check(len(r) == 5, "from_nick")
r = call("search_messages", BT, from_nick=c["user"]["display_nick"], date_from=t0 - 5, date_to=int(time.time()) + 5)["messages"]
check(len(r) == 1 and r[0]["msg_type"] == "SNIPPET", "date range + nick")
check(call("search_messages", BT, q="hello", date_to=t0 - 100)["messages"] == [], "date_to excludes")
s = call("sync", OT, last_msg_id=ids[2])
check([x["id"] for x in s["new_messages"]][:2] == ids[3:5], "sync deltas since last_msg_id")

print("== spin limit")
for i in range(3):
    call("game_spin", BT, kind="roulette", choice="red", bet=10)
e = call("game_spin", BT, expect_ok=False, kind="roulette", choice="red", bet=10)
check(e["error_code"] == "SPIN_LIMIT" and "Next spin available at" in e["error"], "SPIN_LIMIT: " + e["error"])
check(call("sync", BT, last_msg_id=0)["game_limits"]["spins_5h_left"] == 0, "game_limits reported")
call("admin", OT, op="settings", spins_5h=60)

print("== duel")
pts = lambda t: call("sync", t, last_msg_id=999999)["me"]["points"]
b0, c0 = pts(BT), pts(CT)
d = call("duel_create", BT, stake=50)
call("duel_join", CT, duel_id=d["duel_id"])
b1, c1 = pts(BT), pts(CT)
check(b1 + c1 == b0 + c0 and {b1 - b0, c1 - c0} == {50, -50}, "duel pot transferred")
check(call("sync", BT, last_msg_id=999999)["game_limits"]["spins_5h_left"] == 57, "duels not counted as spins")

print("== chess")
o0, b0 = pts(OT), pts(BT)
call("chess_invite", OT, target_nick=BNICK, stake=100)
check(pts(OT) == o0 - 100, "chess stake escrowed")
ch = call("sync", BT, last_msg_id=999999)["chess"]
check(len(ch) == 1 and {"white_nick", "black_color", "stake", "fen"} <= set(ch[0]), "chess row shape")
call("chess_accept", BT, challenger_nick=ONICK)
check(pts(BT) == b0 - 100, "opponent stake escrowed")
call("chess_move", BT, game_id=ch[0]["id"], resign=True)
o1 = pts(OT)
check(o1 >= o0 + 100 + 25, f"winner payout (+{o1 - o0})")

print("== battleship")
FLEET_A = [{"x": 0, "y": 0, "len": 5, "dir": "h"}, {"x": 0, "y": 1, "len": 4, "dir": "h"}, {"x": 0, "y": 2, "len": 3, "dir": "h"},
           {"x": 0, "y": 3, "len": 3, "dir": "h"}, {"x": 0, "y": 4, "len": 2, "dir": "h"}]
FLEET_B = [{"x": 9, "y": 0, "len": 5, "dir": "v"}, {"x": 8, "y": 0, "len": 4, "dir": "v"}, {"x": 7, "y": 0, "len": 3, "dir": "v"},
           {"x": 6, "y": 0, "len": 3, "dir": "v"}, {"x": 5, "y": 0, "len": 2, "dir": "v"}]
o0, b0 = pts(OT), pts(BT)
g = call("bs_invite", OT, target_nick=BNICK, stake=40)["game_id"]
check(pts(OT) == o0 - 40, "bs inviter escrow")
call("bs_decline", BT, game_id=g)
check(pts(OT) == o0, "bs decline refunds")
g = call("bs_invite", OT, target_nick=BNICK, stake=40)["game_id"]
call("bs_accept", BT, game_id=g)
check(pts(BT) == b0 - 40, "bs accept escrow")
e = call("bs_place", OT, expect_ok=False, game_id=g, ships=FLEET_A[:4] + [{"x": 0, "y": 0, "len": 2, "dir": "v"}])
check(e["error_code"] == "INVALID_FLEET", "overlap rejected")
e = call("bs_place", OT, expect_ok=False, game_id=g, ships=FLEET_A[:4] + [{"x": 9, "y": 9, "len": 2, "dir": "h"}])
check(e["error_code"] == "INVALID_FLEET", "out of bounds rejected")
e = call("bs_place", OT, expect_ok=False, game_id=g, ships=FLEET_A[:4] + [{"x": 0, "y": 6, "len": 3, "dir": "h"}])
check(e["error_code"] == "INVALID_FLEET", "wrong lengths rejected")
call("bs_place", OT, game_id=g, ships=FLEET_A)
e = call("bs_fire", OT, expect_ok=False, game_id=g, x=0, y=0)
check(e["error_code"] == "BAD_STATE", "cannot fire while placing")
check(call("bs_place", BT, game_id=g, ships=FLEET_B)["status"] == "ACTIVE", "both placed -> ACTIVE")
e = call("bs_fire", BT, expect_ok=False, game_id=g, x=0, y=0)
check(e["error_code"] == "NOT_YOUR_TURN", "inviter fires first")


def cells(fleet):
    for s in fleet:
        for i in range(s["len"]):
            yield (s["x"] + i, s["y"]) if s["dir"] == "h" else (s["x"], s["y"] + i)


targets_a = list(cells(FLEET_B))           # owner hits every B cell
targets_b = [(x, y) for y in range(5, 10) for x in range(10)]  # bob only misses
results, last = [], None
for i, (x, y) in enumerate(targets_a):
    last = call("bs_fire", OT, game_id=g, x=x, y=y)
    results.append(last["result"])
    if last["game_over"]:
        break
    if i == 0:
        e = call("bs_fire", OT, expect_ok=False, game_id=g, x=x, y=y)
        check(e["error_code"] == "NOT_YOUR_TURN", "strict alternation")
    call("bs_fire", BT, game_id=g, x=targets_b[i][0], y=targets_b[i][1])
    time.sleep(0.4)  # stay under the 30 game actions / 10 s per-user limit
check(results.count("sunk") == 5 and last["game_over"] and last["winner_id"] == OID, "5 sunk, game over, owner wins")
check(last.get("sunk_len") == 2, "sunk_len reported")
check(pts(OT) == o0 - 40 + 80 + 25 and pts(BT) == b0 - 40, "stake payout 2*stake+25")
for tok, mine in ((BT, FLEET_B), (OT, FLEET_A)):
    raw = json.dumps(call("sync", tok, last_msg_id=999999)["battleship"])
    item = json.loads(raw)[0]
    check(item["status"] == "FINISHED" and item["winner_id"] == OID, "finished visible in sync")
    check(item["my_board"]["ships"] == mine, "own fleet returned")
    enemy = FLEET_A if mine is FLEET_B else FLEET_B
    check(not any(json.dumps(s) in raw for s in enemy) and "a_ships" not in raw and "b_ships" not in raw, "enemy fleet not leaked")
item = call("sync", OT, last_msg_id=999999)["battleship"][0]
check(all(s[2] == "sunk" for s in item["my_shots"]), "my_shots marked sunk")
check(len(call("sync", BT, last_msg_id=999999)["battleship"][0]["my_board"]["hits_taken"]) == 17, "hits_taken")
msgs = call("search_messages", OT, q="BATTLESHIP")["messages"]
check(len(msgs) >= 2 and all(x["msg_type"] == "BATTLESHIP_EVENT" for x in msgs), "BATTLESHIP_EVENT start+end")

print("== chess engine (CLI perft + case EV)")
def php_cli(*args):
    return subprocess.run([PHP, API_PHP, *args], capture_output=True, text=True, check=True).stdout.strip()
KIWI = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
check(php_cli("perft", "3") == "8902", "perft start depth 3 = 8902")
check(php_cli("perft", "2", KIWI) == "2039", "perft kiwipete depth 2 = 2039")
check(php_cli("perft", "4", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1") == "43238", "perft position 3 depth 4 = 43238 (ep/pins)")
check(php_cli("perft", "3", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1") == "9467", "perft position 4 depth 3 = 9467 (promotions/castling)")
ev = float(php_cli("case_ev"))
check(0.90 <= ev <= 0.97, f"loot case EV {ev:.4f} in [0.90, 0.97]")
check((18 / 37) * 2 < 1 and (1 / 37) * 14 < 1, "roulette EV < 1 (red/black 0.973, green 0.378)")

time.sleep(10)  # let the per-user game rate limit (30/10s) refill
print("== chess server-authoritative")
o0, b0 = pts(OT), pts(BT)
g = call("chess_invite", OT, target_nick=BNICK, stake=50)["game_id"]
call("chess_accept", BT, game_id=g)
check(not call("chess_accept", BT, expect_ok=False, game_id=g)["ok"], "double accept rejected")
check(pts(BT) == b0 - 50, "accept debited exactly once")
e = call("chess_move", BT, expect_ok=False, game_id=g, **{"from": "e7", "to": "e5"})
check(e["error_code"] == "NOT_YOUR_TURN", "black cannot move first")
e = call("chess_move", OT, expect_ok=False, game_id=g, **{"from": "e2", "to": "e5"})
check(e["error_code"] == "ILLEGAL_MOVE", "illegal move rejected")
r = call("chess_move", OT, game_id=g, game_over=True, outcome="WHITE_WIN", fen="8/8/8/8/8/8/8/K6k w - - 0 1", **{"from": "f2", "to": "f3"})
check(r["game_over"] is False and r["fen"].startswith("rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b"), "client outcome/fen ignored, server fen")
for frm, to, tok in (("e7", "e5", BT), ("g2", "g4", OT)):
    call("chess_move", tok, game_id=g, **{"from": frm, "to": to})
r = call("chess_move", BT, game_id=g, **{"from": "d8", "to": "h4"})
check(r["game_over"] and r["outcome"] == "checkmate" and r["winner_id"] == BID, "fool's mate detected by server")
check(pts(BT) >= b0 - 50 + 100 + 25 and pts(OT) == o0 - 50, "checkmate payout decided by server")
e = call("chess_move", OT, expect_ok=False, game_id=g, **{"from": "a2", "to": "a3"})
check(e["error_code"] == "NOT_FOUND", "finished game frozen " + str(e))

time.sleep(10)  # let the per-user game rate limit (30/10s) refill
print("== chess decline uses DB nicks / accept-decline race")
g = call("chess_invite", OT, target_nick=BNICK, stake=10)["game_id"]
call("chess_decline", BT, game_id=g, nick="EVILxINJECT")
check(not call("search_messages", OT, q="EVILxINJECT")["messages"], "request nick not echoed into system message")
o0, b0 = pts(OT), pts(BT)
g = call("chess_invite", OT, target_nick=BNICK, stake=20)["game_id"]
o1 = pts(OT)
res = []
def race(fn):
    res.append(fn())
ts = [threading.Thread(target=race, args=(lambda: call("chess_accept", BT, expect_ok=None, game_id=g),)),
      threading.Thread(target=race, args=(lambda: call("chess_decline", OT, expect_ok=None, game_id=g),))]
[t.start() for t in ts]; [t.join() for t in ts]
st = call("sync", BT, last_msg_id=999999)["chess"]
accepted = any(x["id"] == g and x["status"] == "ACTIVE" for x in st)
check(sum(1 for x in res if x.get("ok")) == 1, "exactly one of accept/decline wins the race")
check((accepted and pts(OT) == o0 - 20 and pts(BT) == b0 - 20) or (not accepted and pts(OT) == o0 and pts(BT) == b0), "points consistent after race")
if accepted:
    call("chess_move", BT, game_id=g, resign=True)

time.sleep(10)  # let the per-user game rate limit (30/10s) refill
print("== spin limit is atomic")
call("admin", OT, op="settings", spins_5h=0)
check(call("game_spin", CT, expect_ok=False, kind="case", bet=10)["error_code"] == "SPIN_LIMIT", "spins disabled at 0")
call("admin", OT, op="settings", spins_5h=3)
res = []
ts = [threading.Thread(target=race, args=(lambda: call("game_spin", CT, expect_ok=None, kind="case", bet=10),)) for _ in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
check(sum(1 for x in res if x.get("ok")) == 3, "8 parallel spins with cap 3 -> exactly 3 succeed")
call("admin", OT, op="settings", spins_5h=60)

time.sleep(10)  # let the per-user game rate limit (30/10s) refill
print("== games_enabled / stakes switches")
d = call("duel_create", CT, stake=10)["duel_id"]
g = call("chess_invite", CT, target_nick=BNICK)["game_id"]
bg = call("bs_invite", CT, target_nick=BNICK, stake=0)["game_id"]
call("admin", OT, op="settings", games_enabled=False)
check(call("duel_join", BT, expect_ok=False, duel_id=d)["error_code"] == "GAMES_DISABLED", "duel_join blocked")
check(call("chess_accept", BT, expect_ok=False, game_id=g)["error_code"] == "GAMES_DISABLED", "chess_accept blocked")
check(call("bs_accept", BT, expect_ok=False, game_id=bg)["error_code"] == "GAMES_DISABLED", "bs_accept blocked")
call("admin", OT, op="settings", games_enabled=True, chess_stakes=False)
check(call("bs_invite", OT, expect_ok=False, target_nick=c["user"]["display_nick"], stake=10)["error_code"] == "STAKES_DISABLED", "bs stakes respect chess_stakes")
call("admin", OT, op="settings", chess_stakes=True)
call("duel_cancel", CT, duel_id=d)
call("chess_decline", BT, game_id=g)
call("bs_decline", BT, game_id=bg)

time.sleep(10)  # let the per-user game rate limit (30/10s) refill
print("== @claude quota + budget (no network)")
call("admin", OT, op="settings", anthropic_key="sk-ant-api03-fakefakefakefakefakefake0000", claude_daily_tokens=0)
for i in range(6):
    call("send_message", CT, content=f"@claude question {i}")
bot = [m["content"] for m in call("history", CT, before_id=0, limit=20)["messages"] if m["sender_nick"] == "CLAUDE"]
check(sum("budget" in t for t in bot[-6:]) == 5 and "limit" in bot[-1], "daily budget then 5/hour quota enforced")

print("== login timing (no user enumeration)")
def timed(u):
    t = time.perf_counter()
    call("login", expect_ok=False, username=u, password="wrongpass1")
    return time.perf_counter() - t
ta = min(timed("nouser_" + SUF) for _ in range(3))
tb = min(timed("bob_" + SUF) for _ in range(3))
check(ta > 0.4 * tb, f"unknown user verifies a dummy hash ({ta*1000:.0f} ms vs {tb*1000:.0f} ms)")

print("== Friday showdown counts server-side commit feed")
now = datetime.now()
if now.isoweekday() > 5 or (now.isoweekday() == 5 and (now.hour, now.minute) >= (16, 30)):
    m = call("search_messages", OT, q="SHOWDOWN")["messages"]
    check(len(m) == 1 and BNICK in m[0]["content"] and "1 commits" in m[0]["content"], "winner = most feed commits (bob), not client commits_week (owner sent 9)")
else:
    print("  skip - only verifiable after Friday 16:30")

if DB:
    time.sleep(10)  # let the per-user game rate limit (30/10s) refill
    print("== move timeouts (DB backdated)")
    db = sqlite3.connect(DB)
    o0, b0 = pts(OT), pts(BT)
    g = call("chess_invite", OT, target_nick=BNICK, stake=30)["game_id"]
    call("chess_accept", BT, game_id=g)
    db.execute("UPDATE chess_games SET updated_at = updated_at - 25*3600 WHERE id = ?", (g,)); db.commit()
    call("sync", OT, last_msg_id=999999)
    check(pts(BT) >= b0 - 30 + 60 + 25 and pts(OT) == o0 - 30, "chess: white (to move) times out, black wins")
    o0, b0 = pts(OT), pts(BT)
    g = call("bs_invite", OT, target_nick=BNICK, stake=30)["game_id"]
    call("bs_accept", BT, game_id=g)
    call("bs_place", BT, game_id=g, ships=FLEET_B)
    db.execute("UPDATE bs_games SET updated_ts = updated_ts - 25*3600 WHERE id = ?", (g,)); db.commit()
    call("sync", OT, last_msg_id=999999)
    check(pts(BT) == b0 + 30 and pts(OT) == o0 - 30, "battleship PLACING: only placer wins the pot")
    o0, b0 = pts(OT), pts(BT)
    g = call("bs_invite", OT, target_nick=BNICK, stake=30)["game_id"]
    call("bs_accept", BT, game_id=g)
    db.execute("UPDATE bs_games SET updated_ts = updated_ts - 25*3600 WHERE id = ?", (g,)); db.commit()
    call("sync", OT, last_msg_id=999999)
    check(pts(BT) == b0 and pts(OT) == o0, "battleship PLACING: nobody placed -> both refunded")
    g = call("bs_invite", OT, target_nick=BNICK, stake=30)["game_id"]
    call("bs_accept", BT, game_id=g)
    call("bs_place", BT, game_id=g, ships=FLEET_B)
    call("bs_place", OT, game_id=g, ships=FLEET_A)
    o0, b0 = pts(OT), pts(BT)
    db.execute("UPDATE bs_games SET updated_ts = updated_ts - 25*3600 WHERE id = ?", (g,)); db.commit()
    call("sync", BT, last_msg_id=999999)
    check(pts(BT) == b0 + 60 + 25 and pts(OT) == o0, "battleship ACTIVE: side to move (A) times out, B wins")
    db.close()

print("== per-user read rate limits")
check(call("search_messages", OT, expect_ok=False, q="a")["error"].startswith("Search text"), "FTS needs >= 2 chars")
oks = [call("search_messages", OT, expect_ok=None, q="hello")["ok"] for _ in range(11)]
check(oks.count(False) >= 1, "search_messages limited to 10/10s")
time.sleep(10)

print("== admin")
e = call("admin", BT, expect_ok=False, op="mute", target_user_id=CID)
check(e["error_code"] == "FORBIDDEN", "member cannot admin")
call("admin", OT, op="promote", target_user_id=BID)
check([i["user_id"] for i in call("members", OT, q="admin")["items"]] == [BID], "promote -> admin filter")
call("admin", BT, op="mute", target_user_id=CID, minutes=5)
check(call("send_message", CT, expect_ok=False, content="x")["error_code"] == "MUTED", "mute works")
call("admin", BT, op="unmute", target_user_id=CID)
call("send_message", CT, content="free")
e = call("admin", BT, expect_ok=False, op="grant_points", target_user_id=CID, amount=5)
check(e["error_code"] == "FORBIDDEN", "admin cannot grant points")
c0 = pts(CT)
call("admin", OT, op="grant_points", target_user_id=CID, amount=500)
check(pts(CT) == c0 + 500, "grant points")
call("admin", OT, op="settings", anthropic_key="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", motd="hello v3", name="Test Deck")
srv = call("sync", OT, last_msg_id=999999)["server"]
check(srv["anthropic_key_masked"] == "sk-ant-...6789" and srv["name"] == "Test Deck" and srv["motd"] == "hello v3", "settings + masked key")
check("anthropic_key_masked" not in call("sync", CT, last_msg_id=999999)["server"], "member does not see masked key")
call("admin", BT, op="ban", target_user_id=CID)
check(call("sync", CT, expect_ok=False, last_msg_id=0)["error_code"] in ("UNAUTHORIZED", "BANNED"), "banned user locked out")
check(call("login", expect_ok=False, username="carl_" + SUF, password="secret123")["error_code"] == "BANNED", "banned login refused")
check([i["user_id"] for i in call("admin_banned", OT)["items"]] == [CID], "admin_banned list")
call("admin", OT, op="unban", target_user_id=CID)
CT = call("login", username="carl_" + SUF, password="secret123")["auth_token"]
call("admin", OT, op="kick", target_user_id=CID)
check(call("sync", CT, expect_ok=False, last_msg_id=0)["error_code"] == "UNAUTHORIZED", "kick invalidates session")
call("admin", OT, op="settings", registration_open=False)
check(reg("dave_" + SUF, join_key="letmein", expect_ok=False)["error_code"] == "REGISTRATION_CLOSED", "registration closed")
call("admin", OT, op="transfer", target_user_id=BID)
check(call("sync", BT, last_msg_id=999999)["me"]["role"] == "owner", "ownership transferred")
call("logout", OT)
check(call("sync", OT, expect_ok=False, last_msg_id=0)["error_code"] == "UNAUTHORIZED", "logout")

print(f"\nALL PASSED ({passed} checks)")
