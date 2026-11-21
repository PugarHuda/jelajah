# Narration for the film: one line per scene, synthesized with edge-tts (a synthetic voice, disclosed in the BUIDL).
#   python vo.py  -> public/vo/<scene>.mp3
import asyncio, edge_tts
VOICE = 'en-US-BrianNeural'
LINES = {
  'intro':    ('Jelajah. A stamp rally on Bitcoin Cash.', '+0%'),
  'problem':  ('Paper stamp cards are easy to fake, and the prize is only a promise.', '+5%'),
  'home':     ('With Jelajah, you pay a street food stall in Jogja, and its stamp NFT is printed in the very same transaction. Live on mainnet.', '+0%'),
  'story':    ("Collect stamps from three different stalls. Burn the set, and the rally's contract pays you back, and mints a trophy that works as your member card.", '+0%'),
  'levy':     ("What if stalls collude? Every stamp pays a levy into the pool, so each set's own levies pay its reward.", '+8%'),
  'till':     ('For the stall, the till rings the moment a stamp is paid. This one is a real sale.', '+5%'),
  'stats':    ('Every number is recomputed from the chain. Nothing to fake.', '+0%'),
  'organize': ('And anyone can open their own rally, right from the browser.', '+0%'),
  'proof':    ('All of it runs on Bitcoin Cash mainnet. Built solo, from Jogja, in eight days.', '+0%'),
  'outro':    ('Jelajah. Eat, collect, get rewarded.', '+0%'),
}
async def main():
    for k, (text, rate) in LINES.items():
        await edge_tts.Communicate(text, VOICE, rate=rate).save(f'public/vo/{k}.mp3')
asyncio.run(main())
