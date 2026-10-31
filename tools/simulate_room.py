"""Demo traffic for a local server: eight fake members chat, commit, play the arcade and chess.

    python tools/simulate_room.py [api_url] [join_key]

For local development only; never point it at a real community.
Note: the server allows 12 logins per 5 minutes per IP, and all bots share yours.
"""
import argparse
import hashlib
import json
import random
import time
import urllib.error
import urllib.request

API = 'http://127.0.0.1:8090/api.php'
JOIN_KEY = ''
PASSWORD = 'Test12345!'

BOTS = [
    ('byte-wrangler', '#6EA8FE', 'shipping microservices one yak at a time'),
    ('null-ptr-nina', '#B07CFF', 'segfaults are just spicy features'),
    ('rustacean-kai', '#E9A23B', 'fearless concurrency, fearful deadlines'),
    ('devops-dana', '#52B788', 'it works on my cluster'),
    ('pixelpush3r', '#FF6B6B', 'css is a contact sport'),
    ('monorepo-max', '#D97757', 'one repo to rule them all'),
    ('lgtm-lena', '#4FD1C5', 'approved without reading (jk)'),
    ('async-arturo', '#F39C7F', 'await coffee;'),
]
PROJECTS = [('odoo-connector', 'Odoo order sync'), ('mobile-app', 'Refactoring app navigation'), ('infra-k8s', 'Kubernetes cluster migration'),
            ('landing-v3', 'Landing page redesign'), ('api-gateway', 'API gateway rate limiting'), ('data-pipeline', 'Nightly ETL optimization')]
BRANCHES = ['main', 'develop', 'feat/auth', 'fix/race-cond', 'staging', 'feat/payments']
CHAT = ['anyone else getting flaky CI today?', 'pushed the hotfix, pls review 🙏', 'claude just refactored 400 lines in one go lol',
        'coffee break ☕', 'who broke staging? 👀', 'merging in 5', 'lgtm', 'context window at 90%, starting a fresh session',
        '@claude how do I debounce a websocket reconnect?', 'friday showdown is mine this week 💪', 'rollback done, all green now',
        'pair on the migration later?', 'tests pass locally ¯\\_(ツ)_/¯', 'shipping 🚀']
COMMIT_MSGS = ['fix: null check in order sync', 'feat: add retry with backoff', 'refactor: split service layer', 'chore: bump deps',
               'test: cover edge cases', 'perf: cache tenant lookups', 'docs: update README', 'fix: race in session refresh']


