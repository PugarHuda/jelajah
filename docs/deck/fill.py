# Fill the BCH BLAZE "Widget Factory" template with Jelajah's content, keeping the template's styling.
import copy, sys
from pptx import Presentation

src, out = sys.argv[1], sys.argv[2]
p = Presentation(src)

def set_lines(shape, lines, flat=False):
    tf = shape.text_frame
    paras = list(tf.paragraphs)
    styled = [q for q in paras if q.runs] or paras
    while len(paras) < len(lines):  # clone the last styled paragraph for extra lines
        el = copy.deepcopy(styled[-1]._p)
        paras[-1]._p.addnext(el)
        paras = list(tf.paragraphs)
    for q, line in zip(paras, lines):
        runs = q.runs
        if not runs:
            if line:
                ref = next((r for r in (styled[0].runs or [])), None)
                r = q.add_run()
                if ref is not None:
                    r._r.insert(0, copy.deepcopy(ref._r.find('{http://schemas.openxmlformats.org/drawingml/2006/main}rPr'))) if ref._r.find('{http://schemas.openxmlformats.org/drawingml/2006/main}rPr') is not None else None
                r.text = line
            continue
        runs[0].text = line
        for extra in runs[1:]:
            extra._r.getparent().remove(extra._r)
    for q in paras[len(lines):]:
        q._p.getparent().remove(q._p)
    if flat:  # every bullet takes the first paragraph's indent and bullet style
        ns = '{http://schemas.openxmlformats.org/drawingml/2006/main}pPr'
        first = tf.paragraphs[0]._p.find(ns)
        for q in tf.paragraphs[1:]:
            cur = q._p.find(ns)
            if cur is not None:
                q._p.remove(cur)
            if first is not None:
                q._p.insert(0, copy.deepcopy(first))

from PIL import Image
def swap_picture(slide_idx, shape_id, path):
    slide = p.slides[slide_idx]
    old = next(sh for sh in slide.shapes if sh.shape_id == shape_id)
    w, h = Image.open(path).size
    scale = min(old.width / w, old.height / h)
    nw, nh = int(w * scale), int(h * scale)
    pic = slide.shapes.add_picture(path, old.left + (old.width - nw) // 2, old.top + (old.height - nh) // 2, nw, nh)
    old._element.addprevious(pic._element)  # keep z-order
    old._element.getparent().remove(old._element)

S = {sh.shape_id: sh for s in p.slides for sh in s.shapes}
URL = 'jelajah-bch.vercel.app'

# 1 — title
set_lines(S[58], ['Jelajah'])
set_lines(S[60], ['Live demo'])
S[60].text_frame.paragraphs[0].runs[0].hyperlink.address = 'https://' + URL + '/'
set_lines(S[61], ['pugarhuda'])
set_lines(S[62], ['BangDropID'])
S[62].text_frame.paragraphs[0].runs[0].hyperlink.address = 'https://x.com/BangDropID'
set_lines(S[70], ['Solo builder: Pugar (Bangdrop), Yogyakarta'])

# 2 — one-liner + repo
set_lines(S[78], [
    'Jelajah!', '',
    'A stamp rally on Bitcoin Cash: pay a stall, get its stamp NFT in the same tx', '',
    'https://github.com/PugarHuda/jelajah',
])

# 3 — story
set_lines(S[87], ['Jelajah'])
set_lines(S[88], [URL])
set_lines(S[95], ['The Story of Jelajah'])
set_lines(S[93], [
    'In Jogja every food festival runs a stamp card: eat at five stalls, get a prize. The cards are paper, easy to fake, and the prize depends on the organiser keeping their word.',
    '',
    'Small stalls still have no cheap way to win new customers, and crypto users have no everyday reason to spend. So we made every stamp proof of a real, paid visit, and locked the prize in a contract.',
])

# 4 — benefits
set_lines(S[107], ['', 'Benefits of Jelajah'])
set_lines(S[108], [
    'One scan: pay + stamp NFT, same tx',
    'Colluding stalls can\'t drain the pool',
    'Trophy = membership card, on chain',
    'A till that rings on every paid stamp',
    'No sign-up, no server, ID/EN',
], flat=True)

# 5 — BCH usage
set_lines(S[116], [
    'BCH Usage', '',
    "A stall's covenant releases its stamp only if the stall got paid, and every stamp pays a levy into the pool. The vault loops over your stamps, pays you from those levies, mints a trophy.",
])

# 6 — vision
set_lines(S[126], ['', 'The Vision for Jelajah'])
set_lines(S[127], [
    'Now: levy rally live on BCH mainnet',
    'XO, FoldingCash, SolidCash, ID: on mainnet',
    'Next: festivals, malls, BLISS 2027',
    'Organisers earn the levy surplus',
], flat=True)

A = sys.argv[3]
swap_picture(0, 71, A + '/art.png')
swap_picture(2, 98, A + '/board-levy.png')  # the live levy rally, 21 Nov
swap_picture(4, 117, A + '/selene-sign.png')
p.save(out)
print('saved', out)