def call(action, token=None, **payload):
    body = json.dumps({'action': action, **payload}).encode()
    req = urllib.request.Request(API, body, {'Content-Type': 'application/json', **({'X-Deck-Token': token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b'{}')
        except ValueError:
            return {}
    except (ValueError, OSError):
        return {}


def derive(username, password=None):
    """Same PBKDF2 derivation as src/lib/password.js — servers never see plaintext passwords."""
    salt = f"cyberdeck/v1|{API.lower()}|{username.strip().lower()}".encode()
    return hashlib.pbkdf2_hmac('sha256', (password or PASSWORD).encode(), salt, 200000).hex()


def random_fleet():
    while True:
        taken, ships = set(), []
        for ln in (5, 4, 3, 3, 2):
            for _ in range(200):
                d = random.choice('hv')
                x = random.randrange(10 - ln + 1 if d == 'h' else 10)
                y = random.randrange(10 - ln + 1 if d == 'v' else 10)
                cells = {(x + i, y) if d == 'h' else (x, y + i) for i in range(ln)}
                if not cells & taken:
                    taken |= cells
                    ships.append({'x': x, 'y': y, 'len': ln, 'dir': d})
                    break
        if len(ships) == 5:
            return ships


class Bot:
    def __init__(self, nick, color, bio):
        self.nick = nick
        call('register', username=nick, password=derive(nick), password_confirm=derive(nick), join_key=JOIN_KEY)
        self.token = call('login', username=nick, password=derive(nick)).get('auth_token')
        call('update_profile', self.token, display_nick=nick, avatar_color=color, bio=bio, usage_hidden=(nick == 'lgtm-lena'))
        self.project, self.task = random.choice(PROJECTS)
        self.branch = random.choice(BRANCHES)
        self.ctx, self.s, self.w = random.randint(5, 60), random.randint(3, 50), random.randint(20, 80)
        self.day, self.week = random.randint(0, 6), random.randint(6, 40)
        self.last_msg = 0
        self.online = True
        self.uid = None

    def sync(self, new_commits=()):
        status = random.choice(['WORKING', 'WORKING', 'IDLE', 'WORKING']) if self.ctx < 90 else 'OVERHEAT'
        r = call('sync', self.token, last_msg_id=self.last_msg, new_commits=list(new_commits), telemetry={
            'status': status, 'is_sleeping': not self.online, 'ctx_pct': self.ctx,
            'focus': {'project': self.project, 'branch': self.branch, 'task': self.task},
            'commits': {'day': self.day, 'week': self.week},
            'usage': {'s': self.s, 'w': self.w, 'reset_s': 'in 3h', 'reset_w': 'Mon 9am', 'ts': int(time.time())}})
        if r.get('error_code') in ('UNAUTHORIZED', None) and not r.get('ok'):
            self.token = call('login', username=self.nick, password=derive(self.nick)).get('auth_token')
            return {}
        if r.get('ok'):
            self.uid = r['me'].get('user_id') or r['me'].get('id')
            if r.get('new_messages'):
                self.last_msg = max(int(m['id']) for m in r['new_messages'])
        return r

    def tick(self, room_state):
        # drift telemetry like a real Claude session
        self.ctx = min(100, self.ctx + random.randint(0, 6)) if random.random() < .9 else random.randint(3, 15)
        self.s = min(100, self.s + random.choice([0, 0, 1, 2]))
        self.w = min(100, self.w + (1 if random.random() < .15 else 0))
        commits = []
        if random.random() < .12:
            self.day += 1
            self.week += 1
            commits.append({'project': self.project, 'branch': self.branch, 'short_hash': '%07x' % random.getrandbits(28),
                            'message': random.choice(COMMIT_MSGS), 'timestamp': time.strftime('%H:%M')})
        if random.random() < .04:
            self.project, self.task = random.choice(PROJECTS)
        r = self.sync(commits)
        for g in r.get('battleship') or []:
            if g['status'] == 'INVITED' and not g.get('is_inviter') and random.random() < .5:
                call('bs_accept', self.token, game_id=g['id'])
            elif g['status'] == 'PLACING' and not g.get('i_am_ready'):
                call('bs_place', self.token, game_id=g['id'], ships=random_fleet())
            elif g['status'] == 'ACTIVE' and g.get('my_turn'):
                shot = {(x, y) for x, y, _ in g.get('my_shots') or []}
                free = [(x, y) for x in range(10) for y in range(10) if (x, y) not in shot]
                if free:
                    x, y = random.choice(free)
                    call('bs_fire', self.token, game_id=g['id'], x=x, y=y)
        roll = random.random()
        msgs = r.get('new_messages') or []
        if roll < .10:
            human = [m for m in msgs if int(m.get('user_id', 0)) > 0 and m.get('sender_nick') != self.nick]
            reply = random.choice(human) if human and random.random() < .5 else None
            text = random.choice(CHAT)
            if random.random() < .25 and room_state['nicks']:
                text = f"@{random.choice(room_state['nicks'])} {text}"
            call('send_message', self.token, content=text, reply_to=int(reply['id']) if reply else 0)
        elif roll < .16:
            call('game_spin', self.token, kind=random.choice(['roulette', 'case']), bet=random.choice([20, 50, 100, 250]),
                 choice=random.choice(['red', 'black', 'red', 'green']))
        elif roll < .19:
            open_duels = [d for d in r.get('duels', []) if d['status'] == 'OPEN' and self.uid not in [p['id'] for p in d['players']]]
            if open_duels:
                call('duel_join', self.token, duel_id=open_duels[0]['id'])
            else:
                call('duel_create', self.token, stake=random.choice([25, 50, 100]), max_players=random.choice([2, 2, 3]))
        elif roll < .225:
            other = random.choice([b for b in room_state['bots'] if b is not self])
            call('bs_invite', self.token, target_nick=other.nick, stake=random.choice([0, 25, 50]))
        elif roll < .21:
            other = random.choice([b for b in room_state['bots'] if b is not self])
            call('chess_invite', self.token, target_nick=other.nick, stake=random.choice([0, 50, 100]))
            room_state['chess'].append((self, other, time.time()))


def main():
    bots = [Bot(*b) for b in BOTS]
    state = {'bots': bots, 'nicks': [b.nick for b in bots] + ['tester'], 'chess': []}
    print(f'{len(bots)} bots online on {API}', flush=True)
    while True:
        for b in bots:
            if random.random() < .01:
                b.online = not b.online
            b.tick(state)
            time.sleep(0.4)
        # bot chess: accept invites, later someone resigns
        for item in list(state['chess']):
            white, black, t0 = item[:3]
            if time.time() - t0 > 8 and len(item) == 3:
                call('chess_accept', black.token, challenger_nick=white.nick)
                state['chess'].remove(item)
                state['chess'].append((white, black, time.time(), 'active'))
            elif len(item) == 4 and time.time() - t0 > 40:
                loser = random.choice([white, black])
                games = loser.sync().get('chess') or []
                for g in games:
                    if g['status'] == 'ACTIVE':
                        call('chess_move', loser.token, game_id=g['id'], resign=True)
                state['chess'].remove(item)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('api_url', nargs='?', default=API)
    parser.add_argument('join_key', nargs='?', default=JOIN_KEY)
    args = parser.parse_args()
    API, JOIN_KEY = args.api_url, args.join_key
    main()
